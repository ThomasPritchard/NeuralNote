use super::*;
use std::collections::HashSet;
use std::fs;

fn revision_file(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(KEY_REVISION_FILE)
}

fn published_token(config_dir: &Path) -> String {
    match observe(config_dir) {
        Some(KeyRevision::Published(token)) => token,
        other => panic!("expected a published revision, got {other:?}"),
    }
}

#[test]
fn a_directory_nothing_has_published_to_reads_as_unpublished() {
    let config_dir = tempfile::tempdir().unwrap();

    assert_eq!(observe(config_dir.path()), Some(KeyRevision::Unpublished));
}

#[test]
fn a_config_directory_that_does_not_exist_yet_reads_as_unpublished() {
    // First run: the AI config directory is created by the first save. Until then
    // nothing can have changed underneath a cached key, so this must not read as
    // "unknown" — that would put a keychain round trip on every status poll for
    // every user who has never configured a key.
    let parent = tempfile::tempdir().unwrap();

    assert_eq!(
        observe(&parent.path().join("not-created-yet")),
        Some(KeyRevision::Unpublished)
    );
}

#[test]
fn publishing_moves_the_revision_off_unpublished_and_keeps_it_stable() {
    let config_dir = tempfile::tempdir().unwrap();

    publish(config_dir.path()).unwrap();

    let observed = observe(config_dir.path());
    assert!(matches!(observed, Some(KeyRevision::Published(_))));
    assert_eq!(
        observed,
        observe(config_dir.path()),
        "observing twice without a publish in between must compare equal, or a cached \
         key could never be reused"
    );
}

#[test]
fn every_publish_supersedes_the_last() {
    let config_dir = tempfile::tempdir().unwrap();

    publish(config_dir.path()).unwrap();
    let first = published_token(config_dir.path());
    publish(config_dir.path()).unwrap();
    let second = published_token(config_dir.path());

    assert_ne!(
        first, second,
        "a repeated revision would let an instance reuse a key read before the change"
    );
}

#[test]
fn tokens_never_repeat_back_to_back_or_across_a_recreated_config_directory() {
    // Both hazards the module note names, and each needs its own loop. Back-to-back
    // publishes into one directory catch a bare clock reading, which repeats at this
    // resolution. Only a *fresh* directory catches a counter seeded from the file,
    // which is perfectly unique within any one directory and restarts at zero every
    // time the directory is recreated — so a live instance holding a cached token
    // would meet it again in an unrelated save.
    //
    // Every directory is held open to the end, so no two can share a path.
    let mut seen = HashSet::new();
    let mut directories = Vec::new();

    for _ in 0..20 {
        let config_dir = tempfile::tempdir().unwrap();
        for _ in 0..10 {
            publish(config_dir.path()).unwrap();
            assert!(
                seen.insert(published_token(config_dir.path())),
                "a token was published twice"
            );
        }
        directories.push(config_dir);
    }
}

#[test]
fn the_sidecar_holds_nothing_but_one_token() {
    // The sidecar sits in a directory the user can open. It must never carry the
    // key, and never carry whether a key exists — the keychain is the only place
    // either of those is knowable.
    let config_dir = tempfile::tempdir().unwrap();

    publish(config_dir.path()).unwrap();

    let contents = fs::read_to_string(revision_file(config_dir.path())).unwrap();
    assert_eq!(contents.lines().count(), 1);
    assert_eq!(contents.trim(), published_token(config_dir.path()));
}

#[test]
fn a_corrupt_revision_reads_as_unknown_rather_than_a_match() {
    let config_dir = tempfile::tempdir().unwrap();
    for corrupt in [
        "",
        "   ",
        "not a token",
        "token\nwith\nlines",
        &"x".repeat(129),
    ] {
        fs::write(revision_file(config_dir.path()), corrupt).unwrap();

        assert_eq!(
            observe(config_dir.path()),
            None,
            "a revision of {corrupt:?} must disable cache reuse, not be compared as a value"
        );
    }
}

#[test]
fn an_unusable_sidecar_is_reported_with_its_location_and_its_cost() {
    // Failing closed is silent by nature — every read simply gets slower. The log
    // line is the only thing that tells anyone why, so it has to name the file and
    // the consequence, not just complain.
    let message = unusable_sidecar(
        Path::new("/somewhere/config"),
        "does not hold a valid revision",
    );

    assert!(message.contains("/somewhere/config"), "{message}");
    assert!(
        message.contains("does not hold a valid revision"),
        "{message}"
    );
    assert!(message.contains("re-read the OS keychain"), "{message}");
}

#[test]
fn an_enormous_revision_file_is_rejected_without_being_read_into_memory() {
    // Any local process can replace this file, and `observe` runs on a polled
    // path. What goes red: reading the file whole before applying the limit —
    // this would then take a 64 MiB allocation per status poll on the way to the
    // same answer.
    let config_dir = tempfile::tempdir().unwrap();
    let enormous = "a".repeat(64 * 1024 * 1024);
    fs::write(revision_file(config_dir.path()), &enormous).unwrap();

    assert_eq!(observe(config_dir.path()), None);
}

#[test]
fn a_token_at_the_length_limit_is_still_read() {
    let config_dir = tempfile::tempdir().unwrap();
    let longest = "a".repeat(MAX_TOKEN_BYTES);
    fs::write(revision_file(config_dir.path()), &longest).unwrap();

    assert_eq!(
        observe(config_dir.path()),
        Some(KeyRevision::Published(longest))
    );
}

#[test]
fn an_unreadable_revision_reads_as_unknown() {
    // A directory where the file should be: readable path, unreadable content.
    let config_dir = tempfile::tempdir().unwrap();
    fs::create_dir(revision_file(config_dir.path())).unwrap();

    assert_eq!(observe(config_dir.path()), None);
}

