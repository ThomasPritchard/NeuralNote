export type UpdateCheckSource = "manual" | "background";

export interface UpdateMetadata {
  version: string;
  notes?: string;
  date?: string;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface PlatformUpdate extends UpdateMetadata {
  downloadAndInstall(
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface UpdatePlatform {
  check(): Promise<PlatformUpdate | null>;
  relaunch(): Promise<void>;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking"; source: UpdateCheckSource }
  | { status: "upToDate" }
  | { status: "available"; update: UpdateMetadata }
  | {
      status: "installing";
      update: UpdateMetadata;
      downloadedBytes: number;
      totalBytes?: number;
    }
  | { status: "relaunching"; update: UpdateMetadata }
  | { status: "checkFailed"; message: string }
  | { status: "installFailed"; update: UpdateMetadata; message: string };

export interface UpdateServiceOptions {
  onAutomaticError?: (message: string) => void;
}

export interface UpdateService {
  check(source: UpdateCheckSource): Promise<UpdateState>;
  installAndRelaunch(): Promise<void>;
  getState(): UpdateState;
  getLastAutomaticError(): string | null;
  subscribe(listener: (state: UpdateState) => void): () => void;
  subscribeAutomaticErrors(listener: (message: string) => void): () => void;
  dispose(): Promise<void>;
}

function metadataOf(update: PlatformUpdate): UpdateMetadata {
  return {
    version: update.version,
    ...(update.notes === undefined ? {} : { notes: update.notes }),
    ...(update.date === undefined ? {} : { date: update.date }),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The update operation failed.";
}

export function createUpdateService(
  platform: UpdatePlatform,
  options: UpdateServiceOptions = {},
): UpdateService {
  let state: UpdateState = { status: "idle" };
  let acceptedUpdate: PlatformUpdate | null = null;
  let installInProgress = false;
  let lastAutomaticError: string | null = null;
  let automaticErrorReported = false;
  const listeners = new Set<(next: UpdateState) => void>();
  const automaticErrorListeners = new Set<(message: string) => void>();
  if (options.onAutomaticError) {
    automaticErrorListeners.add(options.onAutomaticError);
  }

  const setState = (next: UpdateState) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };

  const replaceUpdate = async (next: PlatformUpdate | null) => {
    const previous = acceptedUpdate;
    acceptedUpdate = next;
    if (previous && previous !== next) await previous.close();
  };

  const check = async (source: UpdateCheckSource): Promise<UpdateState> => {
    if (source === "manual") setState({ status: "checking", source });

    try {
      const update = await platform.check();
      await replaceUpdate(update);
      if (update) {
        setState({ status: "available", update: metadataOf(update) });
      } else if (source === "manual") {
        setState({ status: "upToDate" });
      } else {
        setState({ status: "idle" });
      }
      return state;
    } catch (error) {
      const message = messageOf(error);
      if (source === "manual") {
        setState({ status: "checkFailed", message });
      } else {
        lastAutomaticError = message;
        setState({ status: "idle" });
        if (!automaticErrorReported) {
          automaticErrorReported = true;
          automaticErrorListeners.forEach((listener) => {
            try {
              listener(message);
            } catch (observerError) {
              console.error(
                "Automatic update error observer failed:",
                observerError,
              );
            }
          });
        }
      }
      throw error;
    }
  };

  const installAndRelaunch = async (): Promise<void> => {
    const update = acceptedUpdate;
    if (!update) throw new Error("No update is available to install.");
    if (installInProgress) {
      throw new Error("An update installation is already in progress.");
    }
    installInProgress = true;

    const metadata = metadataOf(update);
    setState({
      status: "installing",
      update: metadata,
      downloadedBytes: 0,
    });

    try {
      await update.downloadAndInstall((progress) => {
        setState({ status: "installing", update: metadata, ...progress });
      });
      setState({ status: "relaunching", update: metadata });
      await platform.relaunch();
    } catch (error) {
      setState({
        status: "installFailed",
        update: metadata,
        message: messageOf(error),
      });
      throw error;
    } finally {
      installInProgress = false;
    }
  };

  return {
    check,
    installAndRelaunch,
    getState: () => state,
    getLastAutomaticError: () => lastAutomaticError,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeAutomaticErrors(listener) {
      automaticErrorListeners.add(listener);
      return () => automaticErrorListeners.delete(listener);
    },
    async dispose() {
      listeners.clear();
      automaticErrorListeners.clear();
      await replaceUpdate(null);
    },
  };
}
