//! The tools exposed to the model, and the dispatcher that runs them.
//!
//! Four read-only vault tools plus `use_skill` are always available. Active skills
//! progressively grant their declared action tools. Schemas are OpenAI-compatible
//! `serde_json::Value`s; tool argument property names are `snake_case` because this
//! is the model-facing contract, not the frontend camelCase contract.
//!
//! [`dispatch`] is total: a bad tool name or malformed arguments become an error
//! *tool result* the model reads and recovers from, never a hard failure — an
//! agentic loop must tolerate the model asking for something impossible.

use crate::ai::events::EventSink;
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::UserPrompt;
use crate::ai::retrieval::RetrievalProvider;
use crate::ai::skill_tools;
use crate::ai::skills::{ActiveSkills, SkillEnvironment, SkillRegistry};
use crate::ai::write_policy::{NoteWriteBackend, WriteSession};
use crate::ai::youtube::{YoutubeIo, YoutubeToolSession, UNAVAILABLE_YOUTUBE_IO};
use crate::ai::youtube_tools;
use crate::capture::{PricingInput, UnavailableVaultProfileIo, VaultProfileIo};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub const TOOL_LIST_NOTES: &str = "list_notes";
pub const TOOL_LIST_FOLDERS: &str = "list_folders";
pub const TOOL_SEARCH_NOTES: &str = "search_notes";
pub const TOOL_READ_NOTE_SPAN: &str = "read_note_span";
pub const TOOL_USE_SKILL: &str = "use_skill";
pub const TOOL_SKILL_STEP: &str = "skill_step";
pub const TOOL_ASK_USER: &str = "ask_user";
pub const TOOL_WRITE_NOTE: &str = "write_note";
pub const TOOL_FETCH_VIDEO_INFO: &str = "fetch_video_info";
pub const TOOL_FETCH_CAPTIONS: &str = "fetch_captions";
pub const TOOL_TRANSCRIBE_AUDIO: &str = "transcribe_audio";
pub const TOOL_SELECT_PLAYLIST_VIDEOS: &str = "select_playlist_videos";
pub const TOOL_RESOLVE_DISTIL_ROUTE: &str = "resolve_distil_route";

static UNAVAILABLE_VAULT_PROFILE_IO: UnavailableVaultProfileIo = UnavailableVaultProfileIo;

// Evidence spans returned when the model doesn't specify `max_results`. A common
// term matches far more than this, so a search often clips — but that is `capped`
// (routine), not a coverage gap (see SearchOutcome). Raised from 8 → 12 for richer
// evidence per search; the orchestrator's `max_spans` guard is bumped in lockstep so
// the higher per-search yield doesn't starve query diversity.
const DEFAULT_SEARCH_RESULTS: usize = 12;
const MAX_SEARCH_RESULTS: usize = 20;
const DEFAULT_READ_MAX_BYTES: usize = 2000;
const MAX_READ_MAX_BYTES: usize = 8000;

/// What a dispatched tool did, for the orchestrator to emit events and accumulate
/// the coverage footer. (The model-facing payload is [`ToolResult::content`].)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOutcome {
    /// `list_notes` ran (metadata only — no user-facing event).
    Listed,
    /// `search_notes` ran: the query, how many spans it yielded, coverage flags,
    /// and the distinct notes touched.
    Searched {
        query: String,
        hit_count: u32,
        truncated: bool,
        skipped_files: u32,
        notes_read: Vec<String>,
    },
    /// `read_note_span` ran over this range.
    Read {
        rel_path: String,
        start_line: u32,
        end_line: u32,
    },
    /// A skill action completed and emitted its own structured event if needed.
    Action,
    /// The call was rejected (bad name/args/path). The detail is in the content the
    /// model reads; the orchestrator emits no event for it.
    Rejected,
}

/// Internal orchestration control carried alongside a normal tool result.
/// `CompleteTurn` still requires the caller to append the result message before
/// ending the run, preserving one result for every tool call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum ToolControl {
    #[default]
    Continue,
    CompleteTurn,
}

/// The outcome of one tool call: the JSON string for the `role:"tool"` message, and
/// a structured [`ToolOutcome`] for the orchestrator.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub content: String,
    pub outcome: ToolOutcome,
    pub(super) control: ToolControl,
}

