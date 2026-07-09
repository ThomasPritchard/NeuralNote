//! The template render engine.
//!
//! Pure text substitution: given template text and a [`TemplateContext`], expand
//! the whitelisted Obsidian core and Templater-subset variables. No filesystem
//! or vault access — discovery, config, and I/O live in the sibling `discovery`
//! module.

use super::{DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT};
use chrono::{DateTime, Duration, Local};

/// Values exposed to the template renderer.
#[derive(Debug, Clone)]
pub struct TemplateContext {
    pub title: String,
    pub now: DateTime<Local>,
    pub date_format: String,
    pub time_format: String,
}

impl TemplateContext {
    pub fn new(title: impl Into<String>, now: DateTime<Local>) -> Self {
        Self {
            title: title.into(),
            now,
            date_format: DEFAULT_DATE_FORMAT.to_string(),
            time_format: DEFAULT_TIME_FORMAT.to_string(),
        }
    }

    pub(super) fn with_formats(
        title: impl Into<String>,
        now: DateTime<Local>,
        date_format: String,
        time_format: String,
    ) -> Self {
        Self {
            title: title.into(),
            now,
            date_format,
            time_format,
        }
    }
}

/// Render supported Obsidian core and Templater-subset variables.
pub fn render_template(content: &str, ctx: &TemplateContext) -> String {
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0usize;
    let mut next_obsidian = content.find("{{");
    let mut next_templater = content.find("<%");

    while cursor < content.len() {
        refresh_marker(content, cursor, "{{", &mut next_obsidian);
        refresh_marker(content, cursor, "<%", &mut next_templater);
        let Some((offset, kind)) = next_marker(next_obsidian, next_templater) else {
            out.push_str(&content[cursor..]);
            break;
        };

        let start = offset;
        out.push_str(&content[cursor..start]);
        match kind {
            Marker::Obsidian => {
                let after_open = start + 2;
                let Some(close_offset) = content[after_open..].find("}}") else {
                    out.push_str(&content[start..]);
                    break;
                };
                let close = after_open + close_offset;
                let full_end = close + 2;
                let full = &content[start..full_end];
                let inner = &content[after_open..close];
                match render_obsidian(inner, ctx) {
                    Some(rendered) => out.push_str(&rendered),
                    None => out.push_str(full),
                }
                cursor = full_end;
            }
            Marker::Templater => {
                let after_open = start + 2;
                let Some(close_offset) = content[after_open..].find("%>") else {
                    out.push_str(&content[start..]);
                    break;
                };
                let close = after_open + close_offset;
                let full_end = close + 2;
                let full = &content[start..full_end];
                let inner = &content[after_open..close];
                match render_templater(inner, ctx) {
                    Some(rendered) => out.push_str(&rendered),
                    None => out.push_str(full),
                }
                cursor = full_end;
            }
        }
    }

    out
}

fn refresh_marker(content: &str, cursor: usize, marker: &str, cached: &mut Option<usize>) {
    if cached.is_some_and(|pos| pos < cursor) {
        *cached = content[cursor..].find(marker).map(|offset| cursor + offset);
    }
}

#[derive(Clone, Copy)]
enum Marker {
    Obsidian,
    Templater,
}

fn next_marker(obsidian: Option<usize>, templater: Option<usize>) -> Option<(usize, Marker)> {
    match (obsidian, templater) {
        (Some(o), Some(t)) if o <= t => Some((o, Marker::Obsidian)),
        (Some(_), Some(t)) => Some((t, Marker::Templater)),
        (Some(o), None) => Some((o, Marker::Obsidian)),
        (None, Some(t)) => Some((t, Marker::Templater)),
        (None, None) => None,
    }
}

fn render_obsidian(inner: &str, ctx: &TemplateContext) -> Option<String> {
    let command = inner.trim();
    match command {
        "title" => Some(ctx.title.clone()),
        "date" => Some(format_moment(&ctx.date_format, ctx.now)),
        "time" => Some(format_moment(&ctx.time_format, ctx.now)),
        _ => command
            .strip_prefix("date:")
            .map(str::trim)
            .map(|fmt| format_moment(fmt, ctx.now))
            .or_else(|| {
                command
                    .strip_prefix("time:")
                    .map(str::trim)
                    .map(|fmt| format_moment(fmt, ctx.now))
            }),
    }
}

