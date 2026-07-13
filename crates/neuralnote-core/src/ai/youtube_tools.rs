//! Model-facing schemas and dispatch policy for the YouTube distil skill.

use crate::ai::elicitation::{elicit_user, ElicitationOutcome};
use crate::ai::events::{ElicitOption, Elicitation};
use crate::ai::llm::UserPrompt;
use crate::ai::skills::{Eligibility, YOUTUBE_DISTIL_SKILL_ID};
use crate::ai::tools::{action, reject, ToolContext, ToolResult};
use crate::ai::youtube::{
    CaptionPayload, CaptionRequest, MetadataPayload, PotMode, YoutubeAnnotation, YoutubeIo,
    YoutubeToolSession, YoutubeUrl,
};
use crate::ai::youtube_tool_errors::{capture_reject, session_capture_reject};
use crate::capture::{
    estimate_transcript_cost, parse_video_metadata, parse_vtt, render_youtube_transcript,
    CaptionSource, CaptureAction, CaptureError, CostEstimate, PricingInput, RenderedTranscript,
    TranscriptProvenance, VideoMetadata,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlArgs {
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptionArgs {
    url: String,
    #[serde(default = "default_language")]
    lang: String,
}

fn default_language() -> String {
    "en".into()
}

pub(super) async fn dispatch_fetch_video_info(
    args_json: &str,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: UrlArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid fetch_video_info arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.url) {
        Ok(url) => url,
        Err(error) => return capture_reject(error),
    };
    let (io, session) = match youtube_services(context) {
        Ok(services) => services,
        Err(error) => return capture_reject(error),
    };
    if let Err(error) = session.validate_playlist_capture_url(&url) {
        return session_capture_reject(session, error);
    }
    let payload = match inspect_with_retry(io, session, &url).await {
        Ok(payload) => payload,
        Err(error) => return session_capture_reject(session, error),
    };
    let metadata = match parse_video_metadata(&payload.json) {
        Ok(metadata) => metadata,
        Err(error) => return session_capture_reject(session, error),
    };
    let metadata_video_id = match crate::capture::VideoId::new(&metadata.video_id) {
        Ok(video_id) => video_id,
        Err(error) => return session_capture_reject(session, error),
    };
    if let Err(error) = session.validate_playlist_video_id(&metadata_video_id) {
        return session_capture_reject(session, error);
    }
    let genuinely_absent = metadata.captions.is_genuinely_absent()
        && !payload
            .annotations
            .contains(&YoutubeAnnotation::SubtitleListingWithheld);
    let annotations = combined_annotations(session, payload.annotations);
    action(video_info_json(&metadata, &annotations, genuinely_absent).to_string())
}

pub(super) async fn dispatch_fetch_captions(
    args_json: &str,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: CaptionArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid fetch_captions arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.url) {
        Ok(url) => url,
        Err(error) => return capture_reject(error),
    };
    let language = args.lang.trim();
    if language.is_empty() || language.len() > 64 {
        return capture_reject(CaptureError::InvalidMetadata(
            "requested caption language must contain 1 to 64 bytes".into(),
        ));
    }
    let pricing = context.pricing.cloned();
    let (io, session) = match youtube_services(context) {
        Ok(services) => services,
        Err(error) => return capture_reject(error),
    };
    if let Err(error) = session.validate_playlist_capture_url(&url) {
        return session_capture_reject(session, error);
    }
    let (payload, metadata, video_id) = match inspect_validated_metadata(io, session, &url).await {
        Ok(value) => value,
        Err(error) => return session_capture_reject(session, error),
    };
    let selection = match prepare_caption_selection(
        session,
        &url,
        &metadata,
        video_id.clone(),
        payload.annotations,
        language,
    ) {
        Ok(selection) => selection,
        Err(error) => return session_capture_reject(session, error),
    };
    let request = CaptionRequest {
        url,
        language: selection.language.clone(),
        source: selection.source,
        pot: PotMode::Prefer,
    };
    let payload = match captions_with_retry(io, session, &request).await {
        Ok(payload) => payload,
        Err(error) => return session_capture_reject(session, error),
    };
    let rendered =
        match render_caption_payload(&payload, selection.source, &selection.language, &video_id) {
            Ok(rendered) => rendered,
            Err(error) => return session_capture_reject(session, error),
        };
    let mut annotations = combined_annotations(session, payload.annotations);
    let cost_estimate =
        transcript_cost_or_annotation(rendered.word_count, pricing, &mut annotations);
    action(
        json!({
            "video_id": metadata.video_id,
            "transcript": rendered.text,
            "word_count": rendered.word_count,
            "provenance": rendered.provenance,
            "annotations": annotations,
            "cost_estimate": cost_estimate,
        })
        .to_string(),
    )
}

