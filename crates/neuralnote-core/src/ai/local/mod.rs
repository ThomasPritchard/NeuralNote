//! Local-AI model selection and metadata shared by the desktop shell.
//!
//! Phase 1 is deliberately pure: hardware facts come from the host, this module
//! only ranks curated models and serialises the recommendation contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod hf;
pub mod pull;
pub mod tags;

pub const DEFAULT_LOCAL_MODEL: &str = "qwen3.5:9b";

// ── POLICY (tunable) ──
// Fraction of total RAM we treat as usable for the model. 0.70 is conservative for
// Apple-Silicon unified memory (the GPU can address most of it) and stays a safe
// headroom on Intel/CPU Macs too — so the same policy generalises across machines
// without per-host tuning. Lower it to be more cautious; raise it to push bigger models.
const USABLE_MEM_FRACTION: f64 = 0.70;
const SUPPORTED_OS: &str = "macos"; // v1 is macOS-only
const UNSUPPORTED_SPECS: &str = "Local AI is unsupported due to your computer specs.";
const UNSUPPORTED_PLATFORM: &str = "Local AI isn't supported on this platform yet.";
const UNDETECTED_HARDWARE: &str =
    "Couldn't read your computer's memory to size a local model. Please try again.";
// ── end POLICY ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HardwareSpec {
    pub total_ram_bytes: u64,
    pub cpu_cores: usize,
    pub cpu_brand: String,
    pub gpu_label: Option<String>,
    pub arch: String,
    pub os: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CandidateModel {
    pub tag: String,
    pub params: String,
    pub download_bytes: u64,
    pub min_ram_bytes: u64,
    pub license: String,
    pub hf_repo: String,
    /// Numeric parameter count in billions — the size axis for ranking (the `params`
    /// string is display-only). Recommender-internal, not part of the JS contract.
    #[serde(skip)]
    pub params_b: f32,
    /// Recommendation preference rank: higher = newer generation / stronger
    /// tool-caller, preferred as the default when it fits. Same for every size of a
    /// family, so `(generation, params_b)` selects the newest family, largest fitting
    /// size. Recommender-internal, not part of the JS contract.
    #[serde(skip)]
    pub generation: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Recommendation {
    Supported {
        model_tag: String,
        params: String,
        est_ram_bytes: u64,
        why: String,
    },
    Unsupported {
        reason: String,
    },
}

// Generation/preference ranks (higher = newer, preferred as the default when it
// fits). Same for every size in a family, so `(generation, params_b)` picks the
// newest family, then its largest fitting size. Both current families are 2026,
// Apache-2.0, and verified tool-callers (smoke-tested against search_notes); Qwen3.5
// leads as the strongest all-round tool-caller, Granite 4.1 is the efficiency-per-GB
// alternative that reaches down to smaller machines.
const GEN_QWEN35: u16 = 40;
const GEN_GRANITE41: u16 = 30;

/// The curated, tool-calling-capable local models the app may install, spanning RAM
/// tiers from ~8 GB machines up to workstations. Two families only — both current,
/// both Apache-2.0, both verified to emit well-formed tool calls (the moat: cited
/// chat depends on tool-calling). Sizes/RAM are conservative estimates (Q4 weights +
/// 32K-context KV headroom) so a recommendation runs *well* on any machine, not just
/// barely — see `recommend_model`. Keep this list current: newer generations should
/// be added with a higher `generation` rank and only after a tool-calling smoke test.
pub fn curated_candidates() -> Vec<CandidateModel> {
    vec![
        // ── Qwen3.5 — primary ladder (best all-round tool-caller) ──
        CandidateModel {
            tag: "qwen3.5:4b".into(),
            params: "4B".into(),
            params_b: 4.0,
            generation: GEN_QWEN35,
            download_bytes: 3_400_000_000,
            min_ram_bytes: 7_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen3.5-4B".into(),
        },
        CandidateModel {
            tag: "qwen3.5:9b".into(),
            params: "9B".into(),
            params_b: 9.0,
            generation: GEN_QWEN35,
            download_bytes: 6_600_000_000,
            min_ram_bytes: 11_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen3.5-9B".into(),
        },
        CandidateModel {
            tag: "qwen3.5:27b".into(),
            params: "27B".into(),
            params_b: 27.0,
            generation: GEN_QWEN35,
            download_bytes: 17_000_000_000,
            min_ram_bytes: 26_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen3.5-27B".into(),
        },
        // ── Granite 4.1 — efficiency-per-GB alternative (reaches smaller machines) ──
        CandidateModel {
            tag: "granite4.1:3b".into(),
            params: "3B".into(),
            params_b: 3.0,
            generation: GEN_GRANITE41,
            download_bytes: 2_100_000_000,
            min_ram_bytes: 5_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "ibm-granite/granite-4.1-3b".into(),
        },
        CandidateModel {
            tag: "granite4.1:8b".into(),
            params: "8B".into(),
            params_b: 8.0,
            generation: GEN_GRANITE41,
            download_bytes: 5_300_000_000,
            min_ram_bytes: 10_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "ibm-granite/granite-4.1-8b".into(),
        },
        CandidateModel {
            tag: "granite4.1:30b".into(),
            params: "30B".into(),
            params_b: 30.0,
            generation: GEN_GRANITE41,
            download_bytes: 17_000_000_000,
            min_ram_bytes: 28_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "ibm-granite/granite-4.1-30b".into(),
        },
    ]
}

/// Whether `tag` is a curated, tool-calling-capable model the app is allowed to
/// install/select/chat against. The allowlist is the moat's guardrail: pulling an
/// arbitrary Ollama tag can yield a model with no tool-calling template, silently
/// breaking cited chat. Enforced in Rust (not just the UI) so a non-UI caller — or
/// a hand-edited config — can't slip a non-curated model into the chat path.
pub fn is_curated_model(tag: &str) -> bool {
    curated_candidates().iter().any(|c| c.tag == tag)
}

/// Whether an installed Ollama tag satisfies the user's selected model tag.
///
/// Curated tags are explicit (e.g. `qwen3.5:9b`), but Ollama may store a bare
/// name as `name:latest`. A match holds when the two are equal, or when one side
/// carries an explicit `:latest` suffix that the other spells without it — the
/// suffix is matched symmetrically, so it doesn't matter whether the installed
/// listing or the selected tag is the one tagged `:latest`. Used to pre-flight the
/// local model before a chat turn so a present-but-differently-spelled tag isn't
/// mistaken for "not installed".
pub fn model_installed(installed: &str, wanted: &str) -> bool {
    installed == wanted
        || installed.strip_suffix(":latest") == Some(wanted)
        || wanted.strip_suffix(":latest") == Some(installed)
}

/// Pick the best local model for this machine, or explain why none fits.
///
/// Policy (newest-first, spec-balanced — generalises to any machine, no per-host
/// tuning): RAM is the hard gate, applied first, so the pick always fits. Among the
/// models that fit, prefer the newest / strongest-tool-calling generation, then the
/// largest size within it — i.e. a current-gen model at the biggest size the machine
/// can run, falling back to an older or smaller one only when nothing newer/larger
/// fits. The allowlist itself sets the quality floor (its smallest entry is the
/// smallest model we trust for cited chat), so a machine that can't run even that is
/// told so honestly rather than handed a model that would thrash or mis-cite.
pub fn recommend_model(spec: &HardwareSpec, candidates: &[CandidateModel]) -> Recommendation {
    if spec.os != SUPPORTED_OS {
        return Recommendation::Unsupported {
            reason: UNSUPPORTED_PLATFORM.into(),
        };
    }
    // Detection can fail on unusual machines (sysinfo reports 0); don't misreport
    // that as "weak specs" — say so honestly so odd hosts get a truthful message.
    if spec.total_ram_bytes == 0 {
        return Recommendation::Unsupported {
            reason: UNDETECTED_HARDWARE.into(),
        };
    }

    let usable = (spec.total_ram_bytes as f64 * USABLE_MEM_FRACTION) as u64;
    candidates
        .iter()
        .filter(|c| c.min_ram_bytes <= usable)
        .max_by(|a, b| {
            a.generation.cmp(&b.generation).then_with(|| {
                a.params_b
                    .partial_cmp(&b.params_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .map(|c| Recommendation::Supported {
            model_tag: c.tag.clone(),
            params: c.params.clone(),
            est_ram_bytes: c.min_ram_bytes,
            why: format!(
                "The newest model that runs well in your {} GB of usable memory.",
                usable / 1_000_000_000
            ),
        })
        .unwrap_or_else(|| Recommendation::Unsupported {
            reason: UNSUPPORTED_SPECS.into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gib(n: u64) -> u64 {
        n * 1024 * 1024 * 1024
    }

    fn spec(ram_gib: u64, os: &str) -> HardwareSpec {
        HardwareSpec {
            total_ram_bytes: gib(ram_gib),
            cpu_cores: 8,
            cpu_brand: "Apple M-series".into(),
            gpu_label: Some("Apple GPU".into()),
            arch: "aarch64".into(),
            os: os.into(),
        }
    }

    fn tag_for(ram_gib: u64) -> String {
        match recommend_model(&spec(ram_gib, "macos"), &curated_candidates()) {
            Recommendation::Supported { model_tag, .. } => model_tag,
            other => panic!("expected supported recommendation at {ram_gib} GiB, got {other:?}"),
        }
    }

    #[test]
    fn four_gib_macos_is_unsupported_by_specs() {
        // Below the smallest curated model — told honestly, not handed a model that
        // would thrash.
        assert_eq!(
            recommend_model(&spec(4, "macos"), &curated_candidates()),
            Recommendation::Unsupported {
                reason: UNSUPPORTED_SPECS.into()
            }
        );
    }

    #[test]
    fn eight_gib_gets_the_small_efficient_model() {
        // 8 GB can't run a 4B well with a 32K window, so the efficient 3B (Granite)
        // is the right, safe pick — generalises to the common laptop.
        assert_eq!(tag_for(8), "granite4.1:3b");
    }

    #[test]
    fn sixteen_gib_gets_the_newest_mid_model() {
        // Both granite4.1:8b and qwen3.5:9b fit; newest generation + larger size wins.
        assert_eq!(tag_for(16), "qwen3.5:9b");
    }

    #[test]
    fn a_large_machine_prefers_the_newest_family_over_a_bigger_older_one() {
        // At 48 GB both qwen3.5:27b and granite4.1:30b fit. Newest-first: the 27B
        // current-gen model is chosen over the physically larger older-gen 30B.
        assert_eq!(tag_for(48), "qwen3.5:27b");
    }

    #[test]
    fn newest_generation_beats_a_bigger_older_model_that_also_fits() {
        // Policy proof, independent of the live allowlist: a newer, smaller model is
        // preferred over an older, larger one when both fit RAM.
        let candidates = vec![
            CandidateModel {
                tag: "old-big:14b".into(),
                params: "14B".into(),
                params_b: 14.0,
                generation: 10,
                download_bytes: 9_000_000_000,
                min_ram_bytes: 8_000_000_000,
                license: "Apache-2.0".into(),
                hf_repo: "x/old".into(),
            },
            CandidateModel {
                tag: "new-small:9b".into(),
                params: "9B".into(),
                params_b: 9.0,
                generation: 40,
                download_bytes: 6_000_000_000,
                min_ram_bytes: 8_000_000_000,
                license: "Apache-2.0".into(),
                hf_repo: "x/new".into(),
            },
        ];
        assert!(matches!(
            recommend_model(&spec(32, "macos"), &candidates),
            Recommendation::Supported { model_tag, .. } if model_tag == "new-small:9b"
        ));
    }

    #[test]
    fn recommendation_generalises_and_never_shrinks_with_more_ram() {
        // Across the full range of machines, every recommendation is a curated tag
        // that actually fits usable memory, and adding RAM never yields a SMALLER
        // model — proof the policy generalises to any host, not just one dev machine.
        let candidates = curated_candidates();
        let mut last_params = 0.0_f32;
        for ram in [8, 12, 16, 24, 32, 36, 48, 64, 128] {
            let usable = (gib(ram) as f64 * USABLE_MEM_FRACTION) as u64;
            match recommend_model(&spec(ram, "macos"), &candidates) {
                Recommendation::Supported {
                    model_tag,
                    est_ram_bytes,
                    ..
                } => {
                    let c = candidates
                        .iter()
                        .find(|c| c.tag == model_tag)
                        .expect("curated");
                    assert!(is_curated_model(&model_tag));
                    assert!(est_ram_bytes <= usable, "{model_tag} must fit {ram} GiB");
                    assert!(
                        c.params_b >= last_params,
                        "more RAM ({ram} GiB) picked a smaller model {model_tag}"
                    );
                    last_params = c.params_b;
                }
                other => panic!("expected a recommendation at {ram} GiB, got {other:?}"),
            }
        }
    }

    #[test]
    fn zero_ram_is_a_detection_failure_not_weak_specs() {
        // sysinfo can report 0 on an unusual host; that's a detection failure, not
        // "your computer is too weak" — say so distinctly so it generalises honestly.
        assert_eq!(
            recommend_model(&spec(0, "macos"), &curated_candidates()),
            Recommendation::Unsupported {
                reason: UNDETECTED_HARDWARE.into()
            }
        );
    }

    #[test]
    fn non_macos_platforms_are_unsupported() {
        for os in ["windows", "linux"] {
            assert_eq!(
                recommend_model(&spec(64, os), &curated_candidates()),
                Recommendation::Unsupported {
                    reason: UNSUPPORTED_PLATFORM.into()
                }
            );
        }
    }

    #[test]
    fn empty_candidates_on_macos_are_unsupported_by_specs() {
        assert_eq!(
            recommend_model(&spec(64, "macos"), &[]),
            Recommendation::Unsupported {
                reason: UNSUPPORTED_SPECS.into()
            }
        );
    }

    #[test]
    fn curated_candidates_are_current_apache_tool_callers() {
        let candidates = curated_candidates();
        let tags: Vec<_> = candidates.iter().map(|c| c.tag.as_str()).collect();

        assert_eq!(
            tags,
            vec![
                "qwen3.5:4b",
                "qwen3.5:9b",
                "qwen3.5:27b",
                "granite4.1:3b",
                "granite4.1:8b",
                "granite4.1:30b",
            ]
        );
        // Every entry is fully specified: real RAM/size figures and a generation rank.
        assert!(candidates
            .iter()
            .all(|c| c.min_ram_bytes > 0 && c.params_b > 0.0 && c.generation > 0));
        // v1 curation is all-Apache-2.0 (no licence friction across machines/users).
        assert!(candidates.iter().all(|c| c.license == "Apache-2.0"));
        assert!(tags.contains(&DEFAULT_LOCAL_MODEL));

        match recommend_model(&spec(16, "macos"), &candidates) {
            Recommendation::Supported { why, .. } => {
                assert!(why.contains("memory"));
            }
            other => panic!("expected supported recommendation, got {other:?}"),
        }
    }

    #[test]
    fn is_curated_model_accepts_only_allowlisted_tags() {
        // Every curated tag is accepted…
        for candidate in curated_candidates() {
            assert!(
                is_curated_model(&candidate.tag),
                "{} should be curated",
                candidate.tag
            );
        }
        assert!(is_curated_model(DEFAULT_LOCAL_MODEL));
        // …and anything off the allowlist is rejected, including near-misses that a
        // non-UI caller might try to slip past the moat guardrail.
        for tag in [
            "",
            "qwen3.5",                  // bare name, no size tag
            "qwen3.5:9b-instruct-q2_K", // arbitrary quant
            "qwen3.5:80b",              // not offered
            "codellama:7b",             // no tool-calling template
            "../etc/passwd",
        ] {
            assert!(!is_curated_model(tag), "{tag} must not be curated");
        }
    }

    #[test]
    fn model_installed_matches_exact_and_latest_suffix_either_side() {
        // Plain equality — the common case, an explicit tag on both sides.
        assert!(model_installed("qwen3.5:9b", "qwen3.5:9b"));
        // Ollama stored the bare name as `:latest`; the selected tag is bare.
        assert!(model_installed("qwen3.5:latest", "qwen3.5"));
        // Symmetric: the selection carries `:latest`, the installed tag is bare.
        assert!(model_installed("granite4.1:8b", "granite4.1:8b:latest"));
        // A genuine mismatch stays a mismatch — a different model isn't "installed".
        assert!(!model_installed("qwen3.5:9b", "granite4.1:8b"));
    }

    #[test]
    fn serde_uses_camel_case_and_hides_internal_fields() {
        let unsupported = serde_json::to_value(Recommendation::Unsupported {
            reason: "nope".into(),
        })
        .unwrap();
        assert_eq!(unsupported["status"], "unsupported");
        assert_eq!(unsupported["reason"], "nope");

        let supported = serde_json::to_value(Recommendation::Supported {
            model_tag: "qwen3.5:9b".into(),
            params: "9B".into(),
            est_ram_bytes: 11_000_000_000,
            why: "fits memory".into(),
        })
        .unwrap();
        assert_eq!(supported["status"], "supported");
        assert_eq!(supported["modelTag"], "qwen3.5:9b");
        assert_eq!(supported["estRamBytes"], 11_000_000_000_u64);

        let spec = serde_json::to_value(spec(8, "macos")).unwrap();
        assert!(spec.get("totalRamBytes").is_some());

        let candidate = serde_json::to_value(&curated_candidates()[0]).unwrap();
        assert!(candidate.get("minRamBytes").is_some());
        assert!(candidate.get("downloadBytes").is_some());
        assert!(candidate.get("hfRepo").is_some());
        // Recommender-internal fields stay out of the JS contract.
        assert!(candidate.get("paramsB").is_none());
        assert!(candidate.get("generation").is_none());
    }
}
