use chrono::NaiveDate;
use neuralnote_core::capture::{
    atomic_filename, estimate_transcript_cost, literature_filename, merge_nn_source,
    transcript_filename, CaptureError, ModelPricing, NnSource, PricingInput, SourceType,
    MAX_FILENAME_STEM_BYTES,
};
use serde_yaml_ng::{Mapping, Value};

fn date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 7, 11).unwrap()
}

#[test]
fn literature_and_transcript_names_share_a_sanitised_sentence_case_title() {
    assert_eq!(
        literature_filename(date(), "  WHY: Rust / works?  ").unwrap(),
        "2026-07-11 Why Rust works.md"
    );
    assert_eq!(
        transcript_filename(date(), "  WHY: Rust / works?  ").unwrap(),
        "2026-07-11 Why Rust works transcript.md"
    );
    assert_eq!(
        literature_filename(date(), "how OpenAI Uses Rust").unwrap(),
        "2026-07-11 How OpenAI Uses Rust.md"
    );
    assert_eq!(
        literature_filename(date(), "How To Build A Compiler").unwrap(),
        "2026-07-11 How to build a compiler.md"
    );
}

#[test]
fn atomic_names_have_no_date_and_preserve_concept_case() {
    assert_eq!(
        atomic_filename("  Markov / chains: intuition  ").unwrap(),
        "Markov chains intuition.md"
    );
    assert_eq!(atomic_filename("COM1").unwrap(), "_COM1.md");
}

#[test]
fn filename_sanitisation_is_portable_bounded_and_unicode_safe() {
    let long_unicode = format!("{} / end.", "é".repeat(MAX_FILENAME_STEM_BYTES));
    let filename = atomic_filename(&long_unicode).unwrap();
    let stem = filename.strip_suffix(".md").unwrap();

    assert!(stem.len() <= MAX_FILENAME_STEM_BYTES);
    assert!(stem.is_char_boundary(stem.len()));
    assert!(!stem.ends_with([' ', '.']));
    assert!(!stem.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }));
}

