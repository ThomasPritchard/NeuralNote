//! Obsidian-compatible note templates.
//!
//! Templates are untrusted vault content: they may come from a migrated or shared
//! vault. This module therefore implements a whitelist-only interpreter over a
//! fixed table of variables/functions. It never evaluates code, never shells out,
//! never dispatches to user functions, and leaves unknown syntax verbatim.

use crate::error::{CoreError, CoreResult};
use crate::model::TemplateInfo;
use crate::paths::{ensure_within, rel_path};
use crate::{entries, note, tree};
use chrono::{DateTime, Duration, Local};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

const DEFAULT_TEMPLATE_FOLDER: &str = "Templates";
const DEFAULT_DATE_FORMAT: &str = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT: &str = "HH:mm";
const FALLBACK_FOLDERS: [&str; 3] = ["Templates", "_templates", "templates"];

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

    fn with_formats(
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

#[derive(Debug, Clone)]
struct TemplateSettings {
    folder: PathBuf,
    date_format: String,
    time_format: String,
}

/// List markdown templates in the inferred template folder.
pub fn list_templates(root: &Path) -> CoreResult<Vec<TemplateInfo>> {
    let root = canon_root(root)?;
    let settings = infer_template_settings(&root);
    let Some(folder) = existing_template_folder(&root, &settings)? else {
        return Ok(Vec::new());
    };

    let nodes = tree::read_tree(&folder)?;
    let mut templates = tree::markdown_files(&nodes)
        .into_iter()
        .map(|node| template_info_for(&root, Path::new(&node.path)))
        .collect::<Vec<_>>();
    templates.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(templates)
}

/// Create a note and optionally seed it with a rendered vault template.
pub fn create_note_from_template(
    root: &Path,
    parent: &Path,
    name: &str,
    template: Option<&str>,
    now: DateTime<Local>,
) -> CoreResult<crate::model::TreeNode> {
    let root = canon_root(root)?;
    let settings = infer_template_settings(&root);
    let template_content = match template {
        Some(template) => Some(read_template(&root, &settings, template)?),
        None => None,
    };

    let node = entries::create_note(&root, parent, name)?;
    if let Some(template_content) = template_content {
        let title = Path::new(&node.name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| node.name.clone());
        let ctx =
            TemplateContext::with_formats(title, now, settings.date_format, settings.time_format);
        let rendered = render_template(&template_content, &ctx);
        if let Err(e) = note::write_note(&root, Path::new(&node.path), &rendered, None) {
            remove_created_note_after_template_write_failure(Path::new(&node.path));
            return Err(e);
        }
    }
    Ok(node)
}

pub(crate) fn remove_created_note_after_template_write_failure(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "templates: failed to clean up note after template write error {}: {e}",
            path.display()
        ),
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

fn read_template(root: &Path, settings: &TemplateSettings, template: &str) -> CoreResult<String> {
    let template_path = resolve_template_file(root, settings, template)?;
    let bytes = std::fs::read(&template_path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn resolve_template_file(
    root: &Path,
    settings: &TemplateSettings,
    template: &str,
) -> CoreResult<PathBuf> {
    let Some(folder) = existing_template_folder(root, settings)? else {
        return Err(CoreError::NotFound(format!(
            "template folder not found: {}",
            rel_path(root, &root.join(&settings.folder))
        )));
    };
    let rel = parse_relative_path(template)
        .ok_or_else(|| CoreError::InvalidName("template path must be vault-relative".into()))?;
    let requested = ensure_within(root, &root.join(rel))?;
    if !requested.starts_with(&folder) {
        return Err(CoreError::InvalidName(format!(
            "template must be inside the template folder: {}",
            rel_path(root, &folder)
        )));
    }
    if !is_markdown_path(&requested) {
        return Err(CoreError::InvalidName(
            "template must be a markdown file".into(),
        ));
    }
    if !requested.is_file() {
        return Err(CoreError::NotFound(format!(
            "template not found: {}",
            rel_path(root, &requested)
        )));
    }
    Ok(requested)
}

fn template_info_for(root: &Path, path: &Path) -> TemplateInfo {
    TemplateInfo {
        rel_path: rel_path(root, path),
        name: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn existing_template_folder(
    root: &Path,
    settings: &TemplateSettings,
) -> CoreResult<Option<PathBuf>> {
    let folder = root.join(&settings.folder);
    if !folder.exists() {
        return Ok(None);
    }
    let folder = ensure_within(root, &folder)?;
    if folder.is_dir() {
        Ok(Some(folder))
    } else {
        Ok(None)
    }
}

fn infer_template_settings(root: &Path) -> TemplateSettings {
    let mut settings = TemplateSettings {
        folder: PathBuf::from(DEFAULT_TEMPLATE_FOLDER),
        date_format: DEFAULT_DATE_FORMAT.to_string(),
        time_format: DEFAULT_TIME_FORMAT.to_string(),
    };

    let config_folder = read_obsidian_template_config(root, &mut settings);
    settings.folder = config_folder
        .or_else(|| discover_top_level_template_folder(root))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_TEMPLATE_FOLDER));
    settings
}

fn read_obsidian_template_config(root: &Path, settings: &mut TemplateSettings) -> Option<PathBuf> {
    let config_path = root.join(".obsidian/templates.json");
    let data = match std::fs::read_to_string(&config_path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!(
                "templates: could not read Obsidian template config {}: {e}",
                config_path.display()
            );
            return None;
        }
    };
    let parsed = match serde_json::from_str::<Value>(&data) {
        Ok(parsed) => parsed,
        Err(e) => {
            log::warn!(
                "templates: could not parse Obsidian template config {}: {e}",
                config_path.display()
            );
            return None;
        }
    };
    let Some(obj) = parsed.as_object() else {
        log::warn!(
            "templates: Obsidian template config {} is not a JSON object",
            config_path.display()
        );
        return None;
    };

    if let Some(value) = obj.get("dateFormat").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            settings.date_format = value.to_string();
        }
    }
    if let Some(value) = obj.get("timeFormat").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            settings.time_format = value.to_string();
        }
    }

    obj.get("folder")
        .and_then(Value::as_str)
        .and_then(parse_relative_path)
}

fn discover_top_level_template_folder(root: &Path) -> Option<PathBuf> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!(
                "templates: could not scan vault root for template folders {}: {e}",
                root.display()
            );
            return None;
        }
    };
    let mut matches = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!(
                    "templates: could not read a vault root entry while discovering templates in {}: {e}",
                    root.display()
                );
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !FALLBACK_FOLDERS
            .iter()
            .any(|wanted| name.eq_ignore_ascii_case(wanted))
        {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => matches.push(name),
            Ok(_) => {}
            Err(e) => {
                log::warn!(
                    "templates: could not inspect template folder candidate {}: {e}",
                    entry.path().display()
                );
            }
        }
    }
    matches.sort();
    matches.into_iter().next().map(PathBuf::from)
}

fn parse_relative_path(raw: &str) -> Option<PathBuf> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_markdown_path(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    tree::is_markdown_ext(ext.as_deref())
}

fn canon_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))
}