/// Mutable per-run collaborators required by skill tools. Retrieval and
/// `UserPrompt` stay explicit dispatch parameters to preserve their existing seams.
pub struct ToolContext<'a> {
    pub(super) vault_root: &'a Path,
    pub(super) skills: &'a SkillRegistry,
    pub(super) environment: &'a SkillEnvironment,
    pub(super) active_skills: &'a mut ActiveSkills,
    pub(super) note_writer: &'a dyn NoteWriteBackend,
    pub(super) writes: &'a mut WriteSession,
    pub(super) sink: &'a mut dyn EventSink,
    pub(super) youtube_io: &'a dyn YoutubeIo,
    pub(super) youtube_requirements: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    pub(super) youtube_session: Option<&'a mut YoutubeToolSession>,
    pub(super) vault_profile_io: &'a dyn VaultProfileIo,
    pub(super) pricing: Option<&'a PricingInput>,
    authorized_tools: &'a BTreeSet<String>,
}

impl<'a> ToolContext<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        vault_root: &'a Path,
        skills: &'a SkillRegistry,
        environment: &'a SkillEnvironment,
        active_skills: &'a mut ActiveSkills,
        note_writer: &'a dyn NoteWriteBackend,
        writes: &'a mut WriteSession,
        sink: &'a mut dyn EventSink,
        authorized_tools: &'a BTreeSet<String>,
    ) -> Self {
        Self {
            vault_root,
            skills,
            environment,
            active_skills,
            note_writer,
            writes,
            sink,
            youtube_io: &UNAVAILABLE_YOUTUBE_IO,
            youtube_requirements: &crate::ai::youtube::UNAVAILABLE_YOUTUBE_REQUIREMENT_INSTALLER,
            youtube_session: None,
            vault_profile_io: &UNAVAILABLE_VAULT_PROFILE_IO,
            pricing: None,
            authorized_tools,
        }
    }

    /// Opt into the host YouTube seam for this run. Existing clients keep the
    /// explicit unavailable implementation until Phase 5 shell wiring lands.
    pub fn with_youtube(
        mut self,
        youtube_io: &'a dyn YoutubeIo,
        youtube_session: &'a mut YoutubeToolSession,
    ) -> Self {
        self.youtube_io = youtube_io;
        self.youtube_session = Some(youtube_session);
        self
    }

    pub fn with_youtube_requirements(
        mut self,
        installer: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    ) -> Self {
        self.youtube_requirements = installer;
        self
    }

    pub fn with_vault_profile_io(mut self, profile_io: &'a dyn VaultProfileIo) -> Self {
        self.vault_profile_io = profile_io;
        self
    }

    pub fn with_pricing(mut self, pricing: &'a PricingInput) -> Self {
        self.pricing = Some(pricing);
        self
    }
}

/// The tool schemas to advertise to the model (OpenAI `tools` array shape).
pub fn tool_schemas(active_skill_tools: &BTreeSet<String>) -> Vec<Value> {
    let mut schemas = vec![
        list_notes_schema(),
        list_folders_schema(),
        search_notes_schema(),
        read_note_span_schema(),
        skill_tools::use_skill_schema(),
    ];
    for (name, schema) in skill_tools::active_schemas() {
        if active_skill_tools.contains(name) {
            schemas.push(schema);
        }
    }
    for (name, schema) in crate::ai::youtube_tool_schemas::active_schemas() {
        if active_skill_tools.contains(name) {
            schemas.push(schema);
        }
    }
    schemas
}

/// Names represented by an advertised schema snapshot.
pub fn advertised_tool_names(schemas: &[Value]) -> BTreeSet<String> {
    schemas
        .iter()
        .filter_map(|schema| schema["function"]["name"].as_str().map(str::to_string))
        .collect()
}

pub(super) fn function_tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    })
}

fn list_notes_schema() -> Value {
    function_tool(
        TOOL_LIST_NOTES,
        "List notes (title and relative path only, no content). Pass `folder` to list \
         only the notes inside that folder and its subfolders; omit it to list the \
         whole vault. Use it to discover what exists before searching.",
        json!({
            "type": "object",
            "properties": {
                "folder": {
                    "type": "string",
                    "description": "Optional vault-relative folder to scope the listing to."
                }
            },
            "additionalProperties": false
        }),
    )
}

