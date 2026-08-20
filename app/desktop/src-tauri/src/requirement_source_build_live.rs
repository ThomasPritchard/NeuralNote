//! Opt-in acceptance harness for the pinned whisper.cpp source build.
//!
//! This is the check that catches a `whisper-cli` which links against libraries
//! the installer deletes. It performs the *whole* real install — download the
//! pinned tarball, configure, compile, publish the one executable, drop the
//! staging tree — and only then runs the installed binary. Running it while the
//! build tree still exists proves nothing, because dyld resolves `@rpath`
//! against that tree; the removal is the point of the test.
//!
//! It never runs in the default suite: it needs the network, Xcode Command Line
//! Tools, CMake 3.28+, and several minutes of compilation. Invoke it opt-in:
//!   NEURALNOTE_WHISPER_SOURCE_BUILD=1 \
//!   cargo test -p desktop --locked -- --ignored --nocapture whisper_source_build
//!
//! `NEURALNOTE_REQUIRE_EVAL=1` turns a skip into a hard failure, matching the
//! YouTube live evals — a SKIPPED run is not a pass.

use crate::macho_linkage::{self, Linkage};
use crate::youtube::process::{EnvironmentPolicy, ProcessRunner, ProcessSpec, TokioProcessRunner};
use neuralnote_core::ai::{
    lookup_requirement_source_build, CaptureCancellation, PullEvent, PullSink,
    RequirementSourceBuild,
};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const ENABLE_ENV: &str = "NEURALNOTE_WHISPER_SOURCE_BUILD";
const ENABLE_HINT: &str =
    "set NEURALNOTE_WHISPER_SOURCE_BUILD=1 (needs network, Xcode CLT, CMake 3.28+, several minutes)";

/// Emit the standard skip notice, and panic instead when eval is required.
fn skip_or_fail(case: &str, reason: &str) {
    eprint!(
        "\n============ NEURALNOTE WHISPER SOURCE-BUILD TEST SKIPPED ============\n\
         Case: {case}\n\
         Reason: {reason}\n\
         Enable it by: {ENABLE_HINT}\n\
         A SKIPPED run is NOT a pass. Set NEURALNOTE_REQUIRE_EVAL=1 to make a skip a hard failure.\n\
         =====================================================================\n"
    );
    if std::env::var("NEURALNOTE_REQUIRE_EVAL").is_ok_and(|value| value == "1") {
        panic!("NEURALNOTE_REQUIRE_EVAL=1 but the {case} test could not run: {reason}");
    }
}

fn enabled() -> bool {
    std::env::var(ENABLE_ENV).is_ok_and(|value| value == "1")
}

/// Echo install progress to the test log so a long compile shows its work.
struct EchoSink;

impl PullSink for EchoSink {
    fn send(&mut self, event: PullEvent) {
        if let PullEvent::Progress { status, .. } = event {
            eprintln!("[install] {status}");
        }
    }
}

/// Run the installed executable exactly as a user's first transcription would
/// reach it: from app-data, with a cleared environment, and with nothing left of
/// the build that produced it.
async fn run_installed(binary: &Path, runtime: &Path) -> (bool, String) {
    let spec = ProcessSpec {
        program: binary.to_path_buf(),
        args: vec![OsString::from("--version")],
        cwd: Some(runtime.to_path_buf()),
        environment: EnvironmentPolicy::ClearAndSet(BTreeMap::from([
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), runtime.as_os_str().to_owned()),
            (OsString::from("TMPDIR"), runtime.as_os_str().to_owned()),
        ])),
        timeout: Duration::from_secs(60),
        stdout_limit: 64 * 1024,
        stderr_limit: 64 * 1024,
    };
    let output = TokioProcessRunner
        .run(&spec, &CaptureCancellation::default())
        .await
        .expect("the installed whisper-cli should be runnable at all");
    let report = format!(
        "status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    (output.status.success(), report)
}

/// Install a `whisper-cli` built the way the shipped code built it — the real
/// configure minus the one flag that fixes it — so the rest of the pipeline is
/// exercised against genuine linker output rather than a fixture's idea of it.
/// Returns once the staging tree that produced it has been deleted, which is the
/// state a user is left in.
async fn install_a_binary_built_the_shipped_way(
    app_data: &Path,
    recipe: &RequirementSourceBuild,
) -> PathBuf {
    let staging = super::create_private_staging(app_data).unwrap();
    let cancellation = CaptureCancellation::default();
    let cmake = super::preflight_build_tools(&staging.0, &cancellation)
        .await
        .unwrap();
    let archive = super::download_source_archive(recipe, &mut EchoSink, &cancellation)
        .await
        .unwrap();
    let source = super::extract_source_archive(&archive, &staging.0, recipe).unwrap();

    let [mut configure, build] = super::whisper_build_specs(&cmake, &staging.0, &source).unwrap();
    // Exactly the shipped defect: the real configure with the static-link flag
    // taken back out, so this cannot drift away from the code under test.
    configure
        .args
        .retain(|arg| arg != "-DBUILD_SHARED_LIBS=OFF");
    for spec in [configure, build] {
        let output = TokioProcessRunner.run(&spec, &cancellation).await.unwrap();
        assert!(output.status.success(), "the shared build should succeed");
    }

    crate::requirement_installer::publish_built_executable(
        app_data,
        recipe.name,
        &source.join(recipe.output_rel_path),
    )
    .expect("publishing the first build should behave exactly as it shipped");
    drop(staging);
    app_data.join("bin").join(recipe.name)
}

