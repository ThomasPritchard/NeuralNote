# YouTube distil

Turn a YouTube video or selected playlist entries into durable, cited vault material. The transcript is the source record. Never rewrite it.

## Workflow

1. Call `fetch_video_info` before making claims about the source.
2. Call `fetch_captions` for English captions. If it reports `captions_absent`, ask before installing or using local Whisper. On first setup, say NeuralNote downloads pinned whisper.cpp source, compiles whisper-cli locally, requires Xcode Command Line Tools and CMake 3.28+, and can take several minutes. For later transcription runs, say transcription takes minutes, not seconds. Never offer Whisper after a block, PO-token warning, extractor failure, malformed VTT, or language mismatch.
3. For a playlist, call `select_playlist_videos`. Process the selected videos sequentially and keep already-written results if the user cancels.
   Use each selected video's zero-based order as `write_note.work_item` for every note attributable to that video. Shared playlist/MOC writes use work item 0.
4. Call `resolve_distil_route(topic)`. Treat its folder as a suggestion: read one or two returned neighbouring note paths, copy their real frontmatter and heading conventions, then make the final routing judgement.
5. You must never invent a folder without asking. If no existing route is suggested, ask the user.
6. Write one literature note and one timestamped transcript note per video. Use `write_note` and preserve the transcript's `[hh:mm:ss]` anchors and provenance line byte-for-byte.
7. Gather reusable ideas across the whole run before writing atomic notes. Atomic notes are concept-scoped, deduplicated against the vault and across the run, and use `status: seed` plus an honest seed callout. Link an existing concept note instead of creating a numbered duplicate.
8. If the detected convention uses MOCs, create or link a playlist MOC; otherwise do not invent one.
9. Announce every created path, explain why the folder fits, state caption or Whisper provenance, and invite the user to move anything. The report card and Undo cover only files actually created.

## Writing guidance

- Distil rather than transcribe in the literature note. Keep the transcript verbatim.
- Use `YYYY-MM-DD <Sentence-case title>.md` for literature, `<Concept>.md` for atomic notes, and the provided transcript filename policy.
- Use `## Summary`, `## Notes`, and `## Related` only when neighbouring notes use that structure.
- Prefer direct bold-lead-in bullets. Avoid inflated significance, generic conclusions, and a second polishing pass.
- Add NeuralNote's `nn.source.*` block alongside the vault's own keys. Do not replace them.
- For this slice, set `nn.source.full_source` to the vault-relative transcript note path. The hidden `.neuralnote/sources/` sidecar is deferred.
- Connect the source to existing notes when the evidence supports it. Do not fabricate names or repair garbled captions by guessing.