fn list_folders_schema() -> Value {
    function_tool(
        TOOL_LIST_FOLDERS,
        "List every folder in the vault, each with its vault-relative path and how many \
         notes it holds (counted recursively). Use it to discover how the vault is \
         organised before scoping a search or listing to a folder.",
        json!({ "type": "object", "properties": {}, "additionalProperties": false }),
    )
}

fn search_notes_schema() -> Value {
    function_tool(
        TOOL_SEARCH_NOTES,
        "Keyword-search the vault. Returns evidence spans, each with an `id` you must \
         cite (e.g. [e1]). Search is literal — vary wording, synonyms, and tags across \
         several searches. Pass `folder` to search only within a folder and its \
         subfolders; omit it to search the whole vault.",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "The keyword query." },
                "max_results": {
                    "type": "integer",
                    // Interpolated from the constant so the schema can't drift from the
                    // real default again (it previously still said "default 8").
                    "description": format!("Maximum evidence spans to return (default {DEFAULT_SEARCH_RESULTS})."),
                    "minimum": 1,
                    "maximum": MAX_SEARCH_RESULTS
                },
                "folder": {
                    "type": "string",
                    "description": "Optional vault-relative folder to scope the search to (includes subfolders)."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        }),
    )
}

fn read_note_span_schema() -> Value {
    function_tool(
        TOOL_READ_NOTE_SPAN,
        "Read a bounded line range of one note for more context around a search hit. \
         Returns an evidence span with an `id` you must cite.",
        json!({
            "type": "object",
            "properties": {
                "rel_path": { "type": "string", "description": "Vault-relative path of the note." },
                "start_line": { "type": "integer", "description": "1-based first line.", "minimum": 1 },
                "end_line": { "type": "integer", "description": "1-based last line (inclusive).", "minimum": 1 },
                "max_bytes": { "type": "integer", "description": "Byte cap on the returned text." }
            },
            "required": ["rel_path", "start_line", "end_line"],
            "additionalProperties": false
        }),
    )
}

/// Run the named tool. Spans it produces are registered (assigning citable ids) so
/// the ids appear in the model-facing JSON and the verifier can find them later.
pub async fn dispatch(
    call_id: &str,
    name: &str,
    args_json: &str,
    provider: &dyn RetrievalProvider,
    registry: &mut EvidenceRegistry,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    if !known_tool(name) {
        return reject(format!("unknown tool '{name}'"));
    }
    if !context.authorized_tools.contains(name) {
        return reject(format!(
            "tool '{name}' is not active; activate a skill that grants it first"
        ));
    }
    match name {
        TOOL_LIST_NOTES => dispatch_list(args_json, provider),
        TOOL_LIST_FOLDERS => dispatch_folders(provider),
        TOOL_SEARCH_NOTES => dispatch_search(args_json, provider, registry),
        TOOL_READ_NOTE_SPAN => dispatch_read(args_json, provider, registry),
        TOOL_USE_SKILL => skill_tools::dispatch_use_skill(args_json, context),
        TOOL_SKILL_STEP => skill_tools::dispatch_skill_step(args_json, context),
        TOOL_ASK_USER => {
            skill_tools::dispatch_ask_user(call_id, args_json, user_prompt, context).await
        }
        TOOL_WRITE_NOTE => skill_tools::dispatch_write_note(args_json, context),
        TOOL_FETCH_VIDEO_INFO => youtube_tools::dispatch_fetch_video_info(args_json, context).await,
        TOOL_FETCH_CAPTIONS => youtube_tools::dispatch_fetch_captions(args_json, context).await,
        TOOL_TRANSCRIBE_AUDIO => {
            youtube_tools::dispatch_transcribe_audio(call_id, args_json, user_prompt, context).await
        }
        TOOL_SELECT_PLAYLIST_VIDEOS => {
            crate::ai::youtube_selection::dispatch_select_playlist_videos(
                call_id,
                args_json,
                user_prompt,
                context,
            )
            .await
        }
        TOOL_RESOLVE_DISTIL_ROUTE => {
            crate::ai::youtube_route::dispatch_resolve_distil_route(
                call_id,
                args_json,
                provider,
                user_prompt,
                context,
            )
            .await
        }
        other => reject(format!("unknown tool '{other}'")),
    }
}

