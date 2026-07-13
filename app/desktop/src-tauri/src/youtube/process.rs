use async_trait::async_trait;
use neuralnote_core::ai::CaptureCancellation;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EnvironmentPolicy {
    ClearAndSet(BTreeMap<OsString, OsString>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessSpec {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) environment: EnvironmentPolicy,
    pub(crate) timeout: Duration,
    pub(crate) stdout_limit: usize,
    pub(crate) stderr_limit: usize,
}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub(crate) enum ProcessError {
    ProgramNotAbsolute {
        program: PathBuf,
    },
    Spawn {
        program: PathBuf,
        source: io::Error,
    },
    PipeUnavailable {
        stream: OutputStream,
    },
    Wait {
        source: io::Error,
    },
    OutputRead {
        stream: OutputStream,
        source: io::Error,
    },
    Terminate {
        source: io::Error,
    },
    TimedOut {
        timeout: Duration,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    Cancelled {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    OutputOverflow {
        stream: OutputStream,
        limit: usize,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProgramNotAbsolute { program } => {
                debug_assert!(!program.is_absolute());
                formatter.write_str("process program path is not absolute")
            }
            Self::Spawn { program, source } => {
                debug_assert!(program.is_absolute());
                write!(formatter, "could not spawn process: {source}")
            }
            Self::PipeUnavailable { stream } => {
                write!(formatter, "process {stream:?} pipe was unavailable")
            }
            Self::Wait { source } => write!(formatter, "could not wait for process: {source}"),
            Self::OutputRead { stream, source } => {
                write!(formatter, "could not read process {stream:?}: {source}")
            }
            Self::Terminate { source } => {
                write!(formatter, "could not terminate process: {source}")
            }
            Self::TimedOut { timeout, .. } => {
                write!(formatter, "process timed out after {timeout:?}")
            }
            Self::Cancelled { .. } => formatter.write_str("process was cancelled"),
            Self::OutputOverflow { stream, limit, .. } => {
                write!(
                    formatter,
                    "process {stream:?} exceeded the {limit}-byte limit"
                )
            }
        }
    }
}

impl std::error::Error for ProcessError {}

#[async_trait]
pub(crate) trait ProcessRunner: Send + Sync {
    async fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &CaptureCancellation,
    ) -> Result<ProcessOutput, ProcessError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct TokioProcessRunner;

#[path = "process_runtime.rs"]
mod runtime;

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