#[test]
fn a_publish_that_cannot_replace_the_sidecar_is_surfaced_and_leaves_no_litter() {
    // A directory sitting where the sidecar belongs: staging succeeds, the rename
    // over it cannot. The staged file must not be left behind on the way out.
    let config_dir = tempfile::tempdir().unwrap();
    fs::create_dir(revision_file(config_dir.path())).unwrap();

    let error = publish(config_dir.path()).expect_err("renaming onto a directory must fail");

    match error {
        CoreError::Io(message) => assert!(
            message.contains("could not publish the API key revision"),
            "expected the publish failure, got: {message}"
        ),
        other => panic!("expected an Io failure, got {other:?}"),
    }
    let leftovers: Vec<_> = fs::read_dir(config_dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "staged files left behind: {leftovers:?}"
    );
}

#[test]
fn publishing_creates_the_config_directory_when_the_first_save_arrives() {
    let parent = tempfile::tempdir().unwrap();
    let config_dir = parent.path().join("config").join("nested");

    publish(&config_dir).unwrap();

    assert!(matches!(
        observe(&config_dir),
        Some(KeyRevision::Published(_))
    ));
}

#[test]
fn a_publish_that_cannot_write_is_surfaced_rather_than_swallowed() {
    let parent = tempfile::tempdir().unwrap();
    let blocked = parent.path().join("a-file-not-a-directory");
    fs::write(&blocked, "in the way").unwrap();

    let error = publish(&blocked).expect_err("publishing into a file must fail");

    match error {
        CoreError::Io(message) => assert!(
            message.contains("key revision"),
            "the failure must name what could not be published, got: {message}"
        ),
        other => panic!("expected an Io failure, got {other:?}"),
    }
}

#[test]
fn a_sidecar_that_disappears_after_publishing_stops_being_cacheable() {
    // The one ABA a unique token cannot close on its own: `Unpublished →
    // Published(t) → Unpublished` compares equal at both ends, so a key cached
    // before the save is served again after it. An external deletion of the config
    // directory is all it takes, and every existing install starts Unpublished, so
    // this is the upgrade path rather than an exotic one.
    //
    // What goes red: treating a missing sidecar as `Unpublished` unconditionally.
    let config_dir = tempfile::tempdir().unwrap();
    assert_eq!(observe(config_dir.path()), Some(KeyRevision::Unpublished));

    publish(config_dir.path()).unwrap();
    fs::remove_file(revision_file(config_dir.path())).unwrap();

    assert_eq!(
        observe(config_dir.path()),
        None,
        "a sidecar that was published and then removed must not read as the pristine \
         state a key cached before the publish still matches"
    );
}

#[test]
fn a_staged_write_that_never_lands_is_reaped_rather_than_left_behind() {
    // Only the rename branch used to clean up, so a `create_new` that succeeded
    // followed by a failing write — a full disk — left a zero-byte file with a name
    // nothing else ever collects, in a directory the user can open.
    //
    // What goes red: dropping the `remove_file` from the reaper.
    let config_dir = tempfile::tempdir().unwrap();
    let staged = config_dir.path().join("half-written.tmp");
    fs::write(&staged, "").unwrap();

    drop(StagedFile::ours(&staged));

    assert!(!staged.exists(), "the staged file was left behind");
}

#[test]
fn a_claimed_staged_file_is_disarmed_rather_than_reaped() {
    // What `publish` does once the rename has moved the file into place: the reaper
    // must not then chase the revision it just published.
    let config_dir = tempfile::tempdir().unwrap();
    let landed = revision_file(config_dir.path());
    fs::write(&landed, "token\n").unwrap();

    StagedFile::ours(&landed).claim();

    assert!(
        landed.exists(),
        "claiming must disarm the reaper, not delay it"
    );
}

#[test]
fn each_config_directory_gets_its_own_warning_budget_and_it_comes_back() {
    // One unkeyed process-global latch is spent by the first transient failure
    // anywhere — an EMFILE at startup, say. A sidecar that is permanently corrupt
    // afterwards then costs a keychain round trip per status poll for the rest of
    // the run, with nothing in the log to say why.
    //
    // What goes red: a single shared latch (the second directory's assertion), or
    // one that never refreshes (the last assertion).
    let noisy = Path::new("/nowhere/noisy-config");
    let quiet = Path::new("/nowhere/quiet-config");
    let start = Instant::now();

    assert!(warning_is_due(noisy, start));
    assert!(
        !warning_is_due(noisy, start),
        "the same complaint must not repeat on the next poll"
    );
    assert!(
        warning_is_due(quiet, start),
        "one directory's complaint must not silence another's"
    );
    assert!(!warning_is_due(
        noisy,
        start + WARN_INTERVAL - Duration::from_secs(1)
    ));
    assert!(
        warning_is_due(noisy, start + WARN_INTERVAL),
        "a permanently unusable sidecar must say so again rather than degrade in silence"
    );
}

#[cfg(unix)]
#[test]
fn a_publish_that_cannot_stage_its_write_is_surfaced() {
    use std::os::unix::fs::PermissionsExt;

    let config_dir = tempfile::tempdir().unwrap();
    publish(config_dir.path()).unwrap();
    fs::set_permissions(config_dir.path(), fs::Permissions::from_mode(0o500)).unwrap();

    let published = publish(config_dir.path());

    // Restore before asserting so the temp dir can always be cleaned up.
    fs::set_permissions(config_dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    match published.expect_err("staging into a read-only directory must fail") {
        CoreError::Io(message) => assert!(
            message.contains("stage the API key revision"),
            "expected the staging failure, got: {message}"
        ),
        other => panic!("expected an Io failure, got {other:?}"),
    }
}