async fn inspect_validated_metadata(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
) -> Result<(MetadataPayload, VideoMetadata, crate::capture::VideoId), CaptureError> {
    let payload = inspect_with_retry(io, session, url).await?;
    let metadata = parse_video_metadata(&payload.json)?;
    let video_id = crate::capture::VideoId::new(&metadata.video_id)?;
    session.validate_playlist_video_id(&video_id)?;
    Ok((payload, metadata, video_id))
}

fn prepare_caption_selection(
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
    metadata: &VideoMetadata,
    video_id: crate::capture::VideoId,
    annotations: Vec<YoutubeAnnotation>,
    language: &str,
) -> Result<crate::capture::CaptionSelection, CaptureError> {
    let listing_withheld = annotations.contains(&YoutubeAnnotation::SubtitleListingWithheld);
    for annotation in annotations {
        session.annotate(annotation.message());
    }
    if metadata.captions.is_genuinely_absent() {
        return handle_absent_captions(session, url, video_id, listing_withheld);
    }
    metadata.captions.select(language).ok_or_else(|| {
        CaptureError::InvalidMetadata(format!(
            "captions exist, but no '{language}' or base-language variant is available"
        ))
    })
}

fn handle_absent_captions(
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
    video_id: crate::capture::VideoId,
    listing_withheld: bool,
) -> Result<crate::capture::CaptionSelection, CaptureError> {
    if listing_withheld {
        return Err(CaptureError::InvalidMetadata(
            "caption listing was withheld after a PO-token warning, so caption absence is unproven"
                .into(),
        ));
    }
    session.mark_captions_absent(url, video_id);
    Err(CaptureError::CaptionsAbsent(
        "both human subtitles and automatic caption inventories are empty".into(),
    ))
}

pub(super) async fn dispatch_transcribe_audio(
    call_id: &str,
    args_json: &str,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: UrlArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid transcribe_audio arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.url) {
        Ok(url) => url,
        Err(error) => return capture_reject(error),
    };
    let (cancellation, video_id) = match transcription_authority(context, &url) {
        Ok(authority) => authority,
        Err(error) => return capture_reject(error),
    };
    let pricing = context.pricing.cloned();
    let optional_requirements = match context.skills.lookup(YOUTUBE_DISTIL_SKILL_ID) {
        Ok(manifest) => manifest.optional_requirements.clone(),
        Err(error) => return reject(error.to_string()),
    };
    if let Err(result) = ensure_whisper_available(
        call_id,
        &optional_requirements,
        user_prompt,
        context,
        &cancellation,
    )
    .await
    {
        return result;
    }
    let (io, session) = match youtube_services(context) {
        Ok(services) => services,
        Err(error) => return capture_reject(error),
    };
    let model = session.whisper_model();
    let payload = match transcription_with_retry(io, session, &url, model).await {
        Ok(payload) => payload,
        Err(error) => return session_capture_reject(session, error),
    };
    if session.cancellation().is_cancelled() {
        return capture_reject(CaptureError::Cancelled(
            "transcription was cancelled".into(),
        ));
    }
    let cues = match parse_vtt(&payload.vtt) {
        Ok(cues) => cues,
        Err(error) => return session_capture_reject(session, error),
    };
    let rendered = match render_youtube_transcript(
        &cues,
        &TranscriptProvenance::Whisper {
            model: model.to_string(),
        },
        &video_id,
    ) {
        Ok(rendered) => rendered,
        Err(error) => return session_capture_reject(session, error),
    };
    let mut annotations = combined_annotations(session, payload.annotations);
    let cost_estimate =
        transcript_cost_or_annotation(rendered.word_count, pricing, &mut annotations);
    action(
        json!({
            "transcript": rendered.text,
            "word_count": rendered.word_count,
            "provenance": rendered.provenance,
            "annotations": annotations,
            "cost_estimate": cost_estimate,
        })
        .to_string(),
    )
}

fn transcription_authority(
    context: &ToolContext<'_>,
    url: &YoutubeUrl,
) -> Result<
    (
        crate::ai::youtube::CaptureCancellation,
        crate::capture::VideoId,
    ),
    CaptureError,
