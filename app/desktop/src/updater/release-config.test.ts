/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";

import nativeE2ePackageJson from "../../e2e-native/package.json";
import packageJson from "../../package.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import capability from "../../src-tauri/capabilities/default.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("alpha release configuration", () => {
  it("keeps app-local published versions fixed at 0.2.1", () => {
    expect(packageJson.version).toBe("0.2.1");
    expect(nativeE2ePackageJson.version).toBe("0.2.1");
    expect(tauriConfig.version).toBe("0.2.1");
    expect(cargoToml).toMatch(/^version = "0\.2\.1"$/m);
  });

  it("uses signed updater artifacts and the dedicated HTTPS alpha manifest", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://raw.githubusercontent.com/ThomasPritchard/NeuralNote/release-manifests/latest-alpha.json",
    ]);
    expect(JSON.stringify(tauriConfig)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerousInsecureTransportProtocol");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerousAcceptInvalidCerts");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerousAcceptInvalidHostnames");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerous-insecure-transport-protocol");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerous-accept-invalid-certs");
    expect(JSON.stringify(tauriConfig)).not.toContain("dangerous-accept-invalid-hostnames");
  });

  it("audits both frontend lockfiles through one release gate", () => {
    expect(packageJson.scripts["audit:all"]).toBe(
      "npm audit --audit-level=high && npm --prefix e2e-native audit --audit-level=high",
    );
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
        "core:window:allow-is-fullscreen",
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
