interface NativeBootstrapState {
  currentInvoke: boolean;
  editorBridge: boolean;
  originalInvoke: boolean;
  waitForInit: boolean;
}

interface ScriptDriver {
  execute(script: () => unknown): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: unknown } };
    __wdio_original_core__?: { invoke?: unknown };
    NEURALNOTE_NATIVE_E2E_BRIDGE_V1?: {
      replaceFirst?(expected: string, replacement: string): boolean;
      matchesDocument?(expected: string): boolean;
      append?(text: string): void;
      closeVaultViaNativeMenuAction?(): Promise<void>;
    };
    wdioTauri?: { waitForInit?: () => Promise<void> };
  }
}

function readBootstrapState(): NativeBootstrapState {
  const tauri = Reflect.get(window, "__TAURI__") as Window["__TAURI__"];
  const originalCore = Reflect.get(
    window,
    "__wdio_original_core__",
  ) as Window["__wdio_original_core__"];
  return {
    currentInvoke: typeof tauri?.core?.invoke === "function",
    editorBridge:
      typeof window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1?.replaceFirst === "function" &&
      typeof window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1?.matchesDocument === "function" &&
      typeof window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1?.append === "function" &&
      typeof window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1?.closeVaultViaNativeMenuAction === "function",
    originalInvoke: typeof originalCore?.invoke === "function",
    waitForInit: typeof window.wdioTauri?.waitForInit === "function",
  };
}

function requireBootstrap(state: NativeBootstrapState): void {
  if (state.currentInvoke && (!state.originalInvoke || !state.waitForInit)) {
    throw new Error(
      "Tauri core is present, but the WebdriverIO frontend bootstrap is absent; " +
        "the native-e2e frontend must import @wdio/tauri-plugin before App mounts",
    );
  }
  if (!state.currentInvoke) {
    throw new Error("The native E2E window does not expose window.__TAURI__.core.invoke");
  }
  if (!state.originalInvoke || !state.waitForInit) {
    throw new Error("The WebdriverIO Tauri frontend bootstrap is incomplete");
  }
  if (!state.editorBridge) {
    throw new Error("The native E2E editor bridge is absent");
  }
}

/**
 * Make bootstrap failure immediate and diagnostic. This deliberately performs
 * one inspection, one plugin readiness await and no polling or fixed sleeps.
 */
export async function assertNativeFrontendReady(driver: ScriptDriver): Promise<void> {
  const initial = (await driver.execute(readBootstrapState)) as NativeBootstrapState;
  requireBootstrap(initial);

  await driver.execute(async () => {
    await window.wdioTauri?.waitForInit?.();
  });
}