> {
    let session = context.youtube_session.as_deref().ok_or_else(|| {
        CaptureError::RequirementMissing("YouTube per-run state is not wired".into())
    })?;
    if let Some(error) = session.terminal_error() {
        return Err(error.clone());
    }
    session.validate_playlist_capture_url(url)?;
    if !session.can_transcribe(url) {
        return Err(CaptureError::RequirementMissing(
            "caption absence has not been proven for this exact URL; call fetch_captions first"
                .into(),
        ));
    }
    if session.cancellation().is_cancelled() {
        return Err(CaptureError::Cancelled(
            "transcription was cancelled before it started".into(),
        ));
    }
    let video_id = session
        .transcription_video_id(url)
        .cloned()
        .ok_or_else(|| {
            CaptureError::RequirementMissing(
                "validated video id is missing for the proven caption absence".into(),
            )
        })?;
    Ok((session.cancellation().clone(), video_id))
}

async fn ensure_whisper_available(
    call_id: &str,
    requirements: &[crate::ai::skills::Requirement],
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
    cancellation: &crate::ai::youtube::CaptureCancellation,
) -> Result<(), ToolResult> {
    validate_whisper_disk(requirements, context).map_err(capture_reject)?;
    let eligibility = Eligibility::evaluate(requirements, context.environment);
    if eligibility.is_eligible() {
        return Ok(());
    }
    let question = whisper_install_question(call_id, &eligibility);
    match elicit_user(user_prompt, context.sink, question).await {
        ElicitationOutcome::Answered { chosen_ids } if chosen_ids.as_slice() == ["install"] => {}
        ElicitationOutcome::Answered { .. } => {
            return Err(capture_reject(CaptureError::Cancelled(
                "Whisper installation was declined".into(),
            )))
        }
        ElicitationOutcome::Rejected { error } => {
            return Err(reject(format!(
                "Whisper installation prompt failed: {error}"
            )))
        }
    }
    context
        .youtube_requirements
        .install_whisper_bundle(context.sink, cancellation)
        .await
        .map_err(capture_reject)
}

fn validate_whisper_disk(
    requirements: &[crate::ai::skills::Requirement],
    context: &ToolContext<'_>,
) -> Result<(), CaptureError> {
    let required = requirements
        .iter()
        .find_map(|requirement| match requirement {
            crate::ai::skills::Requirement::FreeDiskSpace { min_bytes } => Some(*min_bytes),
            _ => None,
        });
    if required.is_some_and(|required| context.environment.hardware.free_disk_bytes < required) {
        return Err(CaptureError::RequirementMissing(format!(
            "Whisper needs at least {} bytes of free disk space before installation",
            required.unwrap_or_default()
        )));
    }
    Ok(())
}

fn whisper_install_question(call_id: &str, eligibility: &Eligibility) -> Elicitation {
    Elicitation {
        id: format!("{call_id}:install-whisper"),
        question: format!(
            "Local transcription needs Whisper. NeuralNote will download the pinned v1.9.1 source, compile whisper-cli locally (this can take several minutes and requires Xcode Command Line Tools plus CMake 3.28+), then download the pinned small.en model. Install it now? Missing: {eligibility}"
        ),
        options: vec![
            ElicitOption {
                id: "install".into(),
                label: "Install Whisper".into(),
                description: Some("Compile locally and download the model.".into()),
                image_data_uri: None,
            },
            ElicitOption {
                id: "cancel".into(),
                label: "Not now".into(),
                description: None,
                image_data_uri: None,
            },
        ],
        multi_select: false,
    }
}

fn youtube_services<'a>(
    context: &'a mut ToolContext<'_>,
) -> Result<(&'a dyn YoutubeIo, &'a mut YoutubeToolSession), CaptureError> {
    let session = context.youtube_session.as_deref_mut().ok_or_else(|| {
        CaptureError::RequirementMissing("YouTube per-run state is not wired".into())
    })?;
    if let Some(error) = session.terminal_error() {
        return Err(error.clone());
    }
    Ok((context.youtube_io, session))
}

pub(super) fn validate_youtube_url(value: &str) -> Result<YoutubeUrl, CaptureError> {
    YoutubeUrl::new(value)
}

