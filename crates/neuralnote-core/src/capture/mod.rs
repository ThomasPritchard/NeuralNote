//! Pure capture policy and parsing shared by every NeuralNote client.

#[cfg(feature = "youtube-audio")]
pub mod audio;
pub mod cost;
pub mod error;
pub mod filename;
pub mod frontmatter;
pub mod profile;
pub mod routing;
pub mod transcript;
pub mod vault;
pub mod vtt;
pub mod youtube;
mod youtube_ids;

#[cfg(feature = "youtube-audio")]
pub use audio::{decode_m4a_to_wav, decode_m4a_to_wav_cancellable, youtube_audio_format_selector};
pub use cost::{estimate_transcript_cost, CostEstimate, ModelPricing, PricingInput};
pub use error::{CaptureAction, CaptureError, ExtractorUpdatePolicy};
pub use filename::{
    atomic_filename, literature_filename, transcript_filename, MAX_FILENAME_STEM_BYTES,
};
pub use frontmatter::{merge_nn_source, NnSource, SourceType};
pub use profile::{
    parse_vault_profile, serialize_vault_profile, MocPolicy, PersistedVaultScheme,
    SkillRoutingProfile, UnavailableVaultProfileIo, VaultProfile, VaultProfileIo,
    MAX_PROFILE_SKILLS, MAX_VAULT_PROFILE_BYTES, PROFILE_SCHEMA_VERSION,
};
pub use routing::{resolve_distil_route, RouteResolution};
pub use transcript::{
    render_transcript, render_youtube_transcript, RenderedTranscript, TranscriptProvenance,
};
pub use vault::{detect_vault_scheme, VaultFolder, VaultInventory, VaultNote, VaultScheme};
pub use vtt::{
    parse_vtt, Cue, MAX_VTT_BYTES, MAX_VTT_CUES, MAX_VTT_CUE_TEXT_BYTES, MAX_VTT_LINES,
    MAX_VTT_LINE_BYTES,
};
pub use youtube::{
    classify_ytdlp_failure, parse_playlist, parse_video_metadata, validate_thumbnail,
    validate_youtube_timestamp_url, CaptionInventory, CaptionSelection, CaptionSource, Playlist,
    PlaylistEntry, VideoId, VideoMetadata, YoutubeUrl, MAX_THUMBNAIL_BYTES,
};
