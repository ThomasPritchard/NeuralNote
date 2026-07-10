use neuralnote_core::ai::{ChatEvent, EventSink, LlmMessage, Role};
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
    let mut sink = CollectingSink { events: Vec::new() };
    neuralnote_core::ai::run_chat(
        prompt, history, root, model, &retriever, client, &mut sink, &guards,
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

async fn ollama_available(port: u16) -> Result<(), String> {
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

    // TODO(eval-ollama-runnability-probe): this checks the model is *listed*, not that
    // it can *run*. An Ollama that lists the model but can't start its `llama-server`
    // runner (missing binary / broken OLLAMA_LIBRARY_PATH) passes this guard and then
    // hard-fails at Case 1 with a 500 instead of skipping loudly. To make the skip
    // robust, probe a one-token generation here and treat a runner error as "unavailable".
    if models.iter().any(|model| {
        neuralnote_core::ai::model_installed(&model.tag, neuralnote_core::ai::DEFAULT_LOCAL_MODEL)
    }) {
        Ok(())
    } else {
        Err(format!(
            "the required local model '{}' is not installed",
            neuralnote_core::ai::DEFAULT_LOCAL_MODEL
        ))
    }
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
    let enable_hint = format!(
        "start Ollama with '{}' pulled (ollama pull {}); set NEURALNOTE_OLLAMA_PORT if it is not on 11434",
        neuralnote_core::ai::DEFAULT_LOCAL_MODEL,
        neuralnote_core::ai::DEFAULT_LOCAL_MODEL
    );
    if let Err(reason) = ollama_available(port).await {
        skip_or_fail("Ollama", &reason, &enable_hint);
        return;
    }

    let vault = fixture_vault();
    let client = desktop_lib::ollama_chat_client(port, false);
    // TODO(local-model-citation-reliability): measured 2026-07-10 against the packaged
    // sidecar, DEFAULT_LOCAL_MODEL (qwen3.5:9b) passes Case 3 (factual-in-vault ⇒ ≥1
    // verified citation) only ~1 run in 3 — it inconsistently emits the `[eN]` marker,
    // though the pipeline verifies correctly when it does. The eval is right to demand
    // a citation; the small model is marginal for the moat on the local path. Product
    // decision (a stronger default local model, or setting local as best-effort) — not a
    // code fix, and NOT to be papered over by loosening the assertion. See
    // [[project-local-model-marginal-for-citation]].
    run_five_cases(
        vault.path(),
        neuralnote_core::ai::DEFAULT_LOCAL_MODEL,
        &client,
    )
    .await;
}
