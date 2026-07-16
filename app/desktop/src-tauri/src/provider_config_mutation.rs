use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::Barrier;

use neuralnote_core::ai::ProviderConfig;
use neuralnote_core::{CoreError, CoreResult};

#[cfg(test)]
static TEST_CONTENTION_MARKER: std::sync::OnceLock<Mutex<Option<std::path::PathBuf>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn record_test_contention() {
    if let Some(path) = TEST_CONTENTION_MARKER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        std::fs::write(path, b"contended").unwrap();
    }
}

/// One process-local gate for every native `ai-config.json` mutation. Clones
/// share the same mutex, so a command's read-modify-write sequence is atomic
/// with respect to every other command using this gate.
#[derive(Clone, Default)]
pub(crate) struct ProviderConfigMutationGate {
    inner: Arc<Mutex<()>>,
    #[cfg(test)]
    entry_barrier: Option<Arc<Barrier>>,
}

impl ProviderConfigMutationGate {
    pub(crate) fn run<T>(
        &self,
        config_dir: &Path,
        operation: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        #[cfg(test)]
        if let Some(barrier) = &self.entry_barrier {
            barrier.wait();
        }
        let _guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _process_lock = AdvisoryProviderConfigLock::acquire(config_dir)?;
        operation()
    }

    #[cfg(test)]
    pub(crate) fn clone_with_entry_barrier(&self, barrier: Arc<Barrier>) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            entry_barrier: Some(barrier),
        }
    }

    #[cfg(test)]
    pub(crate) fn shares_lock_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Apply a config mutation where the OpenRouter key presence is unchanged across
    /// it (the common case — model, provider, reasoning, or skill preferences). The
    /// caller supplies the current keychain presence so the reasoning-probe
    /// invalidation can resolve the effective target on both sides of the mutation.
    pub(crate) fn update(
        &self,
        config_dir: &Path,
        key_present: bool,
        mutation: impl FnOnce(&mut ProviderConfig) -> Result<(), CoreError>,
    ) -> CoreResult<ProviderConfig> {
        self.update_with_key_transition(config_dir, key_present, key_present, mutation)
    }

    /// Apply a config mutation that also changes the OpenRouter key presence — a key
    /// save (absent → present) or clear (present → absent). The effective OpenRouter
    /// provider is derived from the keychain, not persisted, so the transition itself
    /// can change the reasoning-probe target even when no config field moves; passing
    /// the before/after presence lets the invalidation see it.
    pub(crate) fn update_with_key_transition(
        &self,
        config_dir: &Path,
        key_present_before: bool,
        key_present_after: bool,
        mutation: impl FnOnce(&mut ProviderConfig) -> Result<(), CoreError>,
    ) -> CoreResult<ProviderConfig> {
        self.run(config_dir, || {
            let mut config = neuralnote_core::ai::read_provider_config(config_dir)?;
            config.mutate_with_reasoning_probe_invalidation(
                key_present_before,
                key_present_after,
                mutation,
            )?;
            neuralnote_core::ai::write_provider_config(config_dir, &config)?;
            Ok(config)
        })
    }
}

const PROVIDER_CONFIG_LOCK_FILE: &str = ".ai-config.lock";
const PROVIDER_CONFIG_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

struct AdvisoryProviderConfigLock {
    file: File,
}

impl AdvisoryProviderConfigLock {
    fn acquire(config_dir: &Path) -> CoreResult<Self> {
        std::fs::create_dir_all(config_dir).map_err(|error| {
            CoreError::Io(format!(
                "could not create AI config lock directory: {error}"
            ))
        })?;
        let path = config_dir.join(PROVIDER_CONFIG_LOCK_FILE);
        let file = open_lock_file(&path)?;
        lock_file(&file, &path)?;
        Ok(Self { file })
    }
}

impl Drop for AdvisoryProviderConfigLock {
    fn drop(&mut self) {
        if let Err(error) = unlock_file(&self.file) {
            log::warn!("could not release AI config lock: {error}");
        }
    }
}

#[cfg(unix)]
fn open_lock_file(path: &Path) -> CoreResult<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    options
        .open(path)
        .map_err(|error| CoreError::Io(format!("could not open AI config lock: {error}")))
}