fn known_tool(name: &str) -> bool {
    matches!(
        name,
        TOOL_LIST_NOTES
            | TOOL_LIST_FOLDERS
            | TOOL_SEARCH_NOTES
            | TOOL_READ_NOTE_SPAN
            | TOOL_USE_SKILL
            | TOOL_SKILL_STEP
            | TOOL_ASK_USER
            | TOOL_WRITE_NOTE
            | TOOL_FETCH_VIDEO_INFO
            | TOOL_FETCH_CAPTIONS
            | TOOL_TRANSCRIBE_AUDIO
            | TOOL_SELECT_PLAYLIST_VIDEOS
            | TOOL_RESOLVE_DISTIL_ROUTE
    )
}

pub(super) fn reject(message: String) -> ToolResult {
    rejected_with_control(message, ToolControl::Continue)
}

pub(super) fn reject_and_complete(message: String) -> ToolResult {
    rejected_with_control(message, ToolControl::CompleteTurn)
}

fn rejected_with_control(message: String, control: ToolControl) -> ToolResult {
    ToolResult {
        content: json!({ "error": message }).to_string(),
        outcome: ToolOutcome::Rejected,
        control,
    }
}

pub(super) fn action(content: String) -> ToolResult {
    ToolResult {
        content,
        outcome: ToolOutcome::Action,
        control: ToolControl::Continue,
    }
}

#[derive(Deserialize, Default)]
struct ListArgs {
    #[serde(default)]
    folder: Option<String>,
}

fn dispatch_list(args_json: &str, provider: &dyn RetrievalProvider) -> ToolResult {
    // The folder arg is optional: a bare `{}` (or empty args) lists the whole vault,
    // but a genuinely malformed object is surfaced rather than silently un-scoped.
    let args: ListArgs = if args_json.trim().is_empty() {
        ListArgs::default()
    } else {
        match serde_json::from_str(args_json) {
            Ok(a) => a,
            Err(e) => return reject(format!("invalid list_notes arguments: {e}")),
        }
    };
    let outcome = match provider.list_notes(args.folder.as_deref()) {
        Ok(o) => o,
        Err(e) => return reject(format!("could not list notes: {e}")),
    };
    let listed: Vec<Value> = outcome
        .notes
        .iter()
        .map(|n| json!({ "title": n.title, "rel_path": n.rel_path }))
        .collect();
    ToolResult {
        // `skipped` tells the model discovery was partial; `truncated`/`total` tell it
        // the listing was capped to the first K of `total` in-scope notes — mirroring
        // search_notes' honesty so the model never assumes it saw the whole vault
        // (PA-002). Never a silent omission.
        content: json!({
            "notes": listed,
            "skipped": outcome.skipped,
            "truncated": outcome.truncated,
            "total": outcome.total,
        })
        .to_string(),
        outcome: ToolOutcome::Listed,
        control: ToolControl::Continue,
    }
}

fn dispatch_folders(provider: &dyn RetrievalProvider) -> ToolResult {
    let folders = match provider.list_folders() {
        Ok(f) => f,
        Err(e) => return reject(format!("could not list folders: {e}")),
    };
    let listed: Vec<Value> = folders
        .iter()
        .map(|f| json!({ "rel_path": f.rel_path, "note_count": f.note_count }))
        .collect();
    ToolResult {
        content: json!({ "folders": listed }).to_string(),
        outcome: ToolOutcome::Listed,
        control: ToolControl::Continue,
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default)]
    folder: Option<String>,
}

