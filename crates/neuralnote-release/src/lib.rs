use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

/// Verify a Tauri updater artifact using the base64-wrapped public key and
/// signature formats consumed by `tauri-plugin-updater`.
pub fn verify_updater_signature(
    artifact: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    let public_key = decode_wrapped_text(public_key_base64, "public key")?;
    let signature = decode_wrapped_text(signature_base64, "signature")?;
    let public_key = PublicKey::decode(&public_key)
        .map_err(|error| format!("invalid updater public key: {error}"))?;
    let signature = Signature::decode(&signature)
        .map_err(|error| format!("invalid updater signature: {error}"))?;

    public_key
        .verify(artifact, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))
}

fn decode_wrapped_text(value: &str, label: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value.trim())
        .map_err(|_| format!("{label} is not valid base64"))?;
    String::from_utf8(decoded).map_err(|_| format!("decoded {label} is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::verify_updater_signature;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key 620F689042B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn tauri_wrapped(value: &str) -> String {
        STANDARD.encode(value)
    }

    #[test]
    fn accepts_a_valid_tauri_updater_signature() {
        let result = verify_updater_signature(
            b"test",
            &tauri_wrapped(SIGNATURE),
            &tauri_wrapped(PUBLIC_KEY),
        );

        assert!(result.is_ok(), "valid signature should verify: {result:?}");
    }

    #[test]
    fn rejects_a_tampered_artifact() {
        let result = verify_updater_signature(
            b"tampered",
            &tauri_wrapped(SIGNATURE),
            &tauri_wrapped(PUBLIC_KEY),
        );

        assert!(result.is_err(), "tampered bytes must fail verification");
    }

    #[test]
    fn rejects_malformed_wrapped_material() {
        let result = verify_updater_signature(b"test", "not-base64", "not-base64");

        assert!(
            result.is_err(),
            "malformed release material must fail closed"
        );
    }
}
