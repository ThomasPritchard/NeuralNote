//! Local-AI model selection and metadata shared by the desktop shell.
//!
//! Phase 1 is deliberately pure: hardware facts come from the host, this module
//! only ranks curated models and serialises the recommendation contract.

use serde::{Deserialize, Serialize};

pub mod hf;
pub mod pull;
pub mod tags;

pub const DEFAULT_LOCAL_MODEL: &str = "qwen2.5:7b";

// ── POLICY (tunable) ──
const USABLE_MEM_FRACTION: f64 = 0.70; // Apple-Silicon unified memory; conservative
const SUPPORTED_OS: &str = "macos"; // v1 is macOS-only
const UNSUPPORTED_SPECS: &str = "Local AI is unsupported due to your computer specs.";
const UNSUPPORTED_PLATFORM: &str = "Local AI isn't supported on this platform yet.";
// ── end POLICY ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSpec {
    pub total_ram_bytes: u64,
    pub cpu_cores: usize,
    pub cpu_brand: String,
    pub gpu_label: Option<String>,
    pub arch: String,
    pub os: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateModel {
    pub tag: String,
    pub params: String,
    pub download_bytes: u64,
    pub min_ram_bytes: u64,
    pub license: String,
    pub hf_repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

pub fn curated_candidates() -> Vec<CandidateModel> {
    vec![
        CandidateModel {
            tag: "llama3.2:1b".into(),
            params: "1.2B".into(),
            download_bytes: 1_300_000_000,
            min_ram_bytes: 4_000_000_000,
            license: "Llama 3.2".into(),
            hf_repo: "meta-llama/Llama-3.2-1B-Instruct".into(),
        },
        CandidateModel {
            tag: "llama3.2:3b".into(),
            params: "3.2B".into(),
            download_bytes: 2_000_000_000,
            min_ram_bytes: 6_000_000_000,
            license: "Llama 3.2".into(),
            hf_repo: "meta-llama/Llama-3.2-3B-Instruct".into(),
        },
        CandidateModel {
            tag: "qwen2.5:3b".into(),
            params: "3.1B".into(),
            download_bytes: 1_900_000_000,
            min_ram_bytes: 6_000_000_000,
            license: "Qwen Research".into(),
            hf_repo: "Qwen/Qwen2.5-3B-Instruct".into(),
        },
        CandidateModel {
            tag: "qwen2.5:7b".into(),
            params: "7.6B".into(),
            download_bytes: 4_700_000_000,
            min_ram_bytes: 10_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen2.5-7B-Instruct".into(),
        },
        CandidateModel {
            tag: "llama3.1:8b".into(),
            params: "8B".into(),
            download_bytes: 4_900_000_000,
            min_ram_bytes: 11_000_000_000,
            license: "Llama 3.1".into(),
            hf_repo: "meta-llama/Llama-3.1-8B-Instruct".into(),
        },
        CandidateModel {
            tag: "qwen2.5:14b".into(),
            params: "14.8B".into(),
            download_bytes: 9_000_000_000,
            min_ram_bytes: 16_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen2.5-14B-Instruct".into(),
        },
        CandidateModel {
            tag: "qwen2.5:32b".into(),
            params: "32.8B".into(),
            download_bytes: 20_000_000_000,
            min_ram_bytes: 28_000_000_000,
            license: "Apache-2.0".into(),
            hf_repo: "Qwen/Qwen2.5-32B-Instruct".into(),
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

pub fn recommend_model(spec: &HardwareSpec, candidates: &[CandidateModel]) -> Recommendation {
    if spec.os != SUPPORTED_OS {
        return Recommendation::Unsupported {
            reason: UNSUPPORTED_PLATFORM.into(),
        };
    }

    let usable = (spec.total_ram_bytes as f64 * USABLE_MEM_FRACTION) as u64;
    candidates
        .iter()
        .filter(|c| c.min_ram_bytes <= usable)
        .max_by_key(|c| c.min_ram_bytes)
        .map(|c| Recommendation::Supported {
            model_tag: c.tag.clone(),
            params: c.params.clone(),
            est_ram_bytes: c.min_ram_bytes,
            why: format!(
                "Fits comfortably in your {} GB of usable memory.",
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

    #[test]
    fn four_gib_macos_is_unsupported_by_specs() {
        assert_eq!(
            recommend_model(&spec(4, "macos"), &curated_candidates()),
            Recommendation::Unsupported {
                reason: "Local AI is unsupported due to your computer specs.".into()
            }
        );
    }

    #[test]
    fn eight_gib_macos_recommends_a_three_b_model_that_fits() {
        let rec = recommend_model(&spec(8, "macos"), &curated_candidates());
        match rec {
            Recommendation::Supported {
                model_tag,
                est_ram_bytes,
                ..
            } => {
                assert!(["llama3.2:3b", "qwen2.5:3b"].contains(&model_tag.as_str()));
                assert_eq!(est_ram_bytes, 6_000_000_000);
                assert!(est_ram_bytes <= (gib(8) as f64 * 0.70) as u64);
            }
            other => panic!("expected supported recommendation, got {other:?}"),
        }
    }

    #[test]
    fn sixteen_gib_macos_recommends_largest_model_that_fits() {
        assert!(matches!(
            recommend_model(&spec(16, "macos"), &curated_candidates()),
            Recommendation::Supported {
                model_tag,
                est_ram_bytes: 11_000_000_000,
                ..
            } if model_tag == "llama3.1:8b"
        ));
    }

    #[test]
    fn sixty_four_gib_macos_recommends_largest_curated_model() {
        assert!(matches!(
            recommend_model(&spec(64, "macos"), &curated_candidates()),
            Recommendation::Supported {
                model_tag,
                est_ram_bytes: 28_000_000_000,
                ..
            } if model_tag == "qwen2.5:32b"
        ));
    }

    #[test]
    fn non_macos_platforms_are_unsupported() {
        for os in ["windows", "linux"] {
            assert_eq!(
                recommend_model(&spec(64, os), &curated_candidates()),
                Recommendation::Unsupported {
                    reason: "Local AI isn't supported on this platform yet.".into()
                }
            );
        }
    }

    #[test]
    fn empty_candidates_on_macos_are_unsupported_by_specs() {
        assert_eq!(
            recommend_model(&spec(64, "macos"), &[]),
            Recommendation::Unsupported {
                reason: "Local AI is unsupported due to your computer specs.".into()
            }
        );
    }

    #[test]
    fn curated_candidates_match_the_phase_one_table() {
        let candidates = curated_candidates();
        let tags: Vec<_> = candidates.iter().map(|c| c.tag.as_str()).collect();

        assert_eq!(
            tags,
            vec![
                "llama3.2:1b",
                "llama3.2:3b",
                "qwen2.5:3b",
                "qwen2.5:7b",
                "llama3.1:8b",
                "qwen2.5:14b",
                "qwen2.5:32b"
            ]
        );
        assert!(candidates.iter().all(|c| c.min_ram_bytes > 0));
        assert!(tags.contains(&DEFAULT_LOCAL_MODEL));

        let rec = recommend_model(&spec(16, "macos"), &candidates);
        match rec {
            Recommendation::Supported { why, .. } => {
                assert!(!why.is_empty());
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
            "qwen2.5",                  // bare name, no size tag
            "qwen2.5:7b-instruct-q2_K", // arbitrary quant
            "llama3.2:70b",             // not offered
            "codellama:7b",             // no tool-calling template
            "../etc/passwd",
        ] {
            assert!(!is_curated_model(tag), "{tag} must not be curated");
        }
    }

    #[test]
    fn serde_uses_camel_case_for_local_types() {
        let unsupported = serde_json::to_value(Recommendation::Unsupported {
            reason: "nope".into(),
        })
        .unwrap();
        assert_eq!(unsupported["status"], "unsupported");
        assert_eq!(unsupported["reason"], "nope");

        let supported = serde_json::to_value(Recommendation::Supported {
            model_tag: "qwen2.5:7b".into(),
            params: "7.6B".into(),
            est_ram_bytes: 10_000_000_000,
            why: "fits memory".into(),
        })
        .unwrap();
        assert_eq!(supported["status"], "supported");
        assert_eq!(supported["modelTag"], "qwen2.5:7b");
        assert_eq!(supported["estRamBytes"], 10_000_000_000_u64);

        let spec = serde_json::to_value(spec(8, "macos")).unwrap();
        assert!(spec.get("totalRamBytes").is_some());

        let candidate = serde_json::to_value(&curated_candidates()[0]).unwrap();
        assert!(candidate.get("minRamBytes").is_some());
        assert!(candidate.get("downloadBytes").is_some());
        assert!(candidate.get("hfRepo").is_some());
    }
}