#[cfg(windows)]
fn open_lock_file(path: &Path) -> CoreResult<File> {
    use std::os::windows::fs::OpenOptionsExt;

    let deadline = Instant::now() + PROVIDER_CONFIG_LOCK_TIMEOUT;
    loop {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).share_mode(0);
        match options.open(path) {
            Ok(file) => return Ok(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    && Instant::now() < deadline =>
            {
                #[cfg(test)]
                record_test_contention();
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(CoreError::Conflict(
                    "another NeuralNote process is still updating AI settings".into(),
                ));
            }
            Err(error) => {
                return Err(CoreError::Io(format!(
                    "could not open AI config lock: {error}"
                )));
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn open_lock_file(_path: &Path) -> CoreResult<File> {
    Err(CoreError::Io(
        "AI config locking is unsupported on this platform".into(),
    ))
}

#[cfg(unix)]
fn lock_file(file: &File, _path: &Path) -> CoreResult<()> {
    use std::os::fd::AsRawFd;

    let deadline = Instant::now() + PROVIDER_CONFIG_LOCK_TIMEOUT;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline {
            #[cfg(test)]
            record_test_contention();
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err(CoreError::Conflict(
                "another NeuralNote process is still updating AI settings".into(),
            ));
        }
        return Err(CoreError::Io(format!("could not lock AI config: {error}")));
    }
}

#[cfg(not(unix))]
fn lock_file(_file: &File, _path: &Path) -> CoreResult<()> {
    Ok(())
}

#[cfg(unix)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const CHILD_DIR: &str = "NEURALNOTE_PROVIDER_LOCK_CHILD_DIR";

    #[test]
    fn separate_process_updates_cannot_replace_a_stale_provider_snapshot() {
        if let Ok(directory) = std::env::var(CHILD_DIR) {
            let directory = std::path::PathBuf::from(directory);
            let _lock = AdvisoryProviderConfigLock::acquire(&directory).unwrap();
            let mut stale = neuralnote_core::ai::read_provider_config(&directory).unwrap();
            std::fs::write(directory.join("child-ready"), b"ready").unwrap();
            while !directory.join("release-child").exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            stale.model = "vendor/new".into();
            neuralnote_core::ai::write_provider_config(&directory, &stale).unwrap();
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        neuralnote_core::ai::write_provider_config(
            dir.path(),
            &ProviderConfig {
                model: "vendor/old".into(),
                reasoning: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("provider_config_mutation::tests::separate_process_updates_cannot_replace_a_stale_provider_snapshot")
            .arg("--nocapture")
            .env(CHILD_DIR, dir.path())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.path().join("child-ready").exists() {
            assert!(
                Instant::now() < deadline,
                "child never acquired provider lock"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        let contention_marker = dir.path().join("parent-contended");
        *TEST_CONTENTION_MARKER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(contention_marker.clone());
        let gate = ProviderConfigMutationGate::default();
        std::thread::scope(|scope| {
            let update = scope.spawn(|| {
                gate.update(dir.path(), false, |config| {
                    config.reasoning = false;
                    Ok(())
                })
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !contention_marker.exists() {
                assert!(
                    Instant::now() < deadline,
                    "parent never observed the child-held provider lock"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            std::fs::write(dir.path().join("release-child"), b"release").unwrap();
            update.join().unwrap().unwrap();
        });
        *TEST_CONTENTION_MARKER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        assert!(child.wait().unwrap().success());

        let persisted = neuralnote_core::ai::read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.model, "vendor/new");
        assert!(!persisted.reasoning);
    }

    #[test]
    fn target_change_generation_exhaustion_does_not_persist_a_partial_mutation() {
        let dir = tempfile::tempdir().unwrap();
        neuralnote_core::ai::write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(neuralnote_core::ai::ProviderKind::OpenRouter),
                model: "vendor/a".into(),
                reasoning_probe_generation: u64::MAX,
                ..Default::default()
            },
        )
        .unwrap();
        let before = std::fs::read(neuralnote_core::ai::provider_config::config_file(
            dir.path(),
        ))
        .unwrap();

        let error = ProviderConfigMutationGate::default()
            .update(dir.path(), true, |config| {
                config.model = "vendor/b".into();
                Ok(())
            })
            .unwrap_err();

        assert!(matches!(error, CoreError::InvalidContent(_)));
        assert_eq!(
            std::fs::read(neuralnote_core::ai::provider_config::config_file(
                dir.path()
            ))
            .unwrap(),
            before
        );
    }
}
