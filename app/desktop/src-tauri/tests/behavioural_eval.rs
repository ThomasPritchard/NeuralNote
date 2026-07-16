use neuralnote_core::ai::{
    ChatEvent, EventSink, HardwareSpec, LlmMessage, NoUserPrompt, Role, SkillEnvironment,
    SkillRegistry, SkillServices, UnavailableNoteWriter,
};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::time::Duration;

struct CollectingSink {
    events: Vec<ChatEvent>,
}

impl EventSink for CollectingSink {
    fn send(&mut self, event: ChatEvent) {
        self.events.push(event);
    }
}

fn count_searches(events: &[ChatEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ChatEvent::Searching { .. }))
        .count()
}

fn count_citations(events: &[ChatEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ChatEvent::Citation { .. }))
        .count()
}

fn answer_text(events: &[ChatEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::Answer { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect()
}

fn first_error(events: &[ChatEvent]) -> Option<&str> {
    events.iter().find_map(|event| match event {
        ChatEvent::Error { message } => Some(message.as_str()),
        _ => None,
    })
}

fn fixture_vault() -> tempfile::TempDir {
    let vault = tempfile::tempdir().expect("create behavioural-eval fixture vault");
    let projects = vault.path().join("Projects");
    fs::create_dir(&projects).expect("create Projects fixture folder");
    fs::write(
        projects.join("meridian.md"),
        "# Meridian Protocol\n\nThe Meridian Protocol uses a 47-second handshake window.\nNodes authenticate with a rotating quorum key.\n",
    )
    .expect("write Meridian fixture note");
    vault
}

fn require_eval() -> bool {
    std::env::var("NEURALNOTE_REQUIRE_EVAL")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn skip_or_fail(provider: &str, reason: &str, enable_hint: &str) {
    use std::io::Write;

    let notice = format!(
        "\n================ NEURALNOTE BEHAVIOURAL EVAL SKIPPED ================\n\
         Provider: {provider}\n\
         Reason: {reason}\n\
         Enable it by: {enable_hint}\n\
         A SKIPPED run is NOT a pass. Set NEURALNOTE_REQUIRE_EVAL=1 to make a skip a hard failure (CI/release).\n\
         ======================================================================\n"
    );
    let _ = std::io::stderr().write_all(notice.as_bytes());

    if require_eval() {
        panic!(
            "NEURALNOTE_REQUIRE_EVAL=1 but the {provider} behavioural eval could not run: {reason} — enable it by: {enable_hint}"
        );
    }
}

async fn run_case(
    root: &Path,
    model: &str,
    client: &desktop_lib::OpenAiChatClient,
    prompt: &str,
    history: &[LlmMessage],
) -> Vec<ChatEvent> {
    let retriever = neuralnote_core::ai::KeywordRetriever::new(root.to_path_buf());
    let guards = neuralnote_core::ai::Guards::default();
    let registry = SkillRegistry::built_in(&[]).expect("load built-in skills");
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 0,
            cpu_cores: 0,
            cpu_brand: String::new(),
            gpu_label: None,
            arch: std::env::consts::ARCH.into(),
            os: std::env::consts::OS.into(),
            free_disk_bytes: 0,
        },
        app_data_bin_dir: std::path::PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let skill_services = SkillServices::new(
        &registry,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let mut sink = CollectingSink { events: Vec::new() };
    neuralnote_core::ai::run_chat(
        prompt,
        history,
        Vec::new(),
        root,
        model,
        &retriever,
        client,
        &skill_services,
        &mut sink,
        &guards,
    )
    .await
    .expect("run_chat resolves via the sink");
    sink.events
}

async fn run_five_cases(root: &Path, model: &str, client: &desktop_lib::OpenAiChatClient) {
    let greeting = run_case(root, model, client, "hey", &[]).await;
    let error = first_error(&greeting);
    assert!(
        error.is_none(),
        "Case 1 greeting emitted an error: {}",
        error.unwrap_or_default()
    );
    assert_eq!(count_searches(&greeting), 0, "Case 1 greeting searches");
    assert_eq!(count_citations(&greeting), 0, "Case 1 greeting citations");

    let meta = run_case(root, model, client, "what can you do?", &[]).await;
    let error = first_error(&meta);
    assert!(
        error.is_none(),
        "Case 2 meta emitted an error: {}",
        error.unwrap_or_default()
    );
    assert_eq!(count_searches(&meta), 0, "Case 2 meta searches");
    assert_eq!(count_citations(&meta), 0, "Case 2 meta citations");

    let factual_prompt =
        "According to my notes, how long is the Meridian Protocol handshake window?";
    let factual = run_case(root, model, client, factual_prompt, &[]).await;
    let error = first_error(&factual);
    assert!(
        error.is_none(),
        "Case 3 factual-in-vault emitted an error: {}",
        error.unwrap_or_default()
    );
    assert!(
        count_searches(&factual) >= 1,
        "Case 3 factual-in-vault must search at least once"
    );
    assert!(
        count_citations(&factual) >= 1,
        "Case 3 factual-in-vault must emit at least one verified citation"
    );
    let factual_answer = answer_text(&factual);

    let missing = run_case(
        root,
        model,
        client,
        "What do my notes say about the Fibonacci trading strategy?",
        &[],
    )
    .await;
    let error = first_error(&missing);
    assert!(
        error.is_none(),
        "Case 4 factual-not-in-vault emitted an error: {}",
        error.unwrap_or_default()
    );
    assert!(
        count_searches(&missing) >= 1,
        "Case 4 factual-not-in-vault must search at least once"
    );
    assert_eq!(
        count_citations(&missing),
        0,
        "Case 4 factual-not-in-vault citations"
    );
    let missing_answer = answer_text(&missing).to_lowercase();
    for forbidden in ["youtube", "distil", "distill", "pdf"] {
        assert!(
            !missing_answer.contains(forbidden),
            "Case 4 factual-not-in-vault must not offer unavailable {forbidden} capture"
        );
    }

    let history = [
        LlmMessage::user(factual_prompt),
        LlmMessage {
            role: Role::Assistant,
            content: Some(factual_answer),
            tool_calls: vec![],
            tool_call_id: None,
            name: None,
        },
    ];
    let follow_up = run_case(
        root,
        model,
        client,
        "Can you say that more simply?",
        &history,
    )
    .await;
    let error = first_error(&follow_up);
    assert!(
        error.is_none(),
        "Case 5 follow-up emitted an error: {}",
        error.unwrap_or_default()
    );
    assert_eq!(count_searches(&follow_up), 0, "Case 5 follow-up searches");
    assert_eq!(count_citations(&follow_up), 0, "Case 5 follow-up citations");
}

/// Classify a one-token Ollama `/api/generate` probe into runner health.
///
/// Healthy = a 2xx response whose body parses as a JSON object and carries no
/// `error` property. Ollama surfaces both runner failures (dead `llama-server`,
/// broken `OLLAMA_LIBRARY_PATH`) and model-not-found via an `error` property, and
/// can even emit one in-band on a 200 mid-stream frame — so the `error` property is
/// inspected regardless of status. Any `error` body, any non-2xx status, or an
/// unparseable/non-object 2xx body is treated as an unavailable runner so the caller
/// can skip loudly rather than let a later eval case hard-fail on an HTTP 500.
fn classify_runner_health(status: u16, body: &str) -> Result<(), String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();

    if let Some(message) = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|error| error.as_str())
        .map(str::trim)
        .filter(|error| !error.is_empty())
    {
        return Err(format!(
            "the Ollama one-token probe reported a runner error: {message}"
        ));
    }

    if !(200..300).contains(&status) {
        return Err(format!("the Ollama one-token probe returned HTTP {status}"));
    }

    match parsed {
        Some(serde_json::Value::Object(_)) => Ok(()),
        _ => Err("the Ollama one-token probe returned an unrecognised success body".to_string()),
    }
}

/// The local model the eval should exercise. Defaults to `DEFAULT_LOCAL_MODEL`,
/// but `NEURALNOTE_EVAL_MODEL` overrides it so the same harness can measure
/// per-tier citation adherence (#68) without editing the shipped default.
fn eval_local_model() -> String {
    std::env::var("NEURALNOTE_EVAL_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| neuralnote_core::ai::DEFAULT_LOCAL_MODEL.to_string())
}

async fn ollama_available(port: u16, model: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("could not build the Ollama reachability client: {error}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/api/tags"))
        .send()
        .await
        .map_err(|error| format!("the Ollama /api/tags probe failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "the Ollama /api/tags probe returned {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("the Ollama /api/tags body could not be read: {error}"))?;
    let models = neuralnote_core::ai::parse_installed_models(&body)
        .map_err(|error| format!("the Ollama /api/tags body could not be parsed: {error}"))?;

    let listed = models
        .iter()
        .any(|installed| neuralnote_core::ai::model_installed(&installed.tag, model));
    if !listed {
        return Err(format!(
            "the required local model '{model}' is not installed"
        ));
    }

    // Listing the model does not prove the runner can start. An Ollama that lists the
    // model but can't launch its `llama-server` (missing binary / broken
    // OLLAMA_LIBRARY_PATH) passes the /api/tags check and then 500s on the first real
    // generation. Probe one token here so that failure becomes a loud skip instead of a
    // Case-1 hard failure. A cold model load can take tens of seconds, so this request
    // is given its own generous timeout, well beyond the reachability client's default.
    let probe = client
        .post(format!("http://127.0.0.1:{port}/api/generate"))
        .timeout(Duration::from_secs(120))
        .json(&serde_json::json!({
            "model": model,
            "prompt": "hi",
            "stream": false,
            "options": { "num_predict": 1 },
        }))
        .send()
        .await
        .map_err(|error| format!("the Ollama one-token probe failed: {error}"))?;
    let status = probe.status().as_u16();
    let body = probe
        .text()
        .await
        .map_err(|error| format!("the Ollama one-token probe body could not be read: {error}"))?;
    classify_runner_health(status, &body)
}

// Both tiers are live-model probes with an external dependency (a billed OpenRouter
// call / a running Ollama) and a non-deterministic model in the loop. They are
// `#[ignore]` so a routine `cargo test --workspace` never runs them — it would
// otherwise make real network calls whenever OPENROUTER_API_KEY is in the env, and
// fail non-deterministically whenever Ollama is up (the local model's citation
// adherence is ~1/3, see [[project-local-model-marginal-for-citation]]). Run them
// deliberately: `cargo test -p desktop --test behavioural_eval -- --ignored`
// (add the provider creds + NEURALNOTE_REQUIRE_EVAL=1 to hard-fail on a skip in CI).
#[tokio::test]
#[ignore = "live-model eval; opt-in via `cargo test --test behavioural_eval -- --ignored`"]
async fn openrouter_behavioural_eval() {
    let enable_hint = format!(
        "set OPENROUTER_API_KEY to your OpenRouter key (default model: {})",
        neuralnote_core::ai::DEFAULT_MODEL
    );
    let Some(api_key) = std::env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
    else {
        skip_or_fail(
            "OpenRouter",
            "OPENROUTER_API_KEY is missing or empty",
            &enable_hint,
        );
        return;
    };

    let vault = fixture_vault();
    let client = desktop_lib::OpenAiChatClient::new(api_key, false);
    run_five_cases(vault.path(), neuralnote_core::ai::DEFAULT_MODEL, &client).await;
}

#[tokio::test]
#[ignore = "live-model eval; opt-in via `cargo test --test behavioural_eval -- --ignored`"]
async fn local_ollama_behavioural_eval() {
    let port = std::env::var("NEURALNOTE_OLLAMA_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(11434);
    let model = eval_local_model();
    let enable_hint = format!(
        "start Ollama with '{model}' pulled (ollama pull {model}); set NEURALNOTE_OLLAMA_PORT if it is not on 11434, or NEURALNOTE_EVAL_MODEL to measure a different tier"
    );
    if let Err(reason) = ollama_available(port, &model).await {
        skip_or_fail("Ollama", &reason, &enable_hint);
        return;
    }

    let vault = fixture_vault();
    let client = desktop_lib::ollama_chat_client(port, false);
    // RESOLVED(local-model-citation-reliability): DEFAULT_LOCAL_MODEL (qwen3.5:9b)
    // passes Case 3 (factual-in-vault ⇒ ≥1 verified citation) only ~1 run in 3 — it
    // inconsistently emits the `[eN]` marker, though the pipeline verifies correctly
    // when it does. Product decision: the local tier is explicitly BEST-EFFORT for
    // citation fidelity. The strict Case 3 assertion is DELIBERATELY RETAINED (a wrong
    // citation is worse than no answer, so the eval must keep demanding one) — it is
    // not loosened, skipped, or made conditional.
    //
    // RESOLVED(#68) — tier comparison, measured 2026-07-16 (K=6 runs/model via the
    // NEURALNOTE_EVAL_MODEL override below): granite4.1:3b 1/6, qwen3.5:4b 1/6,
    // qwen3.5:9b 2/6, granite4.1:8b 0/6, qwen3.5:27b 1/6. Two findings: (1) bigger is
    // NOT reliably better past 9b — 27b matched the smallest tiers at 3× the latency
    // (~190s/run) and 26 GB RAM; (2) the qwen3.5 family beats granite4.1, which emits
    // no verified citation even at 8b. So the default (9b) and the RAM-adaptive sizing
    // stand: 9b is the best-measured local tier, and no local model is reliable enough
    // to change the "steer citation-critical users to BYO-API-key" stance. Re-run per
    // tier with `NEURALNOTE_EVAL_MODEL=<tag>`. See [[project-local-model-marginal-for-citation]].
    run_five_cases(vault.path(), &model, &client).await;
}

// The live probe needs a real Ollama, so the runnability classification is factored into
// the pure `classify_runner_health` helper and unit-tested here for the three preflight
// states. These run on the default `cargo test -p desktop` path; the live wiring stays in
// the `#[ignore]` eval above.
#[test]
fn runner_health_listed_and_runnable_is_ok() {
    let body =
        r#"{"model":"qwen3.5:9b","created_at":"2026-07-16T00:00:00Z","response":"Hi","done":true}"#;
    assert!(classify_runner_health(200, body).is_ok());
}

#[test]
fn runner_health_listed_but_broken_runner_is_unavailable() {
    let body = r#"{"error":"llama runner process has terminated: exit status 127"}"#;
    let reason = classify_runner_health(500, body).expect_err("a dead runner must be unavailable");
    assert!(
        reason.contains("runner error") && reason.contains("terminated"),
        "reason should surface the runner error, got: {reason}"
    );
}

#[test]
fn runner_health_missing_model_is_unavailable() {
    let body = r#"{"error":"model \"qwen3.5:9b\" not found, try pulling it first"}"#;
    let reason =
        classify_runner_health(404, body).expect_err("a not-found model must be unavailable");
    assert!(
        reason.contains("not found"),
        "reason should surface the model-not-found error, got: {reason}"
    );
}

#[test]
fn runner_health_in_band_error_on_200_is_unavailable() {
    // Ollama keeps HTTP 200 when a runner dies mid-stream and reports the failure in-band,
    // so an `error` body must be treated as unavailable regardless of a 2xx status.
    let body = r#"{"error":"an error was encountered while running the model"}"#;
    assert!(classify_runner_health(200, body).is_err());
}

#[test]
fn runner_health_unparseable_success_body_is_unavailable() {
    assert!(classify_runner_health(200, "not json").is_err());
}
