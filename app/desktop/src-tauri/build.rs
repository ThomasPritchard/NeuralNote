//! Surfaces cargo's build profile to the crate as a `cfg`.
//!
//! `PROFILE` is the only signal that answers "does this artifact ship". The
//! `debug_assertions` flag that usually accompanies it does not: it reports
//! whether assertions were compiled in, and either profile can be built with
//! either setting (`[profile.release] debug-assertions = true`, or
//! `RUSTFLAGS="-C debug-assertions=on"`).
//!
//! Two names, one decision, so the pair can never disagree about which profile
//! this is. `native_e2e_release_profile` gates the automation feature's
//! compile-time refusal in `lib.rs` and is pinned by name in
//! `app/desktop/e2e-native/wdio.conf.test.ts`; `release_profile` is the general
//! signal, read by `ai::BuildProfile::current` to pick the keychain namespace.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(native_e2e_release_profile)");
    println!("cargo:rustc-check-cfg=cfg(release_profile)");
    if std::env::var("PROFILE").is_ok_and(|profile| profile == "release") {
        println!("cargo:rustc-cfg=native_e2e_release_profile");
        println!("cargo:rustc-cfg=release_profile");
    }
    tauri_build::build()
}
