//! The tools exposed to the model, and the dispatcher that runs them.
//!
//! Three tools, all whole-vault (folder/note scoping is deferred): `list_notes`
//! (metadata only), `search_notes` (→ evidence spans), and `read_note_span`
//! (a bounded read). Schemas are OpenAI-compatible `serde_json::Value`s. Tool
//! argument property names are `snake_case` — these are LLM-facing, not the
//! frontend camelCase contract.
//!
//! [`dispatch`] is total: a bad tool name or malformed arguments become an error
//! *tool result* the model reads and recovers from, never a hard failure — an
//! agentic loop must tolerate the model asking for something impossible.

use crate::ai::evidence::EvidenceRegistry;
use crate::ai::retrieval::RetrievalProvider;
use serde::Deserialize;
use serde_json::{json, Value};

pub const TOOL_LIST_NOTES: &str = "list_notes";
pub const TOOL_LIST_FOLDERS: &str = "list_folders";
pub const TOOL_SEARCH_NOTES: &str = "search_notes";
pub const TOOL_READ_NOTE_SPAN: &str = "read_note_span";

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
    /// The call was rejected (bad name/args/path). The detail is in the content the
    /// model reads; the orchestrator emits no event for it.
    Rejected,
}

/// The outcome of one tool call: the JSON string for the `role:"tool"` message, and
/// a structured [`ToolOutcome`] for the orchestrator.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub content: String,
    pub outcome: ToolOutcome,
}

/// The tool schemas to advertise to the model (OpenAI `tools` array shape).
pub fn tool_schemas() -> Vec<Value> {
    vec![
        list_notes_schema(),
        list_folders_schema(),
        search_notes_schema(),
        read_note_span_schema(),
    ]
}

fn function_tool(name: &str, description: &str, parameters: Value) -> Value {
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
                    "description": "Maximum evidence spans to return (default 8).",
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
pub fn dispatch(
    name: &str,
    args_json: &str,
    provider: &dyn RetrievalProvider,
    registry: &mut EvidenceRegistry,
) -> ToolResult {
    match name {
        TOOL_LIST_NOTES => dispatch_list(args_json, provider),
        TOOL_LIST_FOLDERS => dispatch_folders(provider),
        TOOL_SEARCH_NOTES => dispatch_search(args_json, provider, registry),
        TOOL_READ_NOTE_SPAN => dispatch_read(args_json, provider, registry),
        other => reject(format!("unknown tool '{other}'")),
    }
}

fn reject(message: String) -> ToolResult {
    ToolResult {
        content: json!({ "error": message }).to_string(),
        outcome: ToolOutcome::Rejected,
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
        // `skipped` tells the model discovery was partial — never a silent omission.
        content: json!({ "notes": listed, "skipped": outcome.skipped }).to_string(),
        outcome: ToolOutcome::Listed,
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
    use crate::ai::evidence::EvidenceSpan;
    use crate::ai::retrieval::{FolderMeta, ListOutcome, SearchOutcome};
    use crate::error::{CoreError, CoreResult};
    use std::fs;

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

    #[test]
    fn advertises_the_four_tools() {
        let names: Vec<String> = tool_schemas()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            [
                TOOL_LIST_NOTES,
                TOOL_LIST_FOLDERS,
                TOOL_SEARCH_NOTES,
                TOOL_READ_NOTE_SPAN
            ]
        );
    }

    #[test]
    fn dispatch_folders_lists_folders_with_counts() {
        let (_d, r) = folder_retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch(TOOL_LIST_FOLDERS, "{}", &r, &mut reg);
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
        let res = dispatch(
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
        let res = dispatch(TOOL_LIST_NOTES, r#"{"folder":"Recipes"}"#, &r, &mut reg);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        let notes = v["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["rel_path"], "Recipes/soup.md");
    }

    #[test]
    fn dispatch_search_registers_spans_and_returns_ids() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch(TOOL_SEARCH_NOTES, r#"{"query":"alpha"}"#, &r, &mut reg);
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
        let res = dispatch(
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
        let res = dispatch(TOOL_LIST_NOTES, "{}", &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Listed);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["notes"][0]["rel_path"], "n.md");
        assert_eq!(reg.len(), 0, "listing reads no evidence");
    }

    #[test]
    fn dispatch_rejects_unknown_tool() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        let res = dispatch("nope", "{}", &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Rejected);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert!(v["error"].as_str().unwrap().contains("unknown tool"));
    }

    #[test]
    fn dispatch_rejects_malformed_arguments() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        // Missing the required `query` field.
        let res = dispatch(TOOL_SEARCH_NOTES, r#"{"max_results":3}"#, &r, &mut reg);
        assert_eq!(res.outcome, ToolOutcome::Rejected);
        assert!(serde_json::from_str::<Value>(&res.content).unwrap()["error"].is_string());
    }

    #[test]
    fn dispatch_search_dedupes_duplicate_spans_by_id() {
        let mut reg = EvidenceRegistry::new();
        let res = dispatch(
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
        let res = dispatch(TOOL_LIST_NOTES, "{}", &r, &mut reg);
        let v: Value = serde_json::from_str(&res.content).unwrap();
        assert_eq!(v["skipped"], 0); // honest discovery footer, even when nothing skipped
    }

    #[test]
    fn dispatch_search_clamps_absurd_max_results() {
        let (_d, r) = retriever();
        let mut reg = EvidenceRegistry::new();
        // 9999 is clamped to MAX_SEARCH_RESULTS; the call still succeeds.
        let res = dispatch(
            TOOL_SEARCH_NOTES,
            r#"{"query":"alpha","max_results":9999}"#,
            &r,
            &mut reg,
        );
        assert!(matches!(res.outcome, ToolOutcome::Searched { .. }));
    }
}
