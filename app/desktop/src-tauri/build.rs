fn main() {
    println!("cargo:rustc-check-cfg=cfg(native_e2e_release_profile)");
    if std::env::var("PROFILE").is_ok_and(|profile| profile == "release") {
        println!("cargo:rustc-cfg=native_e2e_release_profile");
    }
    tauri_build::build()
}
