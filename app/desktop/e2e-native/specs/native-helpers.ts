import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { $, browser } from "@wdio/globals";

import {
  assertCloseTabDiscardDialog,
  classifyNativeNotifications,
} from "../native-cleanup-policy.js";
import { CURRENT_RELEASE_NOTES } from "../../src/whats-new/releaseNotes.js";

export interface NativeCoreError {
  kind?: string;
  message?: string;
}

export interface NativeNoteDoc {
  path: string;
  relPath: string;
  raw: string;
  body: string;
  contentHash: string;
  binary: boolean;
  lossyText: boolean;
  exceedsEditableSize: boolean;
  sizeBytes: number;
}

export interface InvokeOutcome<T> {
  ok: boolean;
  value?: T;
  error?: NativeCoreError | string;
}

interface TauriExecutionApi {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
}

interface BrowserWithTauri {
  tauri: {
    execute<TResult, TArgs extends unknown[]>(
      callback: (api: TauriExecutionApi, ...args: TArgs) => Promise<TResult> | TResult,
      ...args: TArgs
    ): Promise<TResult>;
  };
}

export function fixturePaths() {
  const root = process.env.NEURALNOTE_E2E_ROOT;
  if (!root) throw new Error("NEURALNOTE_E2E_ROOT is required");
  const vault = path.join(root, "vaults", "Native Fixture");
  return {
    root,
    vault,
    start: path.join(vault, "Start.md"),
    markdown: path.join(vault, "Markdown Compatibility.md"),
    crlf: path.join(vault, "CRLF.md"),
    mixed: path.join(vault, "Mixed Endings.md"),
    oversized: path.join(vault, "Oversized.md"),
    archive: path.join(vault, "Archive"),
  };
}

export async function dismissWhatsNewIfPresent(): Promise<void> {
  const continuation = await $("button=Continue to NeuralNote");
  if (!(await continuation.isExisting())) return;

  await continuation.waitForClickable({ timeout: 30_000 });
  await continuation.click();
  await continuation.waitForExist({ reverse: true, timeout: 10_000 });
  await browser.waitUntil(
    async () => {
      try {
        const loaded = await invoke<{
          preferences: { lastSeenWhatsNewVersion: string | null };
        }>("load_app_preferences");
        return loaded.preferences.lastSeenWhatsNewVersion === CURRENT_RELEASE_NOTES.version;
      } catch {
        return false;
      }
    },
    { timeout: 10_000, interval: 50 },
  );
}

const OPEN_NOTE_CLOSE = "[role='tablist'][aria-label='Open notes'] button[aria-label^='Close ']";

async function elementCount(selector: string): Promise<number> {
  return browser.execute(
    (expectedSelector) => document.querySelectorAll(expectedSelector).length,
    selector,
  );
}

async function expectedNativeNotificationLabels(): Promise<string[]> {
  const notifications = await browser.execute(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[aria-label='Notifications'] [data-testid='toast']",
      ),
    ].map((notification) => ({
      kind: notification.dataset.toastKind ?? "",
      label: notification.getAttribute("aria-label") ?? "",
    })),
  );
  return classifyNativeNotifications(notifications);
}

/**
 * The unsigned E2E build has no updater plugin, direct lifecycle tests can leave
 * a stale no-vault toast in React, and release-note setup emits one success toast.
 * Those known notifications can cover toolbar controls at the fixed viewport.
 * Any other notification is a product failure and must remain visible by failing
 * cleanup instead of being dismissed.
 */
export async function dismissNativeNotifications(): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const expectedLabels = await expectedNativeNotificationLabels();
    if (expectedLabels.length === 0) return;
    const dismiss = await $(
      "[aria-label='Notifications'] button[aria-label='Dismiss notification']",
    );
    // Classification above proves every current toast is an exact harness
    // notification, so the freshly acquired first dismiss control is safe.
    // Avoid WebKit's unreliable clickable/visible heuristics and keep the real
    // WebDriver pointer click that already succeeds for these fixed controls.
    await dismiss.click();
    const before = expectedLabels.length;
    await browser.waitUntil(
      async () => (await expectedNativeNotificationLabels()).length < before,
      { timeout: 10_000, interval: 50 },
    );
  }
  throw new Error("native E2E notification cleanup exceeded its bounded limit");
}

async function assertNoPendingAlertDialog(): Promise<void> {
  const dialog = await $("[role='alertdialog']");
  if (await dialog.isExisting()) {
    throw new Error("unexpected pending native alert dialog");
  }
}

async function discardCloseTabDraftIfPresent(): Promise<void> {
  const dialog = await $("[role='alertdialog']");
  if (!(await dialog.isExisting())) return;
  assertCloseTabDiscardDialog(await dialog.getText());
  const discard = await $(
    "//*[@role='alertdialog']//button[normalize-space(.)='Discard']",
  );
  await discard.waitForClickable({ timeout: 10_000 });
  await discard.click();
  await dialog.waitForExist({ reverse: true, timeout: 10_000 });
}

/**
 * UI specs share one packaged-app session. Remove prior synthetic fixture tabs
 * through the real close/discard controls so a failed test cannot leak a draft,
 * conflict, or deleted-file state into the next journey.
 */