fn render_templater(inner: &str, ctx: &TemplateContext) -> Option<String> {
    let command = inner.trim();
    if command == "tp.file.title" {
        return Some(ctx.title.clone());
    }
    if let Some(format) = parse_format_call(command, "tp.date.now") {
        return Some(format_moment(
            format.as_deref().unwrap_or(DEFAULT_DATE_FORMAT),
            ctx.now,
        ));
    }
    if let Some(format) = parse_format_call(command, "tp.date.tomorrow") {
        return Some(format_moment(
            format.as_deref().unwrap_or(DEFAULT_DATE_FORMAT),
            shifted(ctx.now, 1),
        ));
    }
    if let Some(format) = parse_format_call(command, "tp.date.yesterday") {
        return Some(format_moment(
            format.as_deref().unwrap_or(DEFAULT_DATE_FORMAT),
            shifted(ctx.now, -1),
        ));
    }
    if let Some(format) = parse_format_call(command, "tp.file.creation_date") {
        return Some(format_moment(
            format.as_deref().unwrap_or(DEFAULT_DATE_FORMAT),
            ctx.now,
        ));
    }
    None
}

fn parse_format_call(command: &str, name: &str) -> Option<Option<String>> {
    let args = command
        .strip_prefix(name)?
        .strip_prefix('(')?
        .strip_suffix(')')?;
    let args = args.trim();
    if args.is_empty() {
        return Some(None);
    }
    parse_optional_format(args).map(Some)
}

fn parse_optional_format(args: &str) -> Option<String> {
    parse_quoted(args).or_else(|| {
        let inner = args.strip_prefix('[')?.strip_suffix(']')?.trim();
        parse_quoted(inner)
    })
}

fn parse_quoted(input: &str) -> Option<String> {
    let quote = input.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    if !input.ends_with(quote) || input.len() < 2 {
        return None;
    }
    Some(input[1..input.len() - 1].to_string())
}

fn shifted(now: DateTime<Local>, days: i64) -> DateTime<Local> {
    now.checked_add_signed(Duration::days(days)).unwrap_or(now)
}

fn format_moment(format: &str, now: DateTime<Local>) -> String {
    let mut out = String::with_capacity(format.len());
    let mut cursor = 0usize;
    while cursor < format.len() {
        let rest = &format[cursor..];
        if rest.starts_with('[') {
            let after_open = cursor + 1;
            let Some(close_offset) = format[after_open..].find(']') else {
                out.push_str(rest);
                break;
            };
            let close = after_open + close_offset;
            out.push_str(&format[after_open..close]);
            cursor = close + 1;
        } else if let Some((token, rendered)) = render_moment_token(rest, now) {
            out.push_str(&rendered);
            cursor += token.len();
        } else if let Some(ch) = rest.chars().next() {
            out.push(ch);
            cursor += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn render_moment_token(rest: &str, now: DateTime<Local>) -> Option<(&'static str, String)> {
    for (token, chrono_format) in [
        ("YYYY", "%Y"),
        ("MMMM", "%B"),
        ("dddd", "%A"),
        ("MMM", "%b"),
        ("ddd", "%a"),
        ("YY", "%y"),
        ("MM", "%m"),
        ("DD", "%d"),
        ("HH", "%H"),
        ("hh", "%I"),
        ("mm", "%M"),
        ("ss", "%S"),
        ("M", "%-m"),
        ("D", "%-d"),
        ("H", "%-H"),
        ("h", "%-I"),
        ("A", "%p"),
    ] {
        if rest.starts_with(token) {
            return Some((token, now.format(chrono_format).to_string()));
        }
    }
    if rest.starts_with('a') {
        return Some(("a", now.format("%p").to_string().to_lowercase()));
    }
    None
}
