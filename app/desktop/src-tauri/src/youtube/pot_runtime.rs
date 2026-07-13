use super::pot_protocol::{append_tail, redact_diagnostic};
use super::{PotChild, PotHttpMethod, PotHttpRequest, PotHttpResponse, PotRuntime, PotSpawnSpec};
use async_trait::async_trait;
use futures_util::StreamExt;
use std::io::Read;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const STDERR_LINE_LIMIT: usize = 8 * 1024;

pub(super) struct RealPotRuntime {
    client: Result<reqwest::Client, String>,
}

impl Default for RealPotRuntime {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .map_err(|error| error.to_string()),
        }
    }
}

#[async_trait]
impl PotRuntime for RealPotRuntime {
    fn reserve_loopback_port(&self) -> Result<u16, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        listener
            .local_addr()
            .map(|address| address.port())
            .map_err(|error| error.to_string())
    }

    fn spawn(&self, spec: &PotSpawnSpec) -> Result<Box<dyn PotChild>, String> {
        if !spec.program.is_absolute() {
            return Err("POT program path is not absolute".into());
        }
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "POT stderr pipe unavailable".to_string())?;
        let tail = Arc::new(Mutex::new(String::new()));
        let thread_tail = Arc::clone(&tail);
        let stderr_thread = std::thread::spawn(move || collect_stderr(stderr, &thread_tail));
        Ok(Box::new(RealPotChild {
            child,
            tail,
            stderr_thread: Some(stderr_thread),
        }))
    }

    async fn send(&self, request: PotHttpRequest) -> Result<PotHttpResponse, String> {
        let client = self.client.as_ref().map_err(Clone::clone)?;
        let mut builder = match request.method {
            PotHttpMethod::Get => client.get(&request.url),
            PotHttpMethod::Post => client.post(&request.url),
        }
        .timeout(request.timeout);
        if let Some(body) = request.body {
            builder = builder
                .header("Content-Type", "application/json")
                .body(body);
        }
        let response = builder.send().await.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            if body.len().saturating_add(chunk.len()) > request.response_limit {
                return Err("POT HTTP response exceeded its byte limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(PotHttpResponse { status, body })
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

struct RealPotChild {
    child: std::process::Child,
    tail: Arc<Mutex<String>>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
}

impl PotChild for RealPotChild {
    fn is_running(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| error.to_string())
    }

    fn stderr_tail(&self) -> String {
        self.tail
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn kill_and_wait(&mut self) -> Result<(), String> {
        if self
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            self.child.kill().map_err(|error| error.to_string())?;
            self.child.wait().map_err(|error| error.to_string())?;
        }
        if let Some(thread) = self.stderr_thread.take() {
            thread
                .join()
                .map_err(|_| "POT stderr reader panicked".to_string())?;
        }
        Ok(())
    }
}

impl Drop for RealPotChild {
    fn drop(&mut self) {
        let _ = self.kill_and_wait();
    }
}

fn collect_stderr(mut stderr: impl Read, tail: &Mutex<String>) {
    let mut chunk = [0_u8; 1024];
    let mut collector = StderrLineCollector::new(tail);
    while let Ok(read) = stderr.read(&mut chunk) {
        if read == 0 {
            break;
        }
        for &byte in &chunk[..read] {
            collector.push(byte);
        }
    }
    collector.finish();
}

struct StderrLineCollector<'a> {
    tail: &'a Mutex<String>,
    line: Vec<u8>,
    dropping: bool,
}

impl<'a> StderrLineCollector<'a> {
    fn new(tail: &'a Mutex<String>) -> Self {
        Self {
            tail,
            line: Vec::new(),
            dropping: false,
        }
    }

    fn push(&mut self, byte: u8) {
        if byte == b'\n' {
            self.flush_line();
        } else if !self.dropping && self.line.len() < STDERR_LINE_LIMIT {
            self.line.push(byte);
        } else if !self.dropping {
            self.line.clear();
            self.dropping = true;
            let mut output = self.tail.lock().unwrap_or_else(|error| error.into_inner());
            append_tail(&mut output, "[overlong POT diagnostic redacted]\n");
        }
    }

    fn flush_line(&mut self) {
        if !self.dropping {
            store_stderr_line(self.tail, &self.line);
        }
        self.line.clear();
        self.dropping = false;
    }

    fn finish(&mut self) {
        if !self.line.is_empty() && !self.dropping {
            store_stderr_line(self.tail, &self.line);
        }
    }
}

fn store_stderr_line(tail: &Mutex<String>, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    let line = redact_diagnostic(&line);
    let mut output = tail.lock().unwrap_or_else(|error| error.into_inner());
    append_tail(&mut output, &line);
    append_tail(&mut output, "\n");
}
