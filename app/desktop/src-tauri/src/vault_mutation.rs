use std::path::{Path, PathBuf};
use std::sync::Arc;

/// One gate per open vault. Clones share the same mutex, so every command that
/// captured the current vault context participates in the same mutation order.
#[derive(Clone, Default)]
pub(crate) struct VaultMutationGate {
    inner: Arc<tokio::sync::Mutex<()>>,
}

impl VaultMutationGate {
    pub(crate) async fn run<T>(&self, operation: impl FnOnce() -> T) -> T {
        let _guard = self.inner.lock().await;
        operation()
    }
}

/// The root and its gate are captured together under AppState's short lock.
/// A later vault switch therefore cannot pair an old root with the new gate.
pub(crate) struct VaultMutationContext {
    root: PathBuf,
    gate: VaultMutationGate,
}

impl VaultMutationContext {
    pub(crate) fn new(root: PathBuf, gate: VaultMutationGate) -> Self {
        Self { root, gate }
    }

    pub(crate) async fn run<T>(&self, operation: impl FnOnce(&Path) -> T) -> T {
        self.gate.run(|| operation(&self.root)).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use tokio::sync::oneshot;

    use super::VaultMutationGate;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_second_vault_mutation_waits_for_the_first_to_finish() {
        let gate = VaultMutationGate::default();
        let first_gate = gate.clone();
        let (first_entered_tx, first_entered_rx) = oneshot::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first = tokio::spawn(async move {
            first_gate
                .run(move || {
                    first_entered_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                })
                .await;
        });
        first_entered_rx.await.unwrap();

        let second_gate = gate.clone();
        let (second_entered_tx, mut second_entered_rx) = oneshot::channel();
        let second = tokio::spawn(async move {
            second_gate
                .run(move || {
                    second_entered_tx.send(()).unwrap();
                })
                .await;
        });

        tokio::task::yield_now().await;
        assert!(matches!(
            second_entered_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        release_first_tx.send(()).unwrap();
        first.await.unwrap();
        second_entered_rx.await.unwrap();
        second.await.unwrap();
    }
}