#[test]
fn filename_sanitisation_rejects_an_empty_result() {
    for title in ["", "  ", "///", "...", "\0\n"] {
        assert!(matches!(
            atomic_filename(title),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }
    assert!(matches!(
        atomic_filename(&"x".repeat(10_000)),
        Err(CaptureError::InvalidMetadata(message)) if message.contains("input limit")
    ));
}

fn valid_source() -> NnSource {
    NnSource::new(
        SourceType::Youtube,
        "https://www.youtube.com/watch?v=iG9CE55wbtY",
        "2026-07-11T14:02:11Z",
        "Resources/attachments/2026-07-11 Talk transcript.md",
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
    .unwrap()
}

fn key(value: &str) -> Value {
    Value::String(value.into())
}

#[test]
fn source_frontmatter_merges_alongside_vault_keys_and_preserves_nn_siblings() {
    let mut nn = Mapping::new();
    nn.insert(key("distil"), Value::String("keep-me".into()));
    let mut root = Mapping::new();
    root.insert(key("title"), Value::String("Existing title".into()));
    root.insert(key("custom"), Value::Bool(true));
    root.insert(key("nn"), Value::Mapping(nn));

    let merged = merge_nn_source(&Value::Mapping(root), &valid_source()).unwrap();
    let root = merged.as_mapping().unwrap();
    assert_eq!(
        root.get(key("title")).and_then(Value::as_str),
        Some("Existing title")
    );
    assert_eq!(root.get(key("custom")), Some(&Value::Bool(true)));
    let nn = root.get(key("nn")).and_then(Value::as_mapping).unwrap();
    assert_eq!(
        nn.get(key("distil")).and_then(Value::as_str),
        Some("keep-me")
    );
    let source = nn.get(key("source")).and_then(Value::as_mapping).unwrap();
    assert_eq!(
        source.get(key("type")).and_then(Value::as_str),
        Some("youtube")
    );
    assert_eq!(
        source.get(key("content_hash")).and_then(Value::as_str),
        Some("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    );
}

#[test]
fn source_frontmatter_inserts_nn_when_absent() {
    let mut root = Mapping::new();
    root.insert(key("tags"), Value::Sequence(vec![key("rust")]));

    let merged = merge_nn_source(&Value::Mapping(root), &valid_source()).unwrap();
    assert!(merged
        .as_mapping()
        .and_then(|mapping| mapping.get(key("nn")))
        .and_then(Value::as_mapping)
        .and_then(|nn| nn.get(key("source")))
        .is_some());
}

#[test]
fn source_frontmatter_yaml_round_trip_preserves_hostile_valid_strings() {
    let hostile_title = "- starts like a list\n: looks like a mapping\n\"quoted title\"";
    let hostile_aliases = ["- leading dash", ": leading colon", "\"literal quotes\""];
    let mut root = Mapping::new();
    root.insert(key("title"), Value::String(hostile_title.into()));
    root.insert(
        key("aliases"),
        Value::Sequence(
            hostile_aliases
                .iter()
                .map(|value| Value::String((*value).into()))
                .collect(),
        ),
    );

    let merged = merge_nn_source(&Value::Mapping(root), &valid_source()).unwrap();
    let encoded = serde_yaml_ng::to_string(&merged).unwrap();
    let decoded: Value = serde_yaml_ng::from_str(&encoded).unwrap();

    assert_eq!(decoded, merged);
    assert_eq!(
        decoded
            .as_mapping()
            .and_then(|mapping| mapping.get(key("title")))
            .and_then(Value::as_str),
        Some(hostile_title)
    );
}

#[test]
fn source_frontmatter_rejects_non_maps_and_existing_source_conflicts() {
    let mut conflict_nn = Mapping::new();
    conflict_nn.insert(key("source"), Value::Mapping(Mapping::new()));
    let mut conflict_root = Mapping::new();
    conflict_root.insert(key("nn"), Value::Mapping(conflict_nn));
    let mut scalar_nn_root = Mapping::new();
    scalar_nn_root.insert(key("nn"), Value::String("bad".into()));

    for existing in [
        Value::Sequence(Vec::new()),
        Value::Mapping(scalar_nn_root),
        Value::Mapping(conflict_root),
    ] {
        assert!(matches!(
            merge_nn_source(&existing, &valid_source()),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }
}

#[test]
fn nn_source_validates_hash_timestamp_url_and_relative_full_source() {
    let valid_hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    for (url, captured_at, full_source, hash) in [
        ("", "2026-07-11T14:02:11Z", "source.vtt", valid_hash),
        ("https://", "2026-07-11T14:02:11Z", "source.vtt", valid_hash),
        (
            "https://example.com/with space",
            "2026-07-11T14:02:11Z",
            "source.vtt",
            valid_hash,
        ),
        (
            "https://example.com",
            "not-a-time",
            "source.vtt",
            valid_hash,
        ),
        (
            "https://example.com",
            "2026-07-11T14:02:11Z",
            "/tmp/source.vtt",
            valid_hash,
        ),
        (
            "https://example.com",
            "2026-07-11T14:02:11Z",
            "C:/source.vtt",
            valid_hash,
        ),
        (
            "https://example.com",
            "2026-07-11T14:02:11Z",
            "../source.vtt",
            valid_hash,
        ),
        (
            "https://example.com",
            "2026-07-11T14:02:11Z",
            "source.vtt",
            "sha256:abc",
        ),
    ] {
        assert!(matches!(
            NnSource::new(SourceType::Youtube, url, captured_at, full_source, hash),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }
}

#[test]
fn hosted_cost_uses_checked_ceil_four_thirds_tokens_and_model_price() {
    let estimate = estimate_transcript_cost(
        1_000,
        PricingInput::Hosted(ModelPricing {
            model: "provider/model".into(),
            input_usd_per_token: 0.000_003,
        }),
    )
    .unwrap();

    assert_eq!(estimate.word_count, 1_000);
    assert_eq!(estimate.estimated_tokens, 1_334);
    assert_eq!(estimate.model.as_deref(), Some("provider/model"));
    assert!((estimate.estimated_cost_usd.unwrap() - 0.004_002).abs() < f64::EPSILON);
    assert!(estimate.display.contains("$0.004002"));
    assert!(!estimate.method.contains('\n'));
    assert!(estimate.method.contains("ceil(words × 4 ÷ 3)"));
}

#[test]
fn local_cost_has_the_exact_free_display_and_still_reports_tokens() {
    let estimate = estimate_transcript_cost(3, PricingInput::Local).unwrap();

    assert_eq!(estimate.estimated_tokens, 4);
    assert_eq!(estimate.estimated_cost_usd, None);
    assert_eq!(estimate.display, "free — runs locally");
    assert!(!estimate.method.contains('\n'));
    assert!(estimate.method.contains("local inference"));
}

#[test]
fn cost_estimation_rejects_arithmetic_overflow_and_invalid_pricing() {
    assert!(matches!(
        estimate_transcript_cost(u64::MAX, PricingInput::Local),
        Err(CaptureError::InvalidMetadata(_))
    ));
    for input_usd_per_token in [-1.0, f64::NAN, f64::INFINITY] {
        assert!(matches!(
            estimate_transcript_cost(
                10,
                PricingInput::Hosted(ModelPricing {
                    model: "provider/model".into(),
                    input_usd_per_token,
                })
            ),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }
}