export async function closeOpenNotesDiscardingDrafts(): Promise<void> {
  await dismissNativeNotifications();
  await assertNoPendingAlertDialog();

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const before = await elementCount(OPEN_NOTE_CLOSE);
    if (before === 0) return;
    await $(OPEN_NOTE_CLOSE).click();
    await browser.waitUntil(
      async () =>
        (await $("[role='alertdialog']").isExisting()) ||
        (await elementCount(OPEN_NOTE_CLOSE)) < before,
      { timeout: 10_000, interval: 50 },
    );
    await discardCloseTabDraftIfPresent();
    await browser.waitUntil(async () => (await elementCount(OPEN_NOTE_CLOSE)) < before, {
      timeout: 10_000,
      interval: 50,
    });
  }
  throw new Error("native E2E tab cleanup exceeded its bounded limit");
}

export async function invokeOutcome<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<InvokeOutcome<T>> {
  const nativeBrowser = browser as typeof browser & BrowserWithTauri;
  return nativeBrowser.tauri.execute(
    async ({ core }, invokeCommand, invokeArgs) => {
      try {
        return {
          ok: true,
          value: await core.invoke(invokeCommand, invokeArgs),
        };
      } catch (error) {
        const normalized =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? { kind: error.name, message: error.message }
              : { message: JSON.stringify(error) };
        return { ok: false, error: normalized };
      }
    },
    command,
    args,
  );
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const outcome = await invokeOutcome<T>(command, args);
  if (!outcome.ok) {
    throw new Error(`native invoke ${command} failed: ${JSON.stringify(outcome.error)}`);
  }
  return outcome.value as T;
}

export async function openFixtureVault(): Promise<void> {
  await invoke("open_vault", { path: fixturePaths().vault });
}

/**
 * Establish both sides of the native workspace boundary for each UI suite.
 * A direct IPC suite may have closed the Rust vault while React still shows its
 * retained workspace, so an existing workspace is re-authorised in Rust. A
 * welcome screen instead enters through the real pre-authorised recent-vault UI.
 */
export async function ensureFixtureWorkspace(): Promise<void> {
  const tabs = await $("[role='tablist'][aria-label='Open notes']");
  if (await tabs.isExisting()) {
    await openFixtureVault();
    await dismissWhatsNewIfPresent();
    await dismissNativeNotifications();
    return;
  }

  await dismissWhatsNewIfPresent();
  const recent = await $("button[aria-label='Open Native Fixture']");
  await recent.waitForDisplayed({ timeout: 30_000 });
  await recent.click();
  await tabs.waitForExist({ timeout: 30_000 });
  await dismissNativeNotifications();
}

export async function resetFixtureWorkspace(): Promise<void> {
  await ensureFixtureWorkspace();
  await closeOpenNotesDiscardingDrafts();
  // Re-establish the Rust side after any earlier direct-IPC lifecycle journey.
  // Closing note tabs does not close the vault, but this fixed idempotent open
  // makes the boundary explicit before a test rewrites its synthetic fixture.
  await openFixtureVault();
  await dismissNativeNotifications();
}

export async function clickVisibleTreeNote(label: string): Promise<void> {
  const note = await $(`//*[@role='treeitem']//button[.//span[normalize-space(.)='${label}']]`);
  // WKWebView's WebDriver hit-test intermittently reports visible tree rows as
  // not clickable even though the following real click succeeds. Visibility is
  // the stable readiness condition; click remains the interaction assertion.
  await note.waitForDisplayed({ timeout: 30_000 });
  await note.click();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedLabel) =>
          [...document.querySelectorAll("[role='treeitem'][aria-selected='true']")].some(
            (row) => row.textContent?.includes(expectedLabel),
          ),
        label,
      ),
    { timeout: 10_000, interval: 50 },
  );
}

export async function appendToSourceEditor(text: string): Promise<void> {
  const editor = await $("[role='textbox'][aria-label='Note content']");
  await editor.waitForExist({ timeout: 30_000 });
  await browser.execute((insertedText) => {
    const bridge = window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1;
    if (typeof bridge?.append !== "function") {
      throw new Error("native E2E editor bridge is absent");
    }
    bridge.append(insertedText);
  }, text);
}

export async function currentSourceMatches(expected: string): Promise<boolean> {
  return browser.execute((expectedSource) => {
    const bridge = window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1;
    if (typeof bridge?.matchesDocument !== "function") {
      throw new Error("native E2E document-match bridge is absent");
    }
    return bridge.matchesDocument(expectedSource);
  }, expected);
}

export async function saveThroughMacOsKeyboardAccelerator(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("the AppKit save accelerator probe is available only on macOS");
  }
  await invoke<void>("native_e2e_post_save_accelerator");
}

export async function closeVaultViaNativeMenuAction(): Promise<void> {
  await browser.execute(async () => {
    const bridge = window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1;
    if (typeof bridge?.closeVaultViaNativeMenuAction !== "function") {
      throw new Error("native E2E menu bridge is absent");
    }
    await bridge.closeVaultViaNativeMenuAction();
  });
}

export function restoreStartSource(): string {
  const source = "# Native start\n\nExact source.\n";
  writeFileSync(fixturePaths().start, source, "utf8");
  return source;
}

export function bytes(pathname: string): Buffer {
  return readFileSync(pathname);
}