fn dispatch_search(
    args_json: &str,
    provider: &dyn RetrievalProvider,
    registry: &mut EvidenceRegistry,
) -> ToolResult {
    let args: SearchArgs = match serde_json::from_str(args_json) {
        Ok(a) => a,
        Err(e) => return reject(format!("invalid search_notes arguments: {e}")),
    };
    let max = args
        .max_results
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    let outcome = match provider.search_notes(&args.query, max, args.folder.as_deref()) {
        Ok(o) => o,
        Err(e) => return reject(format!("search failed: {e}")),
    };

    let mut evidence = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut notes_read = Vec::new();
    for span in outcome.spans {
        let rel = span.rel_path.clone();
        let id = registry.register(span);
        // Dedupe on id: when the registry collapses two identical spans to one id,
        // the model must see (and count) it once, not twice.
        if seen_ids.insert(id.clone()) {
            match registry.get(&id) {
                Some(s) => evidence.push(span_json(&id, s)),
                // Defensive parity with dispatch_read: a registration miss is
                // surfaced to the model, never a silent shrink of the evidence set.
                None => evidence.push(json!({ "id": id, "error": "span registration failed" })),
            }
        }
        if !notes_read.contains(&rel) {
            notes_read.push(rel);
        }
    }
    let hit_count = evidence.len() as u32;
    ToolResult {
        content: json!({
            "query": args.query,
            "evidence": evidence,
            // The model hears about EITHER cap, so it can refine or raise max_results…
            "truncated": outcome.truncated || outcome.capped
        })
        .to_string(),
        outcome: ToolOutcome::Searched {
            query: args.query,
            hit_count,
            // …but only a genuine vault-coverage gap drives the user-facing footer —
            // a routine per-call `max_results` clip must not report "partial coverage".
            truncated: outcome.truncated,
            skipped_files: outcome.skipped_files,
            notes_read,
        },
        control: ToolControl::Continue,
    }
}

#[derive(Deserialize)]
struct ReadArgs {
    rel_path: String,
    start_line: u32,
    end_line: u32,
    #[serde(default)]
    max_bytes: Option<usize>,
}

fn dispatch_read(
    args_json: &str,
    provider: &dyn RetrievalProvider,
    registry: &mut EvidenceRegistry,
) -> ToolResult {
    let args: ReadArgs = match serde_json::from_str(args_json) {
        Ok(a) => a,
        Err(e) => return reject(format!("invalid read_note_span arguments: {e}")),
    };
    let max = args
        .max_bytes
        .unwrap_or(DEFAULT_READ_MAX_BYTES)
        .clamp(1, MAX_READ_MAX_BYTES);
    let span = match provider.read_note_span(&args.rel_path, args.start_line, args.end_line, max) {
        Ok(s) => s,
        Err(e) => return reject(format!("could not read note span: {e}")),
    };
    let (rel_path, start_line, end_line) = (span.rel_path.clone(), span.start_line, span.end_line);
    let id = registry.register(span);
    let content = match registry.get(&id) {
        Some(s) => json!({ "evidence": span_json(&id, s) }).to_string(),
        None => json!({ "error": "span registration failed" }).to_string(),
    };
    ToolResult {
        content,
        outcome: ToolOutcome::Read {
            rel_path,
            start_line,
            end_line,
        },
        control: ToolControl::Continue,
    }
}

