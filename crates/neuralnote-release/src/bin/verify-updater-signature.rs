use std::{env, fs, process};

use neuralnote_release::verify_updater_signature;

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater signature check failed: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let artifact_path = arguments
        .next()
        .ok_or_else(|| "usage: verify-updater-signature <artifact> <signature>".to_owned())?;
    let signature_path = arguments
        .next()
        .ok_or_else(|| "usage: verify-updater-signature <artifact> <signature>".to_owned())?;
    if arguments.next().is_some() {
        return Err("usage: verify-updater-signature <artifact> <signature>".to_owned());
    }

    let public_key = env::var("TAURI_UPDATER_PUBLIC_KEY")
        .map_err(|_| "TAURI_UPDATER_PUBLIC_KEY is not configured".to_owned())?;
    let artifact = fs::read(&artifact_path)
        .map_err(|error| format!("could not read updater artifact: {error}"))?;
    let signature = fs::read_to_string(&signature_path)
        .map_err(|error| format!("could not read updater signature: {error}"))?;

    verify_updater_signature(&artifact, &signature, &public_key)
}
