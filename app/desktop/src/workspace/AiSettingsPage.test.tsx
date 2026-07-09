// AiSettingsPage: the provider-configuration page. Every api.ts seam is
// stubbed; the suite drives the supported/unsupported recommendation branches,
// the non-fatal HF enrichment, the streamed download (progress → cancel /
// terminal success / terminal error), the installed-model actions behind their
// confirm, the OpenRouter key + switch flows, and the sidecar-failure surface.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiStatus,
  CandidateModel,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  PullEvent,
  Recommendation,
} from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn(),
    setActiveProvider: vi.fn(),
    saveApiKey: vi.fn(),
    setReasoning: vi.fn(),
    detectHardware: vi.fn(),
    localCandidates: vi.fn(),
    recommendLocalModel: vi.fn(),
    hfModelMetadata: vi.fn(),
    listLocalModels: vi.fn(),
    pullLocalModel: vi.fn(),
    cancelPull: vi.fn(),
    deleteLocalModel: vi.fn(),
  };
});

import * as api from "../lib/api";
import { AiSettingsPage } from "./AiSettingsPage";

const mockAiStatus = vi.mocked(api.aiStatus);
const mockSetActive = vi.mocked(api.setActiveProvider);
const mockSaveKey = vi.mocked(api.saveApiKey);
const mockSetReasoning = vi.mocked(api.setReasoning);
const mockHardware = vi.mocked(api.detectHardware);
const mockCandidates = vi.mocked(api.localCandidates);
const mockRecommend = vi.mocked(api.recommendLocalModel);
const mockHfMeta = vi.mocked(api.hfModelMetadata);
const mockInstalled = vi.mocked(api.listLocalModels);
const mockPull = vi.mocked(api.pullLocalModel);
const mockCancel = vi.mocked(api.cancelPull);
const mockDelete = vi.mocked(api.deleteLocalModel);

const GIB = 1024 ** 3;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const UNCONFIGURED: AiStatus = {
  activeProvider: null,
  openrouter: { hasKey: false, model: "anthropic/claude-sonnet-4.5", reasoning: false },
  local: { activeModelTag: null },
};
const OR_ACTIVE: AiStatus = {
  activeProvider: "openRouter",
  openrouter: { hasKey: true, model: "anthropic/claude-sonnet-4.5", reasoning: false },
  local: { activeModelTag: null },
};
const LOCAL_ACTIVE: AiStatus = {
  activeProvider: "local",
  openrouter: { hasKey: false, model: "anthropic/claude-sonnet-4.5", reasoning: false },
  local: { activeModelTag: "qwen2.5:7b" },
};

const HW: HardwareSpec = {
  totalRamBytes: 16 * GIB,
  cpuCores: 8,
  cpuBrand: "Apple M2",
  gpuLabel: null,
  arch: "aarch64",
  os: "macos",
};

const CANDIDATES: CandidateModel[] = [
  {
    tag: "qwen2.5:7b",
    params: "7.6B",
    downloadBytes: 4.7 * GIB,
    minRamBytes: 12 * GIB,
    license: "Apache-2.0",
    hfRepo: "Qwen/Qwen2.5-7B-Instruct",
  },
  {
    tag: "llama3.1:8b",
    params: "8.0B",
    downloadBytes: 4.9 * GIB,
    minRamBytes: 16 * GIB,
    license: "Llama 3.1",
    hfRepo: "meta-llama/Llama-3.1-8B-Instruct",
  },
];

const SUPPORTED: Recommendation = {
  status: "supported",
  modelTag: "qwen2.5:7b",
  params: "7.6B",
  estRamBytes: 8 * GIB,
  why: "Fits comfortably in this machine's memory.",
};
/** The exact backend copy for weak specs — rendered faithfully, never reworded. */
const UNSUPPORTED: Recommendation = {
  status: "unsupported",
  reason: "Local AI is unsupported due to your computer specs.",
};

const QWEN_META: HfModelMeta = {
  id: "Qwen/Qwen2.5-7B-Instruct",
  downloads: 1_234_000,
  likes: 900,
  lastModified: "2026-06-12T10:00:00Z",
  license: "apache-2.0",
};