fn span_json(id: &str, span: &crate::ai::evidence::EvidenceSpan) -> Value {
    json!({
        "id": id,
        "rel_path": span.rel_path,
        "start_line": span.start_line,
        "end_line": span.end_line,
        "text": span.text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::events::VecSink;
    use crate::ai::evidence::EvidenceSpan;
    use crate::ai::llm::NoUserPrompt;
    use crate::ai::local::HardwareSpec;
    use crate::ai::retrieval::{FolderMeta, ListOutcome, NoteMeta, SearchOutcome};
    use crate::ai::skills::{ActiveSkills, SkillEnvironment, SkillRegistry};
    use crate::ai::write_policy::{UnavailableNoteWriter, WriteSession};
    use crate::error::{CoreError, CoreResult};
    use futures::executor::block_on;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    /// A fake provider that returns the SAME span twice — to prove dispatch_search
    /// dedupes the evidence list when the registry collapses them to one id.
    struct DupProvider;
    impl RetrievalProvider for DupProvider {
        fn list_notes(&self, _folder: Option<&str>) -> CoreResult<ListOutcome> {
            Ok(ListOutcome::default())
        }
        fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
            Ok(Vec::new())
        }
        fn search_notes(
            &self,
            _query: &str,
            _max: usize,
            _folder: Option<&str>,
        ) -> CoreResult<SearchOutcome> {
            let span = EvidenceSpan {
                id: String::new(),
                rel_path: "a.md".into(),
                content_hash: "h".into(),
                start_line: 3,
                end_line: 3,
                text: "dup".into(),
            };
            Ok(SearchOutcome {
                spans: vec![span.clone(), span],
                truncated: false,
                capped: false,
                skipped_files: 0,
            })
        }
        fn read_note_span(
            &self,
            _r: &str,
            _s: u32,
            _e: u32,
            _b: usize,
        ) -> CoreResult<EvidenceSpan> {
            Err(CoreError::NotFound("unused".into()))
        }
    }

    /// A fake provider whose `list_notes` returns a CAPPED outcome — to prove
    /// dispatch_list surfaces `truncated`/`total` to the model (PA-002).
    struct TruncatedListProvider;
    impl RetrievalProvider for TruncatedListProvider {
        fn list_notes(&self, _folder: Option<&str>) -> CoreResult<ListOutcome> {
            Ok(ListOutcome {
                notes: vec![NoteMeta {
                    title: "A".into(),
                    rel_path: "a.md".into(),
                }],
                skipped: 0,
                truncated: true,
                total: 500,
            })
        }
        fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
            Ok(Vec::new())
        }
        fn search_notes(
            &self,
            _query: &str,
            _max: usize,
            _folder: Option<&str>,
        ) -> CoreResult<SearchOutcome> {
            Ok(SearchOutcome::default())
        }
        fn read_note_span(
            &self,
            _r: &str,
            _s: u32,
            _e: u32,
            _b: usize,
        ) -> CoreResult<EvidenceSpan> {
            Err(CoreError::NotFound("unused".into()))
        }
    }

    fn retriever() -> (tempfile::TempDir, crate::ai::retrieval::KeywordRetriever) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("n.md"),
            "# Note\n\nalpha beta gamma\ndelta epsilon\n",
        )
        .unwrap();
        let r = crate::ai::retrieval::KeywordRetriever::new(dir.path());
        (dir, r)
    }

    /// A retriever over a vault with one subfolder (`Recipes/soup.md`) and one
    /// top-level note (`top.md`), both matching "simmer" — for folder-scope dispatch.
    fn folder_retriever() -> (tempfile::TempDir, crate::ai::retrieval::KeywordRetriever) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Recipes")).unwrap();
        fs::write(
            dir.path().join("Recipes/soup.md"),
            "# Soup\n\nSimmer gently.\n",
        )
        .unwrap();
        fs::write(dir.path().join("top.md"), "# Top\n\nSimmer elsewhere.\n").unwrap();
        let r = crate::ai::retrieval::KeywordRetriever::new(dir.path());
        (dir, r)
    }

    fn dispatch_base(
        name: &str,
        args_json: &str,
        provider: &dyn RetrievalProvider,
        registry: &mut EvidenceRegistry,
    ) -> ToolResult {
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 1,
                cpu_cores: 1,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 1,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::new(),
        };
        let mut active = ActiveSkills::new(8);
        let mut writes = WriteSession::new(1).unwrap();
        let mut sink = VecSink::default();
        let schemas = tool_schemas(&active.authorized_tools());
        let allowed = advertised_tool_names(&schemas);
        let mut context = ToolContext::new(
            Path::new("."),
            &skills,
            &environment,
            &mut active,
            &UnavailableNoteWriter,
            &mut writes,
            &mut sink,
            &allowed,
        );
        block_on(dispatch(
            "test-call",
            name,
            args_json,
            provider,
            registry,
            &NoUserPrompt,
            &mut context,
        ))
    }

    #[test]
    fn advertises_the_base_tools() {
        let names: Vec<String> = tool_schemas(&BTreeSet::new())
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            [
                TOOL_LIST_NOTES,
                TOOL_LIST_FOLDERS,
                TOOL_SEARCH_NOTES,
                TOOL_READ_NOTE_SPAN,
                TOOL_USE_SKILL,
            ]
        );
    }

    #[test]
    fn dispatch_folders_lists_folders_with_counts() {
        let (_d, r) = folder_retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_LIST_FOLDERS, "{}", &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Listed);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["folders"][0]["rel_path"], "Recipes");
        assert_eq!(v["folders"][0]["note_count"], 1);
        assert_eq!(reg.len(), 0, "listing folders reads no evidence");
    }

    #[test]
    fn dispatch_search_scopes_to_folder() {
        let (_d, r) = folder_retriever();
        let mut reg = EvidenceRegistry::new();
        // "simmer" matches both notes; scoping to Recipes returns only the Recipes hit.
        let res = dispatch_base(
            TOOL_SEARCH_NOTES,
            r#"{"query":"simmer","folder":"Recipes"}"#,
            &r,
            &mut reg,
        );
        assert!(matches!(
            res.outcome,
            ToolOutcome::Searched { hit_count: 1, .. }
        ));
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["evidence"][0]["rel_path"], "Recipes/soup.md");
    }

    #[test]
    fn dispatch_list_scopes_to_folder() {
        let (_d, r) = folder_retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_LIST_NOTES, r#"{"folder":"Recipes"}"#, &r, &mut reg);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        let notes = v["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["rel_path"], "Recipes/soup.md");
    }

    #[test]
    fn dispatch_search_registers_spans_and_returns_ids() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_SEARCH_NOTES, r#"{"query":"alpha"}"#, &r, &mut reg);
        assert!(matches!(
            res.outcome,
            ToolOutcome::Searched { hit_count: 1, .. }
        ));
        assert_eq!(reg.len(), 1);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["evidence"][0]["id"], "e1");
        assert_eq!(v["evidence"][0]["text"], "alpha beta gamma");
    }

    #[test]
    fn dispatch_read_registers_a_span() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(
            TOOL_READ_NOTE_SPAN,
            r#"{"rel_path":"n.md","start_line":3,"end_line":4}"#,
            &r,
            &mut reg,
        );
        assert!(matches!(
            res.outcome,
            ToolOutcome::Read {
                start_line: 3,
                end_line: 4,
                ..
            }
        ));
        assert_eq!(
            reg.get("e1").unwrap().text,
            "alpha beta gamma\ndelta epsilon"
        );
    }

    #[test]
    fn dispatch_list_returns_metadata() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_LIST_NOTES, "{}", &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Listed);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["notes"][0]["rel_path"], "n.md");
        assert_eq!(reg.len(), 0, "listing reads no evidence");
    }

    #[test]
    fn dispatch_rejects_unknown_tool() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base("nope", "{}", &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Rejected);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert!(v["error"].as_str().unwrap().contains("unknown tool"));
    }

    #[test]
    fn dispatch_rejects_malformed_arguments() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        // Missing the required `query` field.
        let res = dispatch_base(TOOL_SEARCH_NOTES, r#"{"max_results":3}"#, &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Rejected);
        assert!(serde_json::from_str::<Value>(&res.content).unwrap()["error"].is_string());
    }

    #[test]
    fn dispatch_search_dedupes_duplicate_spans_by_id() {
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(
            TOOL_SEARCH_NOTES,
            r#"{"query":"x"}"#,
            &DupProvider,
            &mut reg,
        );
        assert_eq!(reg.len(), 1, "the registry collapses the identical spans");
        assert!(matches!(
            res.outcome,
            ToolOutcome::Searched { hit_count: 1, .. }
        ));
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(
            v["evidence"].as_array().unwrap().len(),
            1,
            "the duplicate span must appear once, not twice"
        );
    }

    #[test]
    fn dispatch_list_surfaces_skipped_count() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_LIST_NOTES, "{}", &r, &mut reg);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["skipped"], 0); // honest discovery footer, even when nothing skipped
    }

    #[test]
    fn dispatch_list_surfaces_truncated_and_total() {
        // A capped listing must tell the model it saw only the first K of `total`
        // notes — the same honesty search_notes gives (PA-002).
        let mut reg = EvidenceRegistry::new();
        let res = dispatch_base(TOOL_LIST_NOTES, "{}", &TruncatedListProvider, &mut reg);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["total"], 500);
    }

    #[test]
    fn dispatch_search_clamps_absurd_max_results() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        // 9999 is clamped to MAX_SEARCH_RESULTS; the call still succeeds.
        let res = dispatch_base(
            TOOL_SEARCH_NOTES,
            r#"{"query":"alpha","max_results":9999}"#,
            &r,
            &mut reg,
        );
        assert!(matches!(res.outcome, ToolOutcome::Searched { .. }));
    }
}
