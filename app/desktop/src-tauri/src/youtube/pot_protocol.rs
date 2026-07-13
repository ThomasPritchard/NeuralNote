use super::super::{ytdlp::PotRouting, SANITIZED_PATH};
use super::{PotInstallation, PotSpawnSpec};
use neuralnote_core::capture::CaptureError;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::Path;

const STDERR_LIMIT: usize = 16 * 1024;
pub(super) const PING_BODY_LIMIT: usize = 4 * 1024;
pub(super) const PREWARM_BODY_LIMIT: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PingResponse {
    server_uptime: u64,
    version: String,
}

pub(in crate::youtube) fn parse_ping_response(status: u16, body: &[u8]) -> Result<(), String> {
    if status != 200 {
        return Err(format!("/ping returned HTTP {status}"));
    }
    let response: PingResponse =
        serde_json::from_slice(body).map_err(|_| "/ping returned invalid JSON".to_string())?;
    if response.version != "0.8.1" {
        return Err("/ping did not report bgutil-pot v0.8.1".into());
    }
    let _ = response.server_uptime;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrewarmResponse {
    #[serde(rename = "poToken")]
    po_token: String,
}

pub(in crate::youtube) fn parse_prewarm_response(status: u16, body: &[u8]) -> Result<(), String> {
    if status != 200 {
        return Err(format!("/get_pot returned HTTP {status}"));
    }
    let response: PrewarmResponse = serde_json::from_slice(body)
        .map_err(|_| "/get_pot returned an invalid response".to_string())?;
    if response.po_token.is_empty()
        || response.po_token.len() > 8 * 1024
        || !response
            .po_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err("/get_pot returned an invalid response".into());
    }
    Ok(())
}

pub(super) fn validate_installation(
    installation: &PotInstallation,
) -> Result<PotRouting, CaptureError> {
    if !installation.binary_path.is_absolute()
        || !installation.plugin_file.is_absolute()
        || !installation.runtime_dir.is_absolute()
    {
        return Err(pot_failure("installation paths must be absolute", ""));
    }
    validate_regular_file(&installation.binary_path, true, "binary")?;
    validate_regular_file(&installation.plugin_file, false, "plugin")?;
    std::fs::create_dir_all(&installation.runtime_dir).map_err(|error| {
        pot_failure(
            "could not create the controlled runtime directory",
            &error.to_string(),
        )
    })?;
    let runtime = std::fs::symlink_metadata(&installation.runtime_dir).map_err(|error| {
        pot_failure(
            "could not inspect the controlled runtime directory",
            &error.to_string(),
        )
    })?;
    if runtime.file_type().is_symlink() || !runtime.is_dir() {
        return Err(pot_failure("runtime path must be a real directory", ""));
    }
    let disabled_cli_path = installation
        .runtime_dir
        .join("bgutil-cli-provider-disabled");
    match std::fs::symlink_metadata(&disabled_cli_path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(pot_failure(
                "could not inspect disabled CLI path",
                &error.to_string(),
            ));
        }
        Ok(_) => return Err(pot_failure("disabled CLI path must not exist", "")),
    }
    let plugin_dir = installation
        .plugin_file
        .parent()
        .ok_or_else(|| pot_failure("plugin has no parent directory", ""))?
        .to_path_buf();
    Ok(PotRouting {
        plugin_dir,
        base_url: String::new(),
        disabled_cli_path,
    })
}

fn validate_regular_file(path: &Path, executable: bool, label: &str) -> Result<(), CaptureError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| pot_failure(&format!("{label} is not installed"), &error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(pot_failure(&format!("{label} must be a regular file"), ""));
    }
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(pot_failure("binary must be executable", ""));
        }
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

pub(super) fn spawn_spec(installation: &PotInstallation, port: u16) -> PotSpawnSpec {
    let port = port.to_string();
    PotSpawnSpec {
        program: installation.binary_path.clone(),
        args: ["server", "--host", "127.0.0.1", "--port", &port]
            .into_iter()
            .map(OsString::from)
            .collect(),
        cwd: installation.runtime_dir.clone(),
        environment: BTreeMap::from([
            (OsString::from("LOG_LEVEL"), OsString::from("warn")),
            (OsString::from("PATH"), OsString::from(SANITIZED_PATH)),
        ]),
    }
}

pub(super) fn pot_failure(reason: &str, diagnostic: &str) -> CaptureError {
    let diagnostic = redact_diagnostic(diagnostic);
    CaptureError::PotUnavailable(if diagnostic.is_empty() {
        reason.to_string()
    } else {
        format!("{reason}; stderr: {diagnostic}")
    })
}

pub(in crate::youtube) fn redact_diagnostic(raw: &str) -> String {
    let mut redacted = String::new();
    for line in raw.lines() {
        let lower = line.to_ascii_lowercase();
        let line = if lower.contains("pot token")
            || lower.contains("generated pot")
            || lower.contains("potoken")
            || lower.contains("po_token")
            || lower.contains("po-token")
            || lower.contains("bearer")
            || lower.contains("authorization")
        {
            "[sensitive POT diagnostic redacted]"
        } else {
            line
        };
        append_tail(&mut redacted, line);
        append_tail(&mut redacted, "\n");
    }
    redacted.trim().to_string()
}

pub(super) fn append_tail(output: &mut String, text: &str) {
    output.push_str(text);
    if output.len() > STDERR_LIMIT {
        let mut cut = output.len() - STDERR_LIMIT;
        while !output.is_char_boundary(cut) {
            cut += 1;
        }
        output.drain(..cut);
    }
}
