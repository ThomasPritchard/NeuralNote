use super::{
    EnvironmentPolicy, OutputStream, ProcessError, ProcessOutput, ProcessRunner, ProcessSpec,
    TokioProcessRunner,
};
use async_trait::async_trait;
use neuralnote_core::ai::CaptureCancellation;
use std::io;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

#[async_trait]
impl ProcessRunner for TokioProcessRunner {
    async fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &CaptureCancellation,
    ) -> Result<ProcessOutput, ProcessError> {
        if !spec.program.is_absolute() {
            return Err(ProcessError::ProgramNotAbsolute {
                program: spec.program.clone(),
            });
        }
        if cancellation.is_cancelled() {
            return Err(ProcessError::Cancelled {
                stdout: Vec::new(),
                stderr: Vec::new(),
            });
        }

        let mut command = std::process::Command::new(&spec.program);
        command.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        let EnvironmentPolicy::ClearAndSet(values) = &spec.environment;
        command.env_clear().envs(values);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        let mut child = command.spawn().map_err(|source| ProcessError::Spawn {
            program: spec.program.clone(),
            source,
        })?;
        let process_id = child.id();
        let stdout = child.stdout.take().ok_or(ProcessError::PipeUnavailable {
            stream: OutputStream::Stdout,
        })?;
        let stderr = child.stderr.take().ok_or(ProcessError::PipeUnavailable {
            stream: OutputStream::Stderr,
        })?;

        let (overflow_tx, mut overflow_rx) = mpsc::unbounded_channel();
        let mut stdout_task = tokio::spawn(read_bounded(
            stdout,
            spec.stdout_limit,
            OutputStream::Stdout,
            overflow_tx.clone(),
        ));
        let mut stderr_task = tokio::spawn(read_bounded(
            stderr,
            spec.stderr_limit,
            OutputStream::Stderr,
            overflow_tx,
        ));
        let deadline = tokio::time::sleep(spec.timeout);
        tokio::pin!(deadline);
        let mut cancellation_poll = tokio::time::interval(Duration::from_millis(10));
        cancellation_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut child_status = None;
        let mut stdout = None;
        let mut stderr = None;
        let completion = loop {
            if child_status.is_some() && stdout.is_some() && stderr.is_some() {
                break Completion::Exited(child_status.take().expect("status checked"));
            }
            tokio::select! {
                biased;
                Some(stream) = overflow_rx.recv() => break Completion::Overflow(stream),
                status = child.wait(), if child_status.is_none() => child_status = Some(status),
                output = &mut stdout_task, if stdout.is_none() => {
                    stdout = Some(map_output_result(output, OutputStream::Stdout)?);
                }
                output = &mut stderr_task, if stderr.is_none() => {
                    stderr = Some(map_output_result(output, OutputStream::Stderr)?);
                }
                () = &mut deadline => break Completion::TimedOut,
                _ = cancellation_poll.tick() => {
                    if cancellation.is_cancelled() {
                        break Completion::Cancelled;
                    }
                }
            }
        };
        if matches!(
            completion,
            Completion::Overflow(_) | Completion::TimedOut | Completion::Cancelled
        ) {
            terminate_process_tree(&mut child, process_id, child_status.is_some()).await?;
        }
        let stdout = match stdout {
            Some(output) => output,
            None => join_output(stdout_task, OutputStream::Stdout).await?,
        };
        let stderr = match stderr {
            Some(output) => output,
            None => join_output(stderr_task, OutputStream::Stderr).await?,
        };
        let late_overflow = stdout
            .overflowed
            .then_some(OutputStream::Stdout)
            .or_else(|| stderr.overflowed.then_some(OutputStream::Stderr));
        let stdout = stdout.bytes;
        let stderr = stderr.bytes;
        match completion {
            Completion::Exited(status) => match late_overflow {
                Some(stream) => Err(output_overflow(spec, stream, stdout, stderr)),
                None => Ok(ProcessOutput {
                    status: status.map_err(|source| ProcessError::Wait { source })?,
                    stdout,
                    stderr,
                }),
            },
            Completion::Overflow(stream) => Err(output_overflow(spec, stream, stdout, stderr)),
            Completion::TimedOut => Err(ProcessError::TimedOut {
                timeout: spec.timeout,
                stdout,
                stderr,
            }),
            Completion::Cancelled => Err(ProcessError::Cancelled { stdout, stderr }),
        }
    }
}

async fn terminate_process_tree(
    child: &mut tokio::process::Child,
    process_id: Option<u32>,
    child_reaped: bool,
) -> Result<(), ProcessError> {
    #[cfg(unix)]
    if let Some(process_id) = process_id {
        let process_group = i32::try_from(process_id).map_err(|_| ProcessError::Terminate {
            source: io::Error::other("child process id exceeded the platform range"),
        })?;
        // SAFETY: the child was placed in a new process group whose id is its
        // PID. A negative PID targets only that group and SIGKILL is valid.
        let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
        if result == 0 {
            if !child_reaped {
                child
                    .wait()
                    .await
                    .map_err(|source| ProcessError::Terminate { source })?;
            }
            return Ok(());
        }
        let source = io::Error::last_os_error();
        if source.raw_os_error() != Some(libc::ESRCH) {
            return Err(ProcessError::Terminate { source });
        }
    }

    if child_reaped {
        Ok(())
    } else {
        child
            .kill()
            .await
            .map_err(|source| ProcessError::Terminate { source })
    }
}

enum Completion {
    Exited(io::Result<ExitStatus>),
    Overflow(OutputStream),
    TimedOut,
    Cancelled,
}

struct BoundedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

async fn read_bounded<R>(
    mut reader: R,
    limit: usize,
    stream: OutputStream,
    overflow: mpsc::UnboundedSender<OutputStream>,
) -> io::Result<BoundedOutput>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(limit.min(8 * 1_024));
    let mut chunk = [0_u8; 8 * 1_024];
    let mut overflow_reported = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(BoundedOutput {
                bytes: retained,
                overflowed: overflow_reported,
            });
        }
        let keep = read.min(limit.saturating_sub(retained.len()));
        retained.extend_from_slice(&chunk[..keep]);
        if keep < read && !overflow_reported {
            overflow_reported = true;
            let _ = overflow.send(stream);
        }
    }
}

async fn join_output(
    task: tokio::task::JoinHandle<io::Result<BoundedOutput>>,
    stream: OutputStream,
) -> Result<BoundedOutput, ProcessError> {
    map_output_result(task.await, stream)
}

fn map_output_result(
    result: Result<io::Result<BoundedOutput>, tokio::task::JoinError>,
    stream: OutputStream,
) -> Result<BoundedOutput, ProcessError> {
    result
        .map_err(|error| ProcessError::OutputRead {
            stream,
            source: io::Error::other(error),
        })?
        .map_err(|source| ProcessError::OutputRead { stream, source })
}

fn output_overflow(
    spec: &ProcessSpec,
    stream: OutputStream,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> ProcessError {
    ProcessError::OutputOverflow {
        stream,
        limit: match stream {
            OutputStream::Stdout => spec.stdout_limit,
            OutputStream::Stderr => spec.stderr_limit,
        },
        stdout,
        stderr,
    }
}