/// The whole defect, end to end, on real artefacts: a user who accepted the
/// prompt before the fix has a `whisper-cli` that cannot start, that the app
/// nevertheless reported as ready, and that the app refused to replace. All
/// three have to change together — repairing an install the inventory still
/// calls healthy would never be offered, and offering a repair the installer
/// refuses would fail at the last step.
#[ignore = "opt-in: downloads and compiles whisper.cpp twice; see the module docs"]
#[tokio::test(flavor = "multi_thread")]
async fn a_whisper_install_that_cannot_run_is_neither_reported_ready_nor_left_unrepairable() {
    if !enabled() {
        skip_or_fail(
            "whisper broken-install repair",
            format!("{ENABLE_ENV} is not 1").as_str(),
        );
        return;
    }
    let app_data = tempfile::tempdir().unwrap();
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();
    let installed = install_a_binary_built_the_shipped_way(app_data.path(), &recipe).await;
    let runtime = app_data.path().join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();

    // 1. It really is dead: dyld cannot find what it was linked against.
    let (ran, report) = run_installed(&installed, &runtime).await;
    eprintln!("[shipped-build whisper-cli --version] {report}");
    assert!(
        !ran,
        "the shipped build was supposed to be broken; got {report}"
    );

    // 2. Reading its load commands reaches the same verdict the run did.
    let Linkage::Unresolved(missing) = macho_linkage::inspect(&installed) else {
        panic!("the real broken artefact must read as unresolved");
    };
    eprintln!("[linkage] cannot find: {}", missing.join(", "));
    assert!(missing.iter().any(|name| name.contains("libwhisper")));

    // 3. So the app stops calling it installed.
    assert!(
        !crate::requirement_detection::detect_requirement_files(app_data.path())
            .contains(&installed),
        "a binary that cannot launch must not be reported as available"
    );

    // 4. And the install the app now offers can actually land on top of it.
    crate::requirement_source_build::install_whisper_from_source(
        app_data.path(),
        recipe,
        &mut EchoSink,
        &CaptureCancellation::default(),
    )
    .await
    .expect("a broken install must be repairable from inside the app");

    let (repaired, report) = run_installed(&installed, &runtime).await;
    eprintln!("[repaired whisper-cli --version] {report}");
    assert!(repaired, "the repaired binary must run; got {report}");
    assert!(
        crate::requirement_detection::detect_requirement_files(app_data.path())
            .contains(&installed),
        "the repaired binary must be reported as available"
    );
}

#[ignore = "opt-in: downloads and compiles whisper.cpp; see the module docs"]
#[tokio::test(flavor = "multi_thread")]
async fn whisper_source_build_installs_a_binary_that_runs_once_the_staging_tree_is_gone() {
    if !enabled() {
        skip_or_fail(
            "whisper source build",
            format!("{ENABLE_ENV} is not 1").as_str(),
        );
        return;
    }
    let app_data = tempfile::tempdir().unwrap();
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();

    crate::requirement_source_build::install_whisper_from_source(
        app_data.path(),
        recipe,
        &mut EchoSink,
        &CaptureCancellation::default(),
    )
    .await
    .expect("the pinned source build should install whisper-cli");

    let installed = app_data.path().join("bin").join("whisper-cli");
    assert!(
        installed.symlink_metadata().is_ok_and(|m| m.is_file()),
        "the installer should publish one regular file at {}",
        installed.display()
    );

    // The staging tree is what an @rpath-linked build resolves against, so the
    // run below is only meaningful once nothing of it survives.
    let leftovers: Vec<_> = std::fs::read_dir(app_data.path().join("build"))
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "the staging tree must be gone before the installed binary is trusted; found {leftovers:?}"
    );

    // Ties the load-command reader to reality: the synthetic fixtures elsewhere
    // only prove it agrees with this repository's idea of the format, and this
    // proves the same verdict holds for what a real linker emitted.
    assert_eq!(
        macho_linkage::inspect(&installed),
        Linkage::Resolved,
        "the statically linked build should declare nothing dyld cannot find"
    );

    let runtime = app_data.path().join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let (ran, report) = run_installed(&installed, &runtime).await;
    eprintln!("[installed whisper-cli --version] {report}");
    assert!(
        ran,
        "the installed whisper-cli must run with the staging tree gone; got {report}"
    );
    assert!(
        report.contains(&format!(
            "whisper.cpp version: {}",
            recipe.version.trim_start_matches('v')
        )),
        "the installed whisper-cli should report the pinned version; got {report}"
    );
}
