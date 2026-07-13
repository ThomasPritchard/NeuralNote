//! Schemas and dispatch bodies for progressively disclosed skill capabilities.

use crate::ai::elicitation::{elicit_user, ElicitationOutcome};
use crate::ai::events::{ChatEvent, ElicitOption, Elicitation};
use crate::ai::llm::UserPrompt;
use crate::ai::orchestrator::SKILL_ACTIVATION_FAILURE_MARK;
use crate::ai::skills::YOUTUBE_DISTIL_SKILL_ID;
use crate::ai::tools::{
    action, function_tool, reject, reject_and_complete, ToolContext, ToolControl, ToolOutcome,
    ToolResult, TOOL_ASK_USER, TOOL_SKILL_STEP, TOOL_USE_SKILL, TOOL_WRITE_NOTE,
};
use crate::ai::write_policy::{write_note_policy, NoteKind, WriteOutcome};
use serde::Deserialize;
use serde_json::{json, Value};

const MISSING_YTDLP_ACTIVATION_ERROR: &str = "skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory";

pub(super) fn use_skill_schema() -> Value {
    function_tool(
        TOOL_USE_SKILL,
        "Activate one enabled skill by stable id. Returns its full instruction markdown and grants its declared tools on the next turn.",
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Stable skill id from the system catalogue." }
            },
            "required": ["id"],
            "additionalProperties": false
        }),
    )
}

pub(super) fn active_schemas() -> [(&'static str, Value); 3] {
    [
        (TOOL_SKILL_STEP, skill_step_schema()),
        (TOOL_ASK_USER, ask_user_schema()),
        (TOOL_WRITE_NOTE, write_note_schema()),
    ]
}

fn skill_step_schema() -> Value {
    function_tool(
        TOOL_SKILL_STEP,
        "Emit a short user-facing progress update for the active skill.",
        json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "Short present-tense progress message." }
            },
            "required": ["message"],
            "additionalProperties": false
        }),
    )
}

fn ask_user_schema() -> Value {
    function_tool(
        TOOL_ASK_USER,
        "Ask the user to choose from model-authored structured options.",
        json!({
            "type": "object",
            "properties": {
                "question": { "type": "string" },
                "options": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "label": { "type": "string" },
                            "description": { "type": ["string", "null"] }
                        },
                        "required": ["id", "label"],
                        "additionalProperties": false
                    }
                },
                "multi_select": { "type": "boolean", "default": false }
            },
            "required": ["question", "options"],
            "additionalProperties": false
        }),
    )
}

fn write_note_schema() -> Value {
    function_tool(
        TOOL_WRITE_NOTE,
        "Create one vault-confined markdown note. Never overwrites; returns the actual collision-safe path.",
        json!({
            "type": "object",
            "properties": {
                "rel_path": { "type": "string", "description": "Vault-relative .md path." },
                "content": { "type": "string" },
                "kind": { "type": "string", "enum": ["literature", "atomic", "transcript"] },
                "work_item": { "type": "integer", "minimum": 0, "default": 0 }
            },
            "required": ["rel_path", "content", "kind"],
            "additionalProperties": false
        }),
    )
}

#[derive(Deserialize)]
struct UseSkillArgs {
    id: String,
}

fn needs_missing_ytdlp_recovery(id: &str, error: &str) -> bool {
    id == YOUTUBE_DISTIL_SKILL_ID && error == MISSING_YTDLP_ACTIVATION_ERROR
}

pub(super) fn dispatch_use_skill(args_json: &str, context: &mut ToolContext<'_>) -> ToolResult {
    let args: UseSkillArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid use_skill arguments: {error}")),
    };
    let activation =
        match context
            .active_skills
            .activate(&args.id, context.skills, context.environment)
        {
            Ok(activation) => activation,
            Err(error) => {
                context.sink.send(ChatEvent::SkillStep {
                    message: format!(
                    "Skill '{}' {SKILL_ACTIVATION_FAILURE_MARK}: {error} — continuing without it",
                        args.id
                    ),
                });
                return if needs_missing_ytdlp_recovery(&args.id, &error) {
                    reject_and_complete(error)
                } else {
                    reject(error)
                };
            }
        };
    if activation.newly_activated {
        context.sink.send(ChatEvent::SkillActivated {
            id: activation.manifest.id.clone(),
            name: activation.manifest.name.clone(),
        });
    }
    action(activation.manifest.instructions)
}

#[derive(Deserialize)]
struct SkillStepArgs {
    message: String,
}

pub(super) fn dispatch_skill_step(args_json: &str, context: &mut ToolContext<'_>) -> ToolResult {
    let args: SkillStepArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid skill_step arguments: {error}")),
    };
    if args.message.trim().is_empty() {
        return reject("skill_step message cannot be empty".into());
    }
    context.sink.send(ChatEvent::SkillStep {
        message: args.message,
    });
    action(json!({ "ok": true }).to_string())
}

#[derive(Deserialize)]
struct AskUserArgs {
    question: String,
    options: Vec<ElicitOption>,
    #[serde(default)]
    multi_select: bool,
}

pub(super) async fn dispatch_ask_user(
    call_id: &str,
    args_json: &str,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: AskUserArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid ask_user arguments: {error}")),
    };
    if args.question.trim().is_empty() || args.options.is_empty() {
        return reject("ask_user requires a question and at least one option".into());
    }
    for option in &args.options {
        if option.image_data_uri.is_some() {
            return reject(format!(
                "ask_user option '{}' includes image_data_uri; model-authored images are not allowed",
                option.id
            ));
        }
    }
    let elicitation = Elicitation {
        id: call_id.to_string(),
        question: args.question,
        options: args.options,
        multi_select: args.multi_select,
    };
    let outcome = elicit_user(user_prompt, context.sink, elicitation).await;
    let content = outcome.tool_result_content();
    match outcome {
        ElicitationOutcome::Answered { .. } => action(content),
        ElicitationOutcome::Rejected { .. } => ToolResult {
            content,
            outcome: ToolOutcome::Rejected,
            control: ToolControl::Continue,
        },
    }
}

#[derive(Deserialize)]
struct WriteNoteArgs {
    rel_path: String,
    content: String,
    kind: NoteKind,
    #[serde(default)]
    work_item: usize,
}

pub(super) fn dispatch_write_note(args_json: &str, context: &mut ToolContext<'_>) -> ToolResult {
    let args: WriteNoteArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid write_note arguments: {error}")),
    };
    if let Some(session) = context.youtube_session.as_deref() {
        if let Err(error) = session.validate_playlist_work_item(args.work_item) {
            return reject(format!("write_note failed: {error}"));
        }
    }
    match write_note_policy(
        context.vault_root,
        &args.rel_path,
        &args.content,
        args.kind,
        args.work_item,
        context.note_writer,
        context.writes,
    ) {
        Ok(WriteOutcome::Created {
            rel_path,
            written_kind,
            ..
        }) => {
            if let Some(session) = context.youtube_session.as_deref_mut() {
                session.record_playlist_write(args.work_item, args.kind);
            }
            context.sink.send(ChatEvent::NoteWritten {
                rel_path: rel_path.clone(),
                kind: written_kind,
            });
            action(json!({ "existed": false, "rel_path": rel_path }).to_string())
        }
        Ok(WriteOutcome::Existing { rel_path }) => {
            if let Some(session) = context.youtube_session.as_deref_mut() {
                session.record_playlist_write(args.work_item, args.kind);
            }
            action(json!({ "existed": true, "rel_path": rel_path }).to_string())
        }
        Err(error) => reject(format!("write_note failed: {error}")),
    }
}
