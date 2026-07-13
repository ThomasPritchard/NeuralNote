use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};

static CONFIG_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
const MAX_TEMP_ATTEMPTS: usize = 32;

pub(crate) fn write_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
    label: &str,
) -> CoreResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::Io(format!("{label} path has no parent: {}", path.display())))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        CoreError::Io(format!(
            "could not create {label} directory {}: {error}",
            parent.display()
        ))
    })?;

    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| CoreError::Io(format!("could not serialize {label}: {error}")))?;
    bytes.push(b'\n');
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".into());
    let (temp, mut file) = (0..MAX_TEMP_ATTEMPTS)
        .find_map(|_| {
            let sequence = CONFIG_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let temp = parent.join(format!(
                ".{file_name}.{}.{sequence}.nn-tmp",
                std::process::id()
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
            {
                Ok(file) => Some(Ok((temp, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(CoreError::Io(format!(
                    "could not write {label}: {error}"
                )))),
            }
        })
        .unwrap_or_else(|| {
            Err(CoreError::Io(format!(
                "could not write {label}: no unique temporary file was available"
            )))
        })?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(CoreError::Io(format!("could not write {label}: {error}")));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(CoreError::Io(format!("could not replace {label}: {error}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde::ser::Error as _;

    use super::*;

    struct SerializationFailure;
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    impl Serialize for SerializationFailure {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(S::Error::custom("fixture serialization failure"))
        }
    }

    #[test]
    fn serialization_failure_is_contextual() {
        let _lock = TEST_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let error = write_json_atomic(
            &directory.path().join("config.json"),
            &SerializationFailure,
            "fixture config",
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("could not serialize fixture config"));
    }

    #[test]
    fn parentless_config_path_is_rejected_before_writing() {
        let _lock = TEST_LOCK.lock().unwrap();
        let error = write_json_atomic(Path::new("/"), &serde_json::json!({}), "fixture config")
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("fixture config path has no parent"));
    }

    #[cfg(unix)]
    #[test]
    fn predictable_temp_symlink_is_skipped_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let _lock = TEST_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "outside stays intact").unwrap();
        let sequence = CONFIG_TMP_SEQ.load(Ordering::Relaxed);
        let temp = directory.path().join(format!(
            ".config.json.{}.{sequence}.nn-tmp",
            std::process::id()
        ));
        symlink(outside.path(), &temp).unwrap();

        write_json_atomic(
            &directory.path().join("config.json"),
            &serde_json::json!({ "safe": true }),
            "fixture config",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(outside.path()).unwrap(),
            "outside stays intact"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(directory.path().join("config.json")).unwrap()
            )
            .unwrap(),
            serde_json::json!({ "safe": true })
        );
    }

    #[test]
    fn bounded_temp_collision_exhaustion_is_explicit() {
        let _lock = TEST_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let first_sequence = CONFIG_TMP_SEQ.load(Ordering::Relaxed);
        for sequence in first_sequence..first_sequence + MAX_TEMP_ATTEMPTS as u64 {
            std::fs::write(
                directory.path().join(format!(
                    ".config.json.{}.{sequence}.nn-tmp",
                    std::process::id()
                )),
                "occupied",
            )
            .unwrap();
        }

        let error = write_json_atomic(
            &directory.path().join("config.json"),
            &serde_json::json!({}),
            "fixture config",
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("no unique temporary file was available"));
    }
}