const INSTALLED_QWEN: InstalledModel = {
  tag: "qwen2.5:7b",
  sizeBytes: 4.7 * GIB,
  family: "qwen2",
  parameterSize: "7.6B",
  quantization: "Q4_K_M",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Happy-path defaults; individual tests override the probe they exercise. */
function mockDefaults() {
  mockAiStatus.mockResolvedValue(UNCONFIGURED);
  mockHardware.mockResolvedValue(HW);
  mockCandidates.mockResolvedValue(CANDIDATES);
  mockRecommend.mockResolvedValue(SUPPORTED);
  mockHfMeta.mockRejectedValue(new Error("offline"));
  mockInstalled.mockResolvedValue([]);
  mockSetActive.mockResolvedValue(undefined);
  mockSaveKey.mockResolvedValue(undefined);
  // `set_reasoning` returns the freshly persisted status, like the Rust command.
  mockSetReasoning.mockResolvedValue(UNCONFIGURED);
  mockCancel.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
}

function setup() {
  const user = userEvent.setup();
  render(<AiSettingsPage />);
  return { user };
}

/** The page settles once the catalogue is on screen; returns `tag`'s row.
 *  Queries scope to the named list — the tag string also appears in the
 *  recommendation banner, the header chip, and the installed list. */
async function findCatalogueRow(tag: string) {
  const list = await screen.findByRole("list", { name: "Model catalogue" });
  return within(list).getByText(tag).closest("li")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDefaults();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AiSettingsPage — header + hardware", () => {
  it("shows 'Not configured' when no provider is set up", async () => {
    setup();
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("shows the active provider with its model", async () => {
    mockAiStatus.mockResolvedValue(OR_ACTIVE);
    setup();
    // The header chip shortens the model id (chip-only text, so unambiguous).
    expect(await screen.findByText("claude-sonnet-4.5")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("flags a local provider with no model selected as a fault", async () => {
    mockAiStatus.mockResolvedValue({
      ...LOCAL_ACTIVE,
      local: { activeModelTag: null },
    });
    setup();
    expect(
      await screen.findByText("Local — no model selected"),
    ).toBeInTheDocument();
  });

  it("renders the compact hardware readout", async () => {
    setup();
    expect(await screen.findByText("16 GB RAM")).toBeInTheDocument();
    expect(screen.getByText("Apple M2")).toBeInTheDocument();
    expect(screen.getByText("8 cores")).toBeInTheDocument();
    expect(screen.getByText("aarch64 / macos")).toBeInTheDocument();
  });

  it("surfaces a failed status read inline", async () => {
    mockAiStatus.mockRejectedValue({ kind: "io", message: "config unreadable" });
    setup();
    expect(await screen.findByText(/config unreadable/)).toBeInTheDocument();
  });
});

describe("AiSettingsPage — recommendation", () => {
  it("highlights the recommended model with its why", async () => {
    setup();
    expect(
      await screen.findByText("Recommended for this machine:"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Fits comfortably in this machine's memory\./),
    ).toBeInTheDocument();
    // The catalogue row carries the Recommended chip.
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("renders the unsupported reason verbatim and prominently", async () => {
    mockRecommend.mockResolvedValue(UNSUPPORTED);
    setup();
    expect(
      await screen.findByText("Local AI is unsupported due to your computer specs."),
    ).toBeInTheDocument();
    // No recommended chip when nothing is recommended.
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
  });

  it("surfaces a failed recommendation probe inline", async () => {
    mockRecommend.mockRejectedValue({ kind: "localAi", message: "probe failed" });
    setup();
    expect(await screen.findByText(/probe failed/)).toBeInTheDocument();
  });
});

describe("AiSettingsPage — catalogue + HF enrichment", () => {
  it("lists every curated model with its size, RAM floor, and license", async () => {
    setup();
    const qwen = await findCatalogueRow("qwen2.5:7b");
    expect(
      within(qwen).getByText(/7\.6B · 4\.7 GB download · needs 12 GB RAM · Apache-2\.0/),
    ).toBeInTheDocument();
    const llama = await findCatalogueRow("llama3.1:8b");
    expect(
      within(llama).getByText(/8\.0B · 4\.9 GB download · needs 16 GB RAM · Llama 3\.1/),
    ).toBeInTheDocument();
  });

  it("enriches a row with live HF metadata when the lookup succeeds", async () => {
    mockHfMeta.mockImplementation((repo) =>
      repo === QWEN_META.id
        ? Promise.resolve(QWEN_META)
        : Promise.reject(new Error("offline")),
    );
    setup();
    expect(
      await screen.findByText("1.2M downloads · apache-2.0 · updated 12 Jun 2026"),
    ).toBeInTheDocument();
  });

  it("omits the metadata line when HF is unreachable — never an error", async () => {
    // mockDefaults already rejects every HF lookup.
    setup();
    await findCatalogueRow("qwen2.5:7b");
    // Rows render fine; the rejection message never surfaces anywhere.
    await waitFor(() => expect(mockHfMeta).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
    expect(screen.queryByText(/downloads/)).not.toBeInTheDocument();
  });
});

describe("AiSettingsPage — download", () => {
  /** Click Download on `tag`, capturing the streamed-event callback. */
  async function startDownload(user: ReturnType<typeof userEvent.setup>, tag: string) {
    const gate = deferred<void>();
    let onEvent: ((ev: PullEvent) => void) | undefined;
    mockPull.mockImplementation((_tag, cb) => {
      onEvent = cb;
      return gate.promise;
    });
    const row = await findCatalogueRow(tag);
    await user.click(within(row).getByRole("button", { name: /download/i }));
    return { gate, emit: (ev: PullEvent) => act(() => onEvent!(ev)), row };
  }

  it("streams progress (status, bytes, percent) and can cancel", async () => {
    const { user } = setup();
    const { gate, emit, row } = await startDownload(user, "qwen2.5:7b");

    emit({
      type: "progress",
      status: "downloading model",
      digest: null,
      completed: 1.2 * GIB,
      total: 4.7 * GIB,
      percent: 26,
    });
    expect(within(row).getByText("downloading model")).toBeInTheDocument();
    expect(within(row).getByText(/1\.2 GB \/ 4\.7 GB · 26%/)).toBeInTheDocument();
    // Native <progress>: the value attribute is the progressbar's now-value.
    expect(
      within(row).getByRole("progressbar", { name: "Downloading qwen2.5:7b" }),
    ).toHaveAttribute("value", "26");
    // The other row's Download is held while a pull is in flight (one at a time).
    const otherRow = await findCatalogueRow("llama3.1:8b");
    expect(within(otherRow).getByRole("button", { name: /download/i })).toBeDisabled();

    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(mockCancel).toHaveBeenCalledOnce();

    // The backend answers a cancel with its one terminal error frame.
    emit({ type: "error", message: "download cancelled" });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(await within(row).findByText("download cancelled")).toBeInTheDocument();
    // The run ended — the Download button is back.
    expect(within(row).getByRole("button", { name: /download/i })).toBeEnabled();
  });

  it("activates the model on the terminal success event", async () => {
    mockAiStatus
      .mockResolvedValueOnce(UNCONFIGURED) // initial load
      .mockResolvedValue(LOCAL_ACTIVE); // refresh after activation
    mockInstalled
      .mockResolvedValueOnce([]) // initial load
      .mockResolvedValue([INSTALLED_QWEN]); // refresh after the pull
    const { user } = setup();
    const { gate, emit } = await startDownload(user, "qwen2.5:7b");

    emit({ type: "success" });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    await waitFor(() =>
      expect(mockSetActive).toHaveBeenCalledExactlyOnceWith("local", "qwen2.5:7b"),
    );
    // The refreshed status marks Local AI active (card badge + installed row),
    // and the freshly-pulled model now reads Installed in the catalogue.
    expect((await screen.findAllByText("Active")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Installed")).toBeInTheDocument();
  });

  it("surfaces a terminal pull error inline on the row", async () => {
    const { user } = setup();
    const { gate, emit, row } = await startDownload(user, "qwen2.5:7b");

    emit({ type: "error", message: "disk full" });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(await within(row).findByText("disk full")).toBeInTheDocument();
    expect(mockSetActive).not.toHaveBeenCalled();
  });

  it("surfaces a transport-level pull rejection, never silently", async () => {
    mockPull.mockRejectedValue({ kind: "localAi", message: "sidecar died" });
    const { user } = setup();
    const row = await findCatalogueRow("qwen2.5:7b");
    await user.click(within(row).getByRole("button", { name: /download/i }));

    expect(await within(row).findByText("sidecar died")).toBeInTheDocument();
  });
});

describe("AiSettingsPage — the catalogue never offers Download while installed-state is unknown", () => {
  it("shows a checking affordance — not Download — until the scan resolves", async () => {
    const scan = deferred<InstalledModel[]>();
    mockInstalled.mockReturnValue(scan.promise);
    setup();

    const row = await findCatalogueRow("qwen2.5:7b");
    // The scan hasn't answered yet: offering Download here would re-download
    // a model the user may already have (the observed bug).
    expect(screen.queryAllByRole("button", { name: /download/i })).toHaveLength(0);
    expect(within(row).getByText("Checking…")).toBeInTheDocument();
    // Nor can the row claim Installed — that isn't known yet either.
    expect(within(row).queryByText("Installed")).not.toBeInTheDocument();

    await act(async () => {
      scan.resolve([INSTALLED_QWEN]);
      await scan.promise;
    });

    // Resolved: the installed model reads Installed with no Download, and the
    // genuinely-absent model gets its Download back.
    expect(await within(row).findByText("Installed")).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: /download/i }),
    ).not.toBeInTheDocument();
    const otherRow = await findCatalogueRow("llama3.1:8b");
    expect(within(otherRow).getByRole("button", { name: /download/i })).toBeEnabled();
    expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
  });

  it("fails safe when the scan errors: Download held until Retry recovers", async () => {
    mockInstalled
      .mockRejectedValueOnce({ kind: "localAi", message: "sidecar failed to start" })
      .mockResolvedValue([INSTALLED_QWEN]);
    const { user } = setup();

    // The failure is surfaced (never silent) …
    expect(await screen.findByText("sidecar failed to start")).toBeInTheDocument();
    // … and no row offers an actionable Download while installed-state is
    // unverifiable — the button stays, disabled, so the layout doesn't jump.
    const row = await findCatalogueRow("qwen2.5:7b");
    expect(within(row).getByRole("button", { name: /download/i })).toBeDisabled();
    expect(within(row).queryByText("Installed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    // Recovery: the error clears, the installed model reads Installed, and
    // only the genuinely-absent model offers an enabled Download.
    expect(await within(row).findByText("Installed")).toBeInTheDocument();
    expect(screen.queryByText("sidecar failed to start")).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: /download/i }),
    ).not.toBeInTheDocument();
    const otherRow = await findCatalogueRow("llama3.1:8b");
    expect(within(otherRow).getByRole("button", { name: /download/i })).toBeEnabled();
  });
});

describe("AiSettingsPage — installed models", () => {
  it("lists installed models with disk size and lets one become active", async () => {
    mockAiStatus
      .mockResolvedValueOnce(UNCONFIGURED)
      .mockResolvedValue(LOCAL_ACTIVE);
    mockInstalled.mockResolvedValue([INSTALLED_QWEN]);
    const { user } = setup();

    expect(await screen.findByText(/4\.7 GB on disk · 7\.6B · Q4_K_M/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use this model" }));

    expect(mockSetActive).toHaveBeenCalledExactlyOnceWith("local", "qwen2.5:7b");
    // Refreshed status → the row (and the card header) now read Active, and
    // the switch affordance is gone.
    expect((await screen.findAllByText("Active")).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Use this model" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("deletes a model behind an explicit confirm", async () => {
    mockInstalled
      .mockResolvedValueOnce([INSTALLED_QWEN])
      .mockResolvedValue([]);
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Delete qwen2.5:7b" }));
    // Nothing happens until the ConfirmDialog's destructive confirm.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete qwen2.5:7b?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(mockDelete).toHaveBeenCalledExactlyOnceWith("qwen2.5:7b");
    // The refreshed (now empty) list replaces the row.
    expect(await screen.findByText("No local models installed yet.")).toBeInTheDocument();
  });

  it("cancelling the confirm leaves the model alone", async () => {
    mockInstalled.mockResolvedValue([INSTALLED_QWEN]);
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Delete qwen2.5:7b" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("surfaces a sidecar start failure with a working retry", async () => {
    mockInstalled
      .mockRejectedValueOnce({ kind: "localAi", message: "sidecar failed to start" })
      .mockResolvedValue([INSTALLED_QWEN]);
    const { user } = setup();

    expect(await screen.findByText("sidecar failed to start")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("qwen2.5:7b", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("sidecar failed to start")).not.toBeInTheDocument();
  });
});

describe("AiSettingsPage — OpenRouter", () => {
  it("disables 'Use OpenRouter' until a key is connected", async () => {
    setup();
    expect(await screen.findByRole("button", { name: "Use OpenRouter" })).toBeDisabled();
  });

  it("connects a key through the inline form, then refreshes the status", async () => {
    mockAiStatus
      .mockResolvedValueOnce(UNCONFIGURED)
      .mockResolvedValue(OR_ACTIVE);
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Connect a key…" }));
    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(mockSaveKey).toHaveBeenCalledExactlyOnceWith(
      "sk-or-secret",
      "anthropic/claude-sonnet-4.5",
    );
    // Status refreshed: the card now shows the connected key + Active badge.
    expect(await screen.findByText("Key connected")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("keeps the form open and surfaces the error when the key save fails", async () => {
    mockSaveKey.mockRejectedValue({ kind: "io", message: "keychain write failed" });
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Connect a key…" }));
    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-x");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("keychain write failed")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
  });

  it("switches to OpenRouter when a key exists", async () => {
    mockAiStatus
      .mockResolvedValueOnce({ ...LOCAL_ACTIVE, openrouter: { ...OR_ACTIVE.openrouter } })
      .mockResolvedValue(OR_ACTIVE);
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Use OpenRouter" }));
    expect(mockSetActive).toHaveBeenCalledExactlyOnceWith("openRouter");
  });

  it("surfaces a failed provider switch inline", async () => {
    mockAiStatus.mockResolvedValue({
      ...UNCONFIGURED,
      openrouter: { hasKey: true, model: "anthropic/claude-sonnet-4.5", reasoning: false },
    });
    mockSetActive.mockRejectedValue({ kind: "io", message: "config write failed" });
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Use OpenRouter" }));
    expect(await screen.findByText("config write failed")).toBeInTheDocument();
  });
});

describe("AiSettingsPage — OpenRouter reasoning toggle", () => {
  const REASONING_TOGGLE = { name: /show model reasoning/i };
  /** OR_ACTIVE with the reasoning opt-in persisted. */
  const OR_REASONING_ON: AiStatus = {
    ...OR_ACTIVE,
    openrouter: { ...OR_ACTIVE.openrouter, reasoning: true },
  };

  it("offers no reasoning toggle when no key is connected", async () => {
    setup(); // UNCONFIGURED default: hasKey false
    // Settle on the card's no-key affordance before asserting absence.
    expect(await screen.findByRole("button", { name: "Connect a key…" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", REASONING_TOGGLE)).not.toBeInTheDocument();
  });

  it("reflects the persisted reasoning state: off unchecked, on checked", async () => {
    mockAiStatus.mockResolvedValue(OR_ACTIVE); // reasoning: false
    const first = render(<AiSettingsPage />);
    expect(await screen.findByRole("checkbox", REASONING_TOGGLE)).not.toBeChecked();
    first.unmount();

    mockAiStatus.mockResolvedValue(OR_REASONING_ON);
    render(<AiSettingsPage />);
    expect(await screen.findByRole("checkbox", REASONING_TOGGLE)).toBeChecked();
  });

  it("opts in with one set_reasoning call and renders the status it returns", async () => {
    mockAiStatus.mockResolvedValue(OR_ACTIVE); // initial load: reasoning off
    mockSetReasoning.mockResolvedValue(OR_REASONING_ON); // the write's own echo
    const { user } = setup();

    await user.click(await screen.findByRole("checkbox", REASONING_TOGGLE));

    expect(mockSetReasoning).toHaveBeenCalledExactlyOnceWith(true);
    // The status the *write* returned — not a follow-up read — checks the box.
    await waitFor(() =>
      expect(screen.getByRole("checkbox", REASONING_TOGGLE)).toBeChecked(),
    );
  });

  // Regression: reasoning tokens are billed, so a toggle that reads "off" while
  // the config says "on" bills the user without consent. The old code re-read
  // `ai_status` after the write; because `refreshStatus` swallows its own error,
  // a read that failed after the write landed left the box unticked and silent.
  // Rendering the status the write returned removes that window entirely.
  it("shows the opt-in even when a subsequent status read would fail", async () => {
    mockAiStatus
      .mockResolvedValueOnce(OR_ACTIVE) // initial load succeeds: reasoning off
      .mockRejectedValue({ kind: "io", message: "config unreadable" }); // every later read fails
    mockSetReasoning.mockResolvedValue(OR_REASONING_ON); // but the write persisted
    const { user } = setup();

    await user.click(await screen.findByRole("checkbox", REASONING_TOGGLE));

    // The box tells the truth about what is persisted, and is never contradicted
    // by a stale read.
    await waitFor(() =>
      expect(screen.getByRole("checkbox", REASONING_TOGGLE)).toBeChecked(),
    );
    // No misleading inline error against the toggle: the write did succeed.
    expect(screen.queryByText("config unreadable")).not.toBeInTheDocument();
  });

  it("surfaces a rejected reasoning write inline and stays unchecked", async () => {
    mockAiStatus.mockResolvedValue(OR_ACTIVE);
    mockSetReasoning.mockRejectedValue({ kind: "io", message: "reasoning write failed" });
    const { user } = setup();

    await user.click(await screen.findByRole("checkbox", REASONING_TOGGLE));

    expect(await screen.findByText("reasoning write failed")).toBeInTheDocument();
    // Nothing was persisted, so the control never shows the opt-in.
    expect(screen.getByRole("checkbox", REASONING_TOGGLE)).not.toBeChecked();
  });
});
