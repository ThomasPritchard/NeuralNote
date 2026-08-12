use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use chrono::{Local, TimeZone};
use neuralnote_core::error::CoreError;
use neuralnote_core::{backlinks, links, note, search, templates, workspace_state};
use serde::Serialize;
use serde_json::{json, Value};

const CONTRACT_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../app/desktop/src/e2e/fixtures/mock-ipc-contract-v1.json"
);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    version: u8,
    constants: Constants,
    errors: Errors,
    scenarios: BTreeMap<&'static str, Vec<Exchange>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Constants {
    max_editable_note_bytes: usize,
    max_total_matches: usize,
    max_matches_per_file: usize,
    max_query_chars: usize,
    snippet_max_chars: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Errors {
    not_found: CoreError,
    already_exists: CoreError,
    outside_vault: CoreError,
    invalid_name: CoreError,
    invalid_content: CoreError,
    conflict: CoreError,
    io: CoreError,
    frontmatter: CoreError,
    llm: CoreError,
    local_ai: CoreError,
}

#[derive(Serialize)]
struct Exchange {
    command: &'static str,
    arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutation: Option<Value>,
}

fn ok(command: &'static str, arguments: Value, result: Value) -> Exchange {
    Exchange {
        command,
        arguments,
        result: Some(result),
        error: None,
        mutation: None,
    }
}

fn err(command: &'static str, arguments: Value, error: CoreError) -> Exchange {
    Exchange {
        command,
        arguments,
        result: None,
        error: Some(serde_json::to_value(error).expect("serialize contract exchange error")),
        mutation: None,
    }
}

fn write_vault(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let vault = tempfile::tempdir().expect("create contract vault");
    for (rel, content) in files {
        let path = vault.path().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create contract parent");
        }
        fs::write(path, content).expect("write contract fixture file");
    }
    vault
}

