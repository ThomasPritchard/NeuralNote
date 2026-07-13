/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import capability from "../../src-tauri/capabilities/default.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("alpha release configuration", () => {
  it("keeps all published versions fixed at 0.1.0", () => {
    expect(packageJson.version).toBe("0.1.0");
    expect(tauriConfig.version).toBe("0.1.0");
    expect(cargoToml).toMatch(/^version = "0\.1\.0"$/m);
  });

  it("uses signed updater artifacts and the dedicated HTTPS alpha manifest", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://raw.githubusercontent.com/ThomasPritchard/NeuralNote/release-manifests/latest-alpha.json",
    ]);
    expect(JSON.stringify(tauriConfig)).not.toContain("PRIVATE_KEY");
  });

  it("grants only the plugin operations used by the consent flow", () => {
    const permissions = capability.permissions;

    expect(permissions).toEqual(
      expect.arrayContaining([
        "updater:allow-check",
        "updater:allow-download-and-install",
        "process:allow-restart",
        "autostart:allow-is-enabled",
        "autostart:allow-enable",
        "autostart:allow-disable",
      ]),
    );
    expect(permissions).not.toEqual(
      expect.arrayContaining([
        "updater:allow-download",
        "updater:allow-install",
        "process:allow-exit",
        "shell:allow-execute",
      ]),
    );
  });
});
