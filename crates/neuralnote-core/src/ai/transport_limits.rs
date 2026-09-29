//! Local memory ceilings and byte readers for untrusted provider responses.

use crate::error::{CoreError, CoreResult};

pub const MAX_SSE_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TOOL_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BUFFERED_COMPLETION_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ANSWER_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ANSWER_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TOOL_CALLS: usize = 32;
pub const MAX_TOOL_ARGUMENT_BYTES: usize = 49 * 1024 * 1024;
pub const MAX_TOOL_RETAINED_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TOOL_CONTENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROVIDER_ERROR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SseLimits {
    pub max_frame_bytes: usize,
    pub max_total_bytes: usize,
}

impl SseLimits {
    pub const fn new(max_frame_bytes: usize, max_total_bytes: usize) -> Self {
        Self {
            max_frame_bytes,
            max_total_bytes,
        }
    }
}

impl Default for SseLimits {
    fn default() -> Self {
        Self::new(MAX_SSE_FRAME_BYTES, MAX_TOOL_RESPONSE_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolStreamLimits {
    pub max_calls: usize,
    pub max_call_argument_bytes: usize,
    pub max_total_retained_bytes: usize,
    pub max_content_bytes: usize,
}

impl ToolStreamLimits {
    pub const fn new(
        max_calls: usize,
        max_call_argument_bytes: usize,
        max_total_retained_bytes: usize,
        max_content_bytes: usize,
    ) -> Self {
        Self {
            max_calls,
            max_call_argument_bytes,
            max_total_retained_bytes,
            max_content_bytes,
        }
    }
}

impl Default for ToolStreamLimits {
    fn default() -> Self {
        Self::new(
            MAX_TOOL_CALLS,
            MAX_TOOL_ARGUMENT_BYTES,
            MAX_TOOL_RETAINED_BYTES,
            MAX_TOOL_CONTENT_BYTES,
        )
    }
}

/// A bounded byte buffer used for non-streaming provider responses.
#[derive(Debug)]
pub struct BoundedBytes {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl BoundedBytes {
    pub fn with_limit(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> CoreResult<()> {
        let next_len = reserve_bytes_bounded(
            &mut self.bytes,
            chunk.len(),
            self.max_bytes,
            "provider body",
        )?;
        self.bytes.extend_from_slice(chunk);
        debug_assert_eq!(self.bytes.len(), next_len);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Frames arbitrary transport chunks into newline-delimited SSE lines.
///
/// Only bytes after `scan_offset` are searched on a push. Completed lines are
/// removed in one compaction after they have been consumed.
#[derive(Debug)]
pub struct SseLineReader {
    buffer: Vec<u8>,
    scan_offset: usize,
    total_bytes: usize,
    limits: SseLimits,
}

impl SseLineReader {
    pub fn with_limits(limits: SseLimits) -> Self {
        Self {
            buffer: Vec::new(),
            scan_offset: 0,
            total_bytes: 0,
            limits,
        }
    }

    /// Add one transport chunk and pass each complete line to `consume`.
    /// Returns `true` when the consumer saw a terminal frame.
    pub fn push_bytes<F>(&mut self, chunk: &[u8], mut consume: F) -> CoreResult<bool>
    where
        F: FnMut(&[u8]) -> CoreResult<bool>,
    {
        self.check_chunk(chunk)?;
        reserve_bytes_bounded(
            &mut self.buffer,
            chunk.len(),
            self.limits.max_total_bytes,
            "provider stream",
        )?;
        self.buffer.extend_from_slice(chunk);
        self.total_bytes += chunk.len();

        let mut line_start = 0;
        let mut search_from = self.scan_offset;
        let mut compact_through = 0;
        while let Some(relative) = self.buffer[search_from..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let line_end = search_from + relative + 1;
            if consume(&self.buffer[line_start..line_end])? {
                self.buffer.clear();
                self.scan_offset = 0;
                return Ok(true);
            }
            line_start = line_end;
            search_from = line_end;
            compact_through = line_end;
        }
        self.scan_offset = self.buffer.len();
        if compact_through > 0 {
            self.buffer.drain(..compact_through);
            self.scan_offset -= compact_through;
        }
        Ok(false)
    }

    /// Pass the final unterminated line, if any, to `consume`.
    pub fn finish<F>(&mut self, mut consume: F) -> CoreResult<bool>
    where
        F: FnMut(&[u8]) -> CoreResult<bool>,
    {
        if self.buffer.is_empty() {
            return Ok(false);
        }
        let terminal = consume(&self.buffer)?;
        self.buffer.clear();
        self.scan_offset = 0;
        Ok(terminal)
    }

    fn check_chunk(&self, chunk: &[u8]) -> CoreResult<()> {
        checked_len(
            self.total_bytes,
            chunk.len(),
            self.limits.max_total_bytes,
            "provider response",
        )?;

        let mut frame_len = self.buffer.len();
        for segment in chunk.split_inclusive(|byte| *byte == b'\n') {
            frame_len = checked_len(
                frame_len,
                segment.len(),
                self.limits.max_frame_bytes,
                "provider SSE frame",
            )?;
            if segment.ends_with(b"\n") {
                frame_len = 0;
            }
        }
        Ok(())
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn pending_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn pending(&self) -> &[u8] {
        &self.buffer
    }
}

/// Reserve amortized geometric capacity without crossing the byte ceiling.
/// Vec/String allocators may round an exact request, but growth targets are capped.
pub(crate) fn reserve_bytes_bounded(
    buffer: &mut Vec<u8>,
    added: usize,
    limit: usize,
    subject: &str,
) -> CoreResult<usize> {
    let required = checked_len(buffer.len(), added, limit, subject)?;
    if required <= buffer.capacity() {
        return Ok(required);
    }
    let target = required
        .max(buffer.capacity().saturating_mul(2).min(limit))
        .min(limit);
    buffer
        .try_reserve_exact(target.saturating_sub(buffer.len()))
        .map_err(|error| CoreError::Llm(format!("could not retain {subject}: {error}")))?;
    Ok(required)
}

pub(crate) fn reserve_string_bounded(
    buffer: &mut String,
    added: usize,
    limit: usize,
    subject: &str,
) -> CoreResult<usize> {
    let required = checked_len(buffer.len(), added, limit, subject)?;
    if required <= buffer.capacity() {
        return Ok(required);
    }
    let target = required
        .max(buffer.capacity().saturating_mul(2).min(limit))
        .min(limit);
    buffer
        .try_reserve_exact(target.saturating_sub(buffer.len()))
        .map_err(|error| CoreError::Llm(format!("could not retain {subject}: {error}")))?;
    Ok(required)
}

pub(crate) fn checked_len(
    current: usize,
    added: usize,
    limit: usize,
    subject: &str,
) -> CoreResult<usize> {
    let next = current.checked_add(added).ok_or_else(|| {
        CoreError::Llm(format!("{subject} size overflowed its {limit}-byte limit"))
    })?;
    if next > limit {
        return Err(CoreError::Llm(format!(
            "{subject} exceeded its {limit}-byte limit"
        )));
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_frame_limit_is_checked_before_the_buffer_grows() {
        let mut reader = SseLineReader::with_limits(SseLimits::new(4, 8));
        let error = reader
            .push_bytes(b"12345", |_| Ok(false))
            .expect_err("an incomplete frame beyond the cap must fail");

        assert!(error.to_string().contains("4-byte"), "{error}");
        assert_eq!(
            reader.pending_len(),
            0,
            "rejected bytes must not be retained"
        );
        assert_eq!(reader.total_bytes(), 0, "rejected bytes must not count");
    }

    #[test]
    fn sse_reader_scans_new_bytes_and_preserves_fragmented_frames() {
        let mut reader = SseLineReader::with_limits(SseLimits::new(32, 64));
        let mut lines = Vec::new();
        for chunk in [b"data:".as_slice(), b" one".as_slice()] {
            reader
                .push_bytes(chunk, |line| {
                    lines.push(line.to_vec());
                    Ok(false)
                })
                .unwrap();
            assert_eq!(reader.scan_offset, reader.buffer.len());
        }
        reader
            .push_bytes(b"\ndata: two\npartial", |line| {
                lines.push(line.to_vec());
                Ok(false)
            })
            .unwrap();

        assert_eq!(lines, [b"data: one\n".to_vec(), b"data: two\n".to_vec()]);
        assert_eq!(reader.pending(), b"partial");
        assert_eq!(reader.total_bytes(), 27);
    }

    #[test]
    fn sse_total_limit_rejects_before_appending_the_overflowing_chunk() {
        let mut reader = SseLineReader::with_limits(SseLimits::new(8, 4));
        reader.push_bytes(b"a\n", |_| Ok(false)).unwrap();
        reader.push_bytes(b"b\n", |_| Ok(false)).unwrap();
        let error = reader
            .push_bytes(b"c", |_| Ok(false))
            .expect_err("the total response limit must be enforced");

        assert!(error.to_string().contains("4-byte"), "{error}");
        assert_eq!(reader.total_bytes(), 4);
        assert_eq!(reader.pending_len(), 0);
    }

    #[test]
    fn bounded_growth_reuses_capacity_for_empty_and_small_appends() {
        let mut bytes = BoundedBytes::with_limit(32);
        bytes.push(b"a").unwrap();
        let byte_capacity = bytes.bytes.capacity();
        bytes.push(b"").unwrap();
        assert_eq!(bytes.bytes.capacity(), byte_capacity);
        bytes.push(b"b").unwrap();
        let byte_capacity = bytes.bytes.capacity();
        bytes.push(b"").unwrap();
        assert_eq!(bytes.bytes.capacity(), byte_capacity);

        let mut text = String::new();
        reserve_string_bounded(&mut text, 1, 32, "test string").unwrap();
        text.push('a');
        let text_capacity = text.capacity();
        reserve_string_bounded(&mut text, 0, 32, "test string").unwrap();
        assert_eq!(text.capacity(), text_capacity);
        reserve_string_bounded(&mut text, 1, 32, "test string").unwrap();
        text.push('b');
        let text_capacity = text.capacity();
        reserve_string_bounded(&mut text, 0, 32, "test string").unwrap();
        assert_eq!(text.capacity(), text_capacity);
    }

    #[test]
    fn bounded_byte_accumulator_keeps_the_exact_limit_and_rejects_more() {
        let mut body = BoundedBytes::with_limit(4);
        body.push(b"ab").unwrap();
        body.push(b"cd").unwrap();
        let error = body
            .push(b"e")
            .expect_err("a buffered provider body must not exceed its cap");

        assert!(error.to_string().contains("4-byte"), "{error}");
        assert_eq!(body.as_slice(), b"abcd");
    }
}