fn video_info_json(
    metadata: &VideoMetadata,
    annotations: &[String],
    genuinely_absent: bool,
) -> Value {
    json!({
        "video_id": metadata.video_id,
        "canonical_url": metadata.canonical_url,
        "title": metadata.title,
        "channel": metadata.channel,
        "duration_seconds": metadata.duration_seconds,
        "upload_date": metadata.upload_date,
        "caption_inventory": {
            "human": metadata.captions.human_languages(),
            "automatic": metadata.captions.automatic_languages(),
            "genuinely_absent": genuinely_absent,
        },
        "annotations": annotations,
    })
}

fn combined_annotations(
    session: &YoutubeToolSession,
    host_annotations: Vec<YoutubeAnnotation>,
) -> Vec<String> {
    session
        .annotations()
        .iter()
        .cloned()
        .chain(
            host_annotations
                .into_iter()
                .map(|annotation| annotation.message().to_string()),
        )
        .collect()
}

fn transcript_cost(
    word_count: u64,
    pricing: Option<PricingInput>,
) -> Result<Option<CostEstimate>, CaptureError> {
    pricing
        .map(|pricing| estimate_transcript_cost(word_count, pricing))
        .transpose()
}

fn transcript_cost_or_annotation(
    word_count: u64,
    pricing: Option<PricingInput>,
    annotations: &mut Vec<String>,
) -> Option<CostEstimate> {
    match transcript_cost(word_count, pricing) {
        Ok(estimate) => estimate,
        Err(error) => {
            annotations.push(format!(
                "cost estimate unavailable ({}); captured transcript was preserved",
                error.code()
            ));
            None
        }
    }
}

fn render_caption_payload(
    payload: &CaptionPayload,
    source: CaptionSource,
    language: &str,
    video_id: &crate::capture::VideoId,
) -> Result<RenderedTranscript, CaptureError> {
    let cues = parse_vtt(&payload.vtt)?;
    render_youtube_transcript(
        &cues,
        &TranscriptProvenance::Captions {
            language: language.to_string(),
            automatic: source == CaptionSource::Automatic,
        },
        video_id,
    )
}

async fn inspect_with_retry(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
) -> Result<MetadataPayload, CaptureError> {
    match io.inspect_metadata(url).await {
        Err(error) => match session.decide(&error) {
            CaptureAction::UpdateExtractorAndRetry => {
                update_extractor(io, session).await;
                io.inspect_metadata(url).await
            }
            _ => Err(error),
        },
        success => success,
    }
}

async fn captions_with_retry(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    request: &CaptionRequest,
) -> Result<CaptionPayload, CaptureError> {
    let mut attempt = request.clone();
    loop {
        match io.fetch_caption_vtt(&attempt).await {
            Ok(payload) => return Ok(payload),
            Err(error) => match session.decide(&error) {
                CaptureAction::UpdateExtractorAndRetry => {
                    update_extractor(io, session).await;
                }
                CaptureAction::ContinueWithoutPot if attempt.pot == PotMode::Prefer => {
                    annotate_pot_fallback(session, &error);
                    attempt.pot = PotMode::Disabled;
                }
                _ => return Err(error),
            },
        }
    }
}

async fn transcription_with_retry(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
    model: &str,
) -> Result<CaptionPayload, CaptureError> {
    match io
        .transcribe_audio(url, model, session.cancellation())
        .await
    {
        Err(_error) if session.cancellation().is_cancelled() => Err(CaptureError::Cancelled(
            "transcription was cancelled before a fallback retry".into(),
        )),
        Err(error) => match session.decide(&error) {
            CaptureAction::UpdateExtractorAndRetry => {
                update_extractor(io, session).await;
                if session.cancellation().is_cancelled() {
                    Err(CaptureError::Cancelled(
                        "transcription was cancelled during extractor update".into(),
                    ))
                } else {
                    io.transcribe_audio(url, model, session.cancellation())
                        .await
                }
            }
            _ => Err(error),
        },
        success => success,
    }
}

pub(super) async fn update_extractor(io: &dyn YoutubeIo, session: &mut YoutubeToolSession) {
    if let Err(error) = io.update_extractor().await {
        session.annotate(format!(
            "yt-dlp update failed ({}); continued with the current binary",
            error.code()
        ));
    }
}

fn annotate_pot_fallback(session: &mut YoutubeToolSession, error: &CaptureError) {
    debug_assert!(matches!(error, CaptureError::PotUnavailable(_)));
    session.annotate("optional POT sidecar unavailable; continued without POT");
}
