//! Captures the crate's `log` output so tolerated-fault branches can be
//! asserted, not just executed. Every such warning is the only trace a
//! silently-ignored fault leaves, and without a logger installed the
//! `log::warn!` arguments are never even evaluated — so "it warned" would be an
//! untested claim.
//!
//! **Crate-wide on purpose.** `log` allows exactly one logger per process, so a
//! second harness in another module does not merely duplicate this one: whichever
//! installs first takes the slot and the other's `set_logger` fails. Every module
//! that wants to assert a warning shares this one.

use std::sync::{Mutex, Once, OnceLock};

static MESSAGES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static INSTALL: Once = Once::new();
static LOGGER: Capturing = Capturing;

struct Capturing;

impl log::Log for Capturing {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            messages().lock().unwrap().push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

fn messages() -> &'static Mutex<Vec<String>> {
    MESSAGES.get_or_init(Mutex::default)
}

/// Install the capturing logger for the whole test binary and return a mark:
/// the number of warnings already recorded. `log` allows one logger per
/// process, so installation is idempotent and must run before the code under
/// test warns. Pass the mark to [`recorded`].
pub(crate) fn capture() -> usize {
    INSTALL.call_once(|| {
        log::set_logger(&LOGGER).expect("no other logger may own this test binary");
        log::set_max_level(log::LevelFilter::Warn);
    });
    messages().lock().unwrap().len()
}

/// Whether any warning recorded **since `mark`** contains `needle`.
///
/// The buffer is process-global and deliberately never cleared, so a parallel
/// test cannot destroy another's evidence. That alone is not enough: without a
/// mark a test can also *inherit* evidence, passing on a warning that some
/// other test in this binary emitted from the same production site. Scanning
/// forward from the caller's own mark keeps each assertion scoped to what that
/// test provoked, so it goes red when its own path stops warning.
pub(crate) fn recorded(mark: usize, needle: &str) -> bool {
    messages()
        .lock()
        .unwrap()
        .iter()
        .skip(mark)
        .any(|message| message.contains(needle))
}

/// Every warning recorded since `mark`, for an assertion's failure message.
pub(crate) fn since(mark: usize) -> Vec<String> {
    messages()
        .lock()
        .unwrap()
        .iter()
        .skip(mark)
        .cloned()
        .collect()
}
