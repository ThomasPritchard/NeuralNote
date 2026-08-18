//! Model-facing schemas and dispatch policy for the YouTube distil skill.

use crate::ai::call_channel::CallChannel;
use crate::ai::elicitation::{elicit_user, ElicitationOutcome};
use crate::ai::events::{ElicitOption, Elicitation};
use crate::ai::llm::UserPrompt;
use crate::ai::skills::{Eligibility, YOUTUBE_DISTIL_SKILL_ID};
use crate::ai::tools::{action, fail, reject, ToolContext, ToolResult};
use crate::ai::youtube::{
    CaptionPayload, CaptionRequest, MetadataPayload, PotMode, YoutubeAnnotation, YoutubeIo,
    YoutubeToolSession, YoutubeUrl,
};
use crate::ai::youtube_preview;
use crate::ai::youtube_tool_errors::{settle_capture_error, settle_session_capture_error};
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
    call_id: &str,
    args_json: &str,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: UrlArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid fetch_video_info arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.url) {
        Ok(url) => url,
        Err(error) => return settle_capture_error(error),
    };
    let mut work = match YoutubeWork::from_context(context, call_id) {
        Ok(work) => work,
        Err(error) => return settle_capture_error(error),
    };
    if let Err(error) = work.session.validate_playlist_capture_url(&url) {
        return settle_session_capture_error(work.session, error);
    }
    let payload = match inspect_with_retry(&mut work, &url).await {
        Ok(payload) => payload,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let metadata = match parse_video_metadata(&payload.json) {
        Ok(metadata) => metadata,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let metadata_video_id = match crate::capture::VideoId::new(&metadata.video_id) {
        Ok(video_id) => video_id,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    if let Err(error) = work.session.validate_playlist_video_id(&metadata_video_id) {
        return settle_session_capture_error(work.session, error);
    }
    // Only once every check has passed, so a video the run is about to refuse
    // never gets a card. The round beacon has already gone out, which is the
    // ordering `ChatEvent::VideoPreview` requires of its emitter.
    let preview = youtube_preview::video_preview(work.io, &metadata, &metadata_video_id).await;
    work.channel.video_preview(preview);
    let genuinely_absent = metadata.captions.is_genuinely_absent()
        && !payload
            .annotations
            .contains(&YoutubeAnnotation::SubtitleListingWithheld);
    let annotations = combined_annotations(work.session, payload.annotations);
    action(video_info_json(&metadata, &annotations, genuinely_absent).to_string())
}

pub(super) async fn dispatch_fetch_captions(
    call_id: &str,
    args_json: &str,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: CaptionArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid fetch_captions arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.url) {
        Ok(url) => url,
        Err(error) => return settle_capture_error(error),
    };
    let language = args.lang.trim();
    if language.is_empty() || language.len() > 64 {
        // `InvalidSource`, not `InvalidMetadata`: nothing has been fetched yet,
        // so there is no metadata to be invalid. This is the caller's own
        // argument check, and it has to read as a refusal (#116) — telling the
        // user something broke when the model sent `lang: ""` is the same wrong
        // story this split exists to remove, pointed the other way.
        return settle_capture_error(CaptureError::InvalidSource(
            "requested caption language must contain 1 to 64 bytes".into(),
        ));
    }
    let pricing = context.pricing.cloned();
    let mut work = match YoutubeWork::from_context(context, call_id) {
        Ok(work) => work,
        Err(error) => return settle_capture_error(error),
    };
    if let Err(error) = work.session.validate_playlist_capture_url(&url) {
        return settle_session_capture_error(work.session, error);
    }
    let (payload, metadata, video_id) = match inspect_validated_metadata(&mut work, &url).await {
        Ok(value) => value,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let selection = match prepare_caption_selection(
        work.session,
        &url,
        &metadata,
        video_id.clone(),
        payload.annotations,
        language,
    ) {
        Ok(selection) => selection,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let request = CaptionRequest {
        url,
        language: selection.language.clone(),
        source: selection.source,
        pot: PotMode::Prefer,
    };
    let payload = match captions_with_retry(&mut work, &request).await {
        Ok(payload) => payload,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let rendered =
        match render_caption_payload(&payload, selection.source, &selection.language, &video_id) {
            Ok(rendered) => rendered,
            Err(error) => return settle_session_capture_error(work.session, error),
        };
    let mut annotations = combined_annotations(work.session, payload.annotations);
    let cost_estimate =
        transcript_cost_or_annotation(rendered.word_count, pricing, &mut annotations);
    report_transcript_source(&mut work.channel, &rendered.provenance);
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

/// Report how a transcript was actually obtained, from the tool that obtained it.
/// The label is the same string the model receives, so the timeline and the model
/// can never disagree about provenance — and the UI never has to read it back out
/// of the model's prose. No note exists yet at this point, hence no `rel_path`.
fn report_transcript_source(channel: &mut CallChannel<'_>, provenance: &str) {
    channel.transcript_source(provenance);
}

async fn inspect_validated_metadata(
    work: &mut YoutubeWork<'_>,
    url: &YoutubeUrl,
) -> Result<(MetadataPayload, VideoMetadata, crate::capture::VideoId), CaptureError> {
    let payload = inspect_with_retry(work, url).await?;
    let metadata = parse_video_metadata(&payload.json)?;
    let video_id = crate::capture::VideoId::new(&metadata.video_id)?;
    work.session.validate_playlist_video_id(&video_id)?;
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
        Err(error) => return settle_capture_error(error),
    };
    let (cancellation, video_id) = match transcription_authority(context, &url) {
        Ok(authority) => authority,
        Err(error) => return settle_capture_error(error),
    };
    let pricing = context.pricing.cloned();
    let optional_requirements = match context.skills.lookup(YOUTUBE_DISTIL_SKILL_ID) {
        Ok(manifest) => manifest.optional_requirements.clone(),
        // The skill granted this tool, so its manifest must be in the registry.
        // A miss here is the catalogue coming apart underneath a running call,
        // not the model asking for something it may not have.
        Err(error) => return fail(error.to_string()),
    };
    // After `transcription_authority` above, which rejects a run whose YouTube
    // I/O is already blocked — announcing a check that a doomed run will never
    // perform is its own small lie. Still before the availability check itself,
    // because installing Whisper compiles it from source, so the wait starts
    // here rather than at the first audio frame.
    CallChannel::new(&mut *context.sink, call_id)
        .progress("Checking that local transcription is available");
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
    let mut work = match YoutubeWork::from_context(context, call_id) {
        Ok(work) => work,
        Err(error) => return settle_capture_error(error),
    };
    let model = work.session.whisper_model();
    work.channel.progress(format!(
        "Transcribing the audio locally with Whisper ({model}); this can take several minutes"
    ));
    let payload = match transcription_with_retry(&mut work, &url, model).await {
        Ok(payload) => payload,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    if work.session.cancellation().is_cancelled() {
        return settle_capture_error(CaptureError::Cancelled(
            "transcription was cancelled".into(),
        ));
    }
    let cues = match parse_vtt(&payload.vtt) {
        Ok(cues) => cues,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let rendered = match render_youtube_transcript(
        &cues,
        &TranscriptProvenance::Whisper {
            model: model.to_string(),
        },
        &video_id,
    ) {
        Ok(rendered) => rendered,
        Err(error) => return settle_session_capture_error(work.session, error),
    };
    let mut annotations = combined_annotations(work.session, payload.annotations);
    let cost_estimate =
        transcript_cost_or_annotation(rendered.word_count, pricing, &mut annotations);
    report_transcript_source(&mut work.channel, &rendered.provenance);
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
    validate_whisper_disk(requirements, context).map_err(settle_capture_error)?;
    let eligibility = Eligibility::evaluate(requirements, context.environment);
    if eligibility.is_eligible() {
        return Ok(());
    }
    let question = whisper_install_question(call_id, &eligibility);
    match elicit_user(user_prompt, context.sink, question).await {
        ElicitationOutcome::Answered { chosen_ids } if chosen_ids.as_slice() == ["install"] => {}
        ElicitationOutcome::Answered { .. } => {
            return Err(settle_capture_error(CaptureError::Cancelled(
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
        .map_err(settle_capture_error)
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

/// Everything one YouTube tool call needs at once: the host seam, the per-run
/// session, and its own channel to the user.
///
/// The three are bundled because the retry helpers need all three at the same
/// time, and a helper taking `&mut ToolContext` cannot coexist with a live borrow
/// of one of its fields. (Disjoint field borrows are perfectly legal — it is
/// passing them *into* a function that forces the bundle.) Carrying the channel
/// alongside is what stops a long tool from being unable to say anything while
/// it works: the seam existed, but only the io and the session were ever
/// reachable from inside a retry.
///
/// Constructing one asserts the run's YouTube I/O is still permitted, so the
/// fields are private and both constructors run [`Self::guard`]. They were
/// briefly public, and the struct literal in `youtube_selection` then bypassed
/// the terminal-error check — correct only because that caller happened to
/// repeat the check by hand nine lines earlier.
pub(super) struct YoutubeWork<'a> {
    pub(super) io: &'a dyn YoutubeIo,
    pub(super) session: &'a mut YoutubeToolSession,
    pub(super) channel: CallChannel<'a>,
    /// Private, and that is its entire job: a struct literal cannot name it from
    /// another module, so every `YoutubeWork` outside this file must come from a
    /// constructor — while `work.session` and `work.io` keep reading as fields.
    _gated: Gated,
}

/// Proof that [`YoutubeWork::guard`] ran. Unconstructible elsewhere.
struct Gated;

impl<'a> YoutubeWork<'a> {
    /// Build from a whole [`ToolContext`], splitting its three disjoint fields.
    fn from_context(
        context: &'a mut ToolContext<'_>,
        call_id: &'a str,
    ) -> Result<Self, CaptureError> {
        let session = context.youtube_session.as_deref_mut().ok_or_else(|| {
            CaptureError::RequirementMissing("YouTube per-run state is not wired".into())
        })?;
        Self::from_parts(context.youtube_io, session, &mut *context.sink, call_id)
    }

    /// Build from fields already borrowed out of a context — the shape a caller
    /// is left with when it holds a live reborrow and cannot hand the whole
    /// context over.
    pub(super) fn from_parts(
        io: &'a dyn YoutubeIo,
        session: &'a mut YoutubeToolSession,
        sink: &'a mut dyn crate::ai::events::EventSink,
        call_id: &'a str,
    ) -> Result<Self, CaptureError> {
        Self::guard(session)?;
        Ok(Self {
            io,
            session,
            channel: CallChannel::new(sink, call_id),
            _gated: Gated,
        })
    }

    /// A block-shaped failure earlier in the run stops all further YouTube I/O.
    fn guard(session: &YoutubeToolSession) -> Result<(), CaptureError> {
        match session.terminal_error() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
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

/// Every attempt below narrates itself before it goes out, retries included. A
/// retried network call that says nothing is not quieter than a hang — it is
/// indistinguishable from one, which is the whole complaint.
async fn inspect_with_retry(
    work: &mut YoutubeWork<'_>,
    url: &YoutubeUrl,
) -> Result<MetadataPayload, CaptureError> {
    work.channel.progress("Looking up the video on YouTube");
    match work.io.inspect_metadata(url).await {
        Err(error) => match work.session.decide(&error) {
            CaptureAction::UpdateExtractorAndRetry => {
                let update = update_extractor(work).await;
                work.channel.progress(update.retrying("the video lookup"));
                work.io.inspect_metadata(url).await
            }
            _ => Err(error),
        },
        success => success,
    }
}

async fn captions_with_retry(
    work: &mut YoutubeWork<'_>,
    request: &CaptionRequest,
) -> Result<CaptionPayload, CaptureError> {
    let mut attempt = request.clone();
    work.channel
        .progress(format!("Fetching the {} caption track", attempt.language));
    loop {
        match work.io.fetch_caption_vtt(&attempt).await {
            Ok(payload) => return Ok(payload),
            Err(error) => match work.session.decide(&error) {
                CaptureAction::UpdateExtractorAndRetry => {
                    let update = update_extractor(work).await;
                    work.channel.progress(update.retrying("the caption fetch"));
                }
                CaptureAction::ContinueWithoutPot if attempt.pot == PotMode::Prefer => {
                    annotate_pot_fallback(work.session, &error);
                    attempt.pot = PotMode::Disabled;
                    work.channel
                        .progress("Retrying the caption fetch without the optional POT sidecar");
                }
                _ => return Err(error),
            },
        }
    }
}

async fn transcription_with_retry(
    work: &mut YoutubeWork<'_>,
    url: &YoutubeUrl,
    model: &str,
) -> Result<CaptionPayload, CaptureError> {
    match work
        .io
        .transcribe_audio(url, model, work.session.cancellation())
        .await
    {
        Err(error) if work.session.cancellation().is_cancelled() => Err(cancelled_after(
            "transcription was cancelled before a fallback retry",
            &error,
        )),
        Err(error) => match work.session.decide(&error) {
            CaptureAction::UpdateExtractorAndRetry => {
                let update = update_extractor(work).await;
                if work.session.cancellation().is_cancelled() {
                    // No retry line here on purpose: nothing is about to be
                    // retried, and `update_extractor`'s own failure line is
                    // exactly what should be left standing.
                    Err(cancelled_after(
                        "transcription was cancelled during extractor update",
                        &error,
                    ))
                } else {
                    work.channel.progress(update.retrying("the transcription"));
                    work.io
                        .transcribe_audio(url, model, work.session.cancellation())
                        .await
                }
            }
            _ => Err(error),
        },
        success => success,
    }
}

/// A cancellation that interrupted an attempt which had ALREADY failed.
///
/// Both call sites above key on the cancellation *flag*, never on the cause — so
/// they fire identically whether the run was healthy when the user pressed Stop
/// or `whisper-cli` had just died. The flag cannot carry that difference and the
/// original error is the only thing that can, so it travels in the detail rather
/// than being dropped on the floor. `settle_capture_error` projects `detail()` to
/// both the model and the timeline, so this is where a crash that raced a Stop
/// stays visible.
///
/// It stays a `Cancelled`, not a `TranscriptionFailed`: the run is over either
/// way and the user asked for that, so the headline is still "the run ended".
/// What changes is that the headline is no longer the whole story.
fn cancelled_after(what_happened: &str, cause: &CaptureError) -> CaptureError {
    CaptureError::Cancelled(format!(
        "{what_happened}; the attempt in flight had already failed ({cause})"
    ))
}

/// Whether the host's `yt-dlp -U` actually landed.
///
/// Returned rather than swallowed because of how [`ChatEvent::ToolProgress`]
/// behaves: it is last-writer-wins, so the line a caller emits next is the one
/// the user is left looking at for the whole retry. A caller that cannot tell
/// the two outcomes apart can only guess, and the guess this code used to make
/// was "with the updated extractor" — asserting the update landed at the exact
/// moment it had not.
#[derive(Debug, Clone, Copy)]
pub(super) enum ExtractorUpdate {
    Applied,
    Failed { code: &'static str },
}

impl ExtractorUpdate {
    /// The line to leave standing while `what` is re-attempted.
    pub(super) fn retrying(self, what: &str) -> String {
        match self {
            Self::Applied => format!("Retrying {what} with the updated extractor"),
            Self::Failed { code } => {
                format!("yt-dlp update failed ({code}); retrying {what} on the current binary")
            }
        }
    }
}

/// Run the host's `yt-dlp -U`, which is a download and can take real time.
///
/// It announces itself on entry rather than only on failure, because the wait
/// happens either way. A failure is reported three ways on purpose, each for a
/// different reader: the log for whoever debugs it later, the channel for the
/// person watching the run stall, and the session annotation for the model and
/// the settled tool result. Only the log gets `detail()` — the other two carry
/// the code, which is the stable handle and cannot leak a host path.
pub(super) async fn update_extractor(work: &mut YoutubeWork<'_>) -> ExtractorUpdate {
    work.channel
        .progress("Updating yt-dlp; the extractor is out of date");
    let Err(error) = work.io.update_extractor().await else {
        return ExtractorUpdate::Applied;
    };
    let code = error.code();
    log::warn!("yt-dlp update failed ({code}): {}", error.detail());
    let detail = format!("yt-dlp update failed ({code}); continued with the current binary");
    // Emitted here as well as folded into `retrying` below, so the failure still
    // reaches the user on the one path that never retries — a run cancelled
    // during the update, where this is the last line anyone sees.
    work.channel.progress(detail.clone());
    work.session.annotate(detail);
    ExtractorUpdate::Failed { code }
}

fn annotate_pot_fallback(session: &mut YoutubeToolSession, error: &CaptureError) {
    debug_assert!(matches!(error, CaptureError::PotUnavailable(_)));
    session.annotate("optional POT sidecar unavailable; continued without POT");
}