fn normalized<T: Serialize>(value: T, root: &Path) -> Value {
    fn visit(value: &mut Value, root: &str) {
        match value {
            Value::String(text) => {
                if text.contains(root) {
                    *text = text.replace(root, "/vault");
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| visit(item, root)),
            Value::Object(fields) => fields.values_mut().for_each(|item| visit(item, root)),
            _ => {}
        }
    }

    let mut value = serde_json::to_value(value).expect("serialize contract value");
    let canonical_root = root.canonicalize().expect("canonicalize contract root");
    visit(&mut value, &canonical_root.to_string_lossy());
    value
}

fn search_exchange(query: &'static str, files: &[(&str, &[u8])]) -> Exchange {
    let vault = write_vault(files);
    ok(
        "search_vault",
        json!({ "query": query }),
        normalized(
            search::search_vault(vault.path(), query).expect("contract search"),
            vault.path(),
        ),
    )
}

fn build_contract() -> Contract {
    let mut scenarios = BTreeMap::new();

    scenarios.insert("fixture-validation", vec![search_exchange("neural", &[])]);
    scenarios.insert(
        "search-inline-tags",
        vec![search_exchange(
            "tag:#SaaS",
            &[
                ("Source.md", b"#SaaS overview"),
                ("Exact.md", b"Uses #SaaS"),
                ("Nested.md", b"Uses #SaaS/cloud"),
                ("Prefix.md", b"Uses #SaaSExtra"),
                ("Code.md", b"`#SaaS`"),
                ("Property.md", b"---\ntags: [SaaS]\n---\nBody"),
            ],
        )],
    );
    scenarios.insert(
        "search-property-tags",
        vec![search_exchange(
            "tag:#SaaS",
            &[
                ("Property source.md", b"---\ntags: [SaaS]\n---\nBody"),
                ("Exact.md", b"Uses #SaaS"),
                ("Nested.md", b"---\ntags: [SaaS/cloud]\n---\nBody"),
                ("Prefix.md", b"Uses #SaaSExtra"),
            ],
        )],
    );
    scenarios.insert(
        "search-recipe",
        vec![search_exchange(
            "recipe",
            &[
                ("Recipes.md", b"Cooking ideas live here."),
                (
                    "Journal.md",
                    b"Tried a new recipe today.\n\nMore notes tomorrow.",
                ),
            ],
        )],
    );
    scenarios.insert(
        "search-alpha",
        vec![search_exchange(
            "alpha",
            &[
                ("Apple.md", b"alpha mention inside."),
                ("Zebra alpha.md", b"stripes and stars."),
            ],
        )],
    );
    scenarios.insert(
        "search-hello",
        vec![search_exchange("hello", &[("Note.md", b"hello")])],
    );

    let graph_vault = write_vault(&[
        ("notes/Alpha.md", b"Linked to [[Beta]].\n\nAlpha body."),
        ("notes/Beta.md", b"Beta body."),
        (
            "essays/Gamma.md",
            b"See [alpha note](../notes/Alpha.md).\n\nGamma body.",
        ),
    ]);
    scenarios.insert(
        "graph-linked",
        vec![ok(
            "read_link_graph",
            json!({}),
            normalized(
                links::read_link_graph(graph_vault.path()).expect("contract graph"),
                graph_vault.path(),
            ),
        )],
    );

    let feature_vault = write_vault(&[
        ("Target.md", b"Target body."),
        ("Link Hub.md", b"Go to [[Target]]."),
        ("Unresolved.md", b"This points at [[Missing Note]]."),
        ("Source Wiki.md", b"This links [[Target]] from wiki."),
        (
            "Source Md.md",
            b"This links [Target](Target.md) from markdown.",
        ),
        (
            "Plain Mention.md",
            b"A plain Target mention without a link.",
        ),
        ("Templates/Starter.md", b"Template body for {{title}}."),
    ]);
    scenarios.insert(
        "backlinks-feature",
        vec![ok(
            "read_backlinks",
            json!({ "path": "/vault/Target.md" }),
            normalized(
                backlinks::read_backlinks(feature_vault.path(), "Target.md")
                    .expect("contract backlinks"),
                feature_vault.path(),
            ),
        )],
    );
    let missing_target = "Missing.md";
    let missing_target_error = backlinks::read_backlinks(feature_vault.path(), missing_target)
        .expect_err("missing backlink target must produce a typed core error");
    scenarios.insert(
        "backlinks-missing-target",
        vec![err(
            "read_backlinks",
            json!({ "path": format!("/vault/{missing_target}") }),
            missing_target_error,
        )],
    );

    let template_list = normalized(
        templates::list_templates(feature_vault.path()).expect("contract templates"),
        feature_vault.path(),
    );
    let now = Local
        .with_ymd_and_hms(2026, 1, 2, 15, 4, 5)
        .single()
        .expect("contract clock");
    let created = templates::create_note_from_template(
        feature_vault.path(),
        feature_vault.path(),
        "Project Plan",
        Some("Templates/Starter.md"),
        now,
    )
    .expect("contract template creation");
    let created_content = fs::read_to_string(feature_vault.path().join("Project Plan.md"))
        .expect("read rendered contract note");
    scenarios.insert(
        "templates-feature",
        vec![
            ok("list_templates", json!({}), template_list),
            Exchange {
                command: "create_note_from_template",
                arguments: json!({
                    "parentPath": "/vault",
                    "name": "Project Plan",
                    "template": "Templates/Starter.md"
                }),
                result: Some(normalized(created, feature_vault.path())),
                error: None,
                mutation: Some(json!({
                    "write": {
                        "relPath": "Project Plan.md",
                        "content": created_content
                    }
                })),
            },
        ],
    );

    let note_vault = write_vault(&[
        ("normal.md", b"# Normal\n\nbody"),
        ("binary.png", &[0xff, 0xfe, 0xfd]),
        ("lossy.md", &[0xe9]),
        ("malformed.md", b"---\ntitle: broken\nno closing fence"),
    ]);
    let oversized = note_vault.path().join("oversized.md");
    let oversized_file = fs::File::create(&oversized).expect("create oversized contract note");
    oversized_file
        .set_len((note::MAX_EDITABLE_NOTE_BYTES + 1) as u64)
        .expect("size oversized contract note");
    for rel in [
        "normal.md",
        "binary.png",
        "lossy.md",
        "malformed.md",
        "oversized.md",
    ] {
        let path = note_vault.path().join(rel);
        let scenario = match rel {
            "normal.md" => "note-read-normal",
            "binary.png" => "note-read-binary",
            "lossy.md" => "note-read-lossy",
            "malformed.md" => "note-read-malformed",
            "oversized.md" => "note-read-oversized",
            _ => unreachable!("fixed contract note"),
        };
        scenarios.insert(
            scenario,
            vec![ok(
                "read_note",
                json!({ "path": format!("/vault/{rel}") }),
                normalized(
                    note::read_note(note_vault.path(), &path).expect("contract note read"),
                    note_vault.path(),
                ),
            )],
        );
    }
    fs::create_dir_all(note_vault.path().join(".neuralnote")).expect("create workspace state dir");
    fs::write(
        note_vault.path().join(".neuralnote/workspace-state.json"),
        b"{not json",
    )
    .expect("write corrupt workspace state");
    scenarios.insert(
        "workspace-corrupt",
        vec![ok(
            "load_workspace_state",
            json!({}),
            normalized(
                workspace_state::load_workspace_state(note_vault.path())
                    .expect("contract corrupt workspace load"),
                note_vault.path(),
            ),
        )],
    );

    // The three tool-approval commands. Component tests `vi.mock` the whole api
    // module, so a WRONG command name or a renamed argument passes them — only
    // this contract, driven through the e2e mockVault seam, catches it. The
    // approval payload is composed from the same Rust tables the gate consults,
    // so a reclassification shows up here too.
    let approval_status = json!({
        "mode": "alwaysAsk",
        "toolOverrides": {},
        "effectiveModes": neuralnote_core::ai::approval::ALL_GATED_TOOLS
            .into_iter()
            .map(|tool| (tool.name().to_string(), json!("alwaysAsk")))
            .collect::<serde_json::Map<_, _>>(),
        "classifierAvailable": false,
        "irreversibleActions": neuralnote_core::ai::approval::irreversible_display_names(),
    });
    let ai_status_with = |approval: &Value| {
        json!({
            "activeProvider": "openRouter",
            "reasoningSupported": "unknown",
            "openrouter": { "hasKey": true, "model": neuralnote_core::ai::DEFAULT_MODEL, "reasoning": false },
            "local": { "activeModelTag": Value::Null },
            "approval": approval,
        })
    };
    scenarios.insert(
        "tool-approval-answer",
        vec![ok(
            "answer_tool_approval",
            json!({ "turnId": "00000000-0000-0000-0000-000000000001", "id": "call-1", "approved": false }),
            Value::Null,
        )],
    );
    scenarios.insert(
        "tool-approval-set-mode",
        vec![ok(
            "set_approval_mode",
            json!({ "mode": "yolo" }),
            ai_status_with(&approval_status),
        )],
    );
    scenarios.insert(
        "tool-approval-set-override",
        vec![ok(
            "set_tool_approval_override",
            json!({
                "tool": neuralnote_core::ai::TOOL_WRITE_NOTE,
                "mode": "alwaysAsk",
            }),
            ai_status_with(&approval_status),
        )],
    );

    let errors = Errors {
        not_found: CoreError::NotFound("fixture".into()),
        already_exists: CoreError::AlreadyExists("fixture".into()),
        outside_vault: CoreError::OutsideVault("fixture".into()),
        invalid_name: CoreError::InvalidName("fixture".into()),
        invalid_content: CoreError::InvalidContent("fixture".into()),
        conflict: CoreError::Conflict("fixture".into()),
        io: CoreError::Io("fixture".into()),
        frontmatter: CoreError::Frontmatter("fixture".into()),
        llm: CoreError::Llm("fixture".into()),
        local_ai: CoreError::LocalAi("fixture".into()),
    };

    Contract {
        version: 1,
        constants: Constants {
            max_editable_note_bytes: note::MAX_EDITABLE_NOTE_BYTES,
            max_total_matches: search::MAX_TOTAL_MATCHES,
            max_matches_per_file: search::MAX_MATCHES_PER_FILE,
            max_query_chars: search::MAX_QUERY_CHARS,
            snippet_max_chars: search::SNIPPET_MAX_CHARS,
        },
        errors,
        scenarios,
    }
}

#[test]
fn tracked_mock_ipc_contract_matches_rust() {
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&build_contract()).expect("render contract")
    );
    if std::env::var_os("UPDATE_MOCK_IPC_CONTRACT").is_some() {
        fs::write(CONTRACT_PATH, rendered).expect("write generated MockIpcContractV1");
        return;
    }
    let tracked = fs::read_to_string(CONTRACT_PATH).expect("read tracked MockIpcContractV1");
    assert_eq!(
        tracked, rendered,
        "run UPDATE_MOCK_IPC_CONTRACT=1 cargo test -p neuralnote-core --test mock_ipc_contract_v1"
    );
}
