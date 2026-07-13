// Settings › Skills: the catalogue load states (loading / error+retry /
// ready), the enable switch's persisted-echo discipline (render what the
// backend reports landed on disk — including when that contradicts the
// request — and never show a failed write as flipped), per-requirement status
// rendering (installed / missing with visible reasons / couldn't check), and
// the requirement download flow (progress, cancel, terminal error, and the
// catalogue re-read on success).

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PullEvent,
  RequirementStatus,
  SkillListing,
  SkillRequirement,
} from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    setSkillEnabled: vi.fn(),
    downloadRequirement: vi.fn(),
    cancelRequirementDownload: vi.fn(),
  };
});

import * as api from "../lib/api";
import { SkillsSettingsPage } from "./SkillsSettingsPage";

const mockList = vi.mocked(api.listSkills);
const mockSetEnabled = vi.mocked(api.setSkillEnabled);
const mockDownload = vi.mocked(api.downloadRequirement);
const mockCancel = vi.mocked(api.cancelRequirementDownload);

const listing = (over: Partial<SkillListing> = {}): SkillListing => ({
  id: "fixture-note-workflow",
  name: "Fixture note workflow",
  description: "Demonstrate progress, elicitation, and a guarded note write.",
  icon: "flask",
  enabled: true,
  requirements: [],
  ...over,
});

const binaryReq = (status: RequirementStatus): SkillRequirement => ({
  requirement: { type: "binary", name: "yt-dlp" },
  status,
});

const fixtureSwitch = () =>
  screen.getByRole("switch", { name: "Enable Fixture note workflow" });

function setup() {
  const user = userEvent.setup();
  render(<SkillsSettingsPage />);
  return { user };
}

beforeEach(() => {
  mockList.mockReset();
  mockSetEnabled.mockReset();
  mockDownload.mockReset();
  mockCancel.mockReset();
  mockList.mockResolvedValue([listing()]);
  mockCancel.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsSettingsPage — catalogue load", () => {
  it("shows a loading line until the catalogue resolves", () => {
    mockList.mockImplementation(() => new Promise<SkillListing[]>(() => {}));
    setup();
    expect(screen.getByText("Loading skills…")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("lists each skill with its description and a switch on the persisted state", async () => {
    mockList.mockResolvedValue([
      listing(),
      listing({
        id: "youtube-distil",
        name: "YouTube distil",
        description: "Distil a video into notes.",
        enabled: false,
      }),
    ]);
    setup();

    expect(await screen.findByText("Fixture note workflow")).toBeInTheDocument();
    expect(
      screen.getByText("Demonstrate progress, elicitation, and a guarded note write."),
    ).toBeInTheDocument();
    expect(fixtureSwitch()).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", { name: "Enable YouTube distil" }),
    ).toHaveAttribute("aria-checked", "false");
    // No requirements → an honest quiet line, not a blank block.
    expect(screen.getAllByText("No extra software needed.")).toHaveLength(2);
    // Deferred capability: the page must say nothing about authoring skills.
    expect(screen.queryByText(/creat|import/i)).not.toBeInTheDocument();
  });

  it("surfaces a failed load inline, and Retry re-reads the catalogue", async () => {
    mockList.mockRejectedValueOnce({ kind: "io", message: "registry exploded" });
    const { user } = setup();

    expect(
      await screen.findByText(/Couldn't load skills: registry exploded/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fixture note workflow")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});

describe("SkillsSettingsPage — enable switch", () => {
  it("disables a skill and renders the state the backend persisted", async () => {
    mockSetEnabled.mockResolvedValue(false);
    const { user } = setup();

    await user.click(await screen.findByRole("switch", { name: "Enable Fixture note workflow" }));

    expect(mockSetEnabled).toHaveBeenCalledExactlyOnceWith(
      "fixture-note-workflow",
      false,
    );
    await waitFor(() =>
      expect(fixtureSwitch()).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("holds the switch (native disabled) while the write is in flight", async () => {
    mockSetEnabled.mockImplementation(() => new Promise<boolean>(() => {}));
    const { user } = setup();

    await user.click(await screen.findByRole("switch", { name: "Enable Fixture note workflow" }));
    expect(fixtureSwitch()).toBeDisabled();
    // Still showing the last persisted state, not the requested one.
    expect(fixtureSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("a failed write keeps the persisted state and announces the failure", async () => {
    mockSetEnabled.mockRejectedValue({ kind: "io", message: "disk full" });
    const { user } = setup();

    await user.click(await screen.findByRole("switch", { name: "Enable Fixture note workflow" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save the change: disk full");
    // The switch must not lie: the write never landed, so it stays on.
    expect(fixtureSwitch()).toHaveAttribute("aria-checked", "true");
    expect(fixtureSwitch()).toBeEnabled();
  });

  it("renders the backend's echo even when it contradicts the request", async () => {
    // The write "succeeded" but the persisted state read back is still true —
    // the switch shows what is on disk, never the optimistic flip.
    mockSetEnabled.mockResolvedValue(true);
    const { user } = setup();

    await user.click(await screen.findByRole("switch", { name: "Enable Fixture note workflow" }));

    await waitFor(() => expect(fixtureSwitch()).toBeEnabled());
    expect(fixtureSwitch()).toHaveAttribute("aria-checked", "true");
  });
});

describe("SkillsSettingsPage — requirement status", () => {
  it("renders installed / missing-with-reasons / couldn't-check per requirement", async () => {
    mockList.mockResolvedValue([
      listing({
        requirements: [
          binaryReq({ status: "installed" }),
          {
            requirement: { type: "platform", os: "macos", arch: "aarch64" },
            status: {
              status: "undetected",
              reasons: ["Couldn't read this machine's architecture."],
            },
          },
          {
            requirement: { type: "freeDiskSpace", minBytes: 2 * 1024 ** 3 },
            status: {
              status: "unmetAndUndetected",
              unmet: ["Only 1 GB of disk is free; 2 GB is needed."],
              undetected: ["The download volume couldn't be checked."],
            },
          },
        ],
      }),
    ]);
    setup();

    const reqs = await screen.findByRole("list", { name: "Requirements" });
    expect(within(reqs).getByText("yt-dlp")).toBeInTheDocument();
    expect(within(reqs).getByText("Installed")).toBeInTheDocument();

    expect(within(reqs).getByText("macos / aarch64")).toBeInTheDocument();
    expect(within(reqs).getByText("Couldn't check")).toBeInTheDocument();
    expect(
      within(reqs).getByText("Couldn't read this machine's architecture."),
    ).toBeInTheDocument();

    expect(within(reqs).getByText("2 GB free disk space")).toBeInTheDocument();
    expect(within(reqs).getByText("Missing")).toBeInTheDocument();
    // Both halves of the combined status stay visible — the unmet reason AND
    // the detection failure, never one folded into the other.
    expect(
      within(reqs).getByText("Only 1 GB of disk is free; 2 GB is needed."),
    ).toBeInTheDocument();
    expect(
      within(reqs).getByText("The download volume couldn't be checked."),
    ).toBeInTheDocument();

    // An installed requirement offers no download; non-binaries never do.
    expect(within(reqs).queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("labels an asset as a required file — distinct from a binary — and offers no download for it", async () => {
    mockList.mockResolvedValue([
      listing({
        requirements: [
          binaryReq({ status: "unmet", reasons: ["yt-dlp was not found."] }),
          {
            requirement: { type: "asset", name: "whisper-small.en.bin" },
            status: {
              status: "unmet",
              reasons: ["whisper-small.en.bin was not found."],
            },
          },
        ],
      }),
    ]);
    setup();

    const reqs = await screen.findByRole("list", { name: "Requirements" });
    // The label says what the thing is: a required file, never a bare name
    // that could read as a program the way a binary's does.
    const assetLabel = within(reqs).getByText(/Required file:/);
    expect(assetLabel).toHaveTextContent("Required file: whisper-small.en.bin");

    // Same status-chip treatment as every other requirement, reasons visible.
    expect(within(reqs).getAllByText("Missing")).toHaveLength(2);
    expect(
      within(reqs).getByText("whisper-small.en.bin was not found."),
    ).toBeInTheDocument();

    // The missing binary offers Download; the missing asset does not — the
    // download pipeline is binary-specific (TODO(asset-download-ui)).
    const downloads = within(reqs).getAllByRole("button", { name: "Download" });
    expect(downloads).toHaveLength(1);
  });

  it("shows the missing reasons for an unmet binary alongside its Download action", async () => {
    mockList.mockResolvedValue([
      listing({
        requirements: [
          binaryReq({
            status: "unmet",
            reasons: ["yt-dlp was not found on this machine."],
          }),
        ],
      }),
    ]);
    setup();

    expect(
      await screen.findByText("yt-dlp was not found on this machine."),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });
});

describe("SkillsSettingsPage — requirement download", () => {
  const MISSING = listing({
    requirements: [
      binaryReq({ status: "unmet", reasons: ["yt-dlp was not found."] }),
    ],
  });

  /** Wire downloadRequirement to capture its event channel and stay pending
   *  until the test settles it — the frame-by-frame control the UI states
   *  need. */
  function scriptedDownload() {
    let onEvent: ((ev: PullEvent) => void) | null = null;
    let settle: (() => void) | null = null;
    mockDownload.mockImplementation((_name, handler) => {
      onEvent = handler;
      return new Promise<void>((res) => {
        settle = res;
      });
    });
    return {
      emit: (ev: PullEvent) => act(() => onEvent!(ev)),
      settle: () => act(() => settle!()),
    };
  }

  it("streams progress with a cancel affordance, and surfaces a terminal error inline", async () => {
    mockList.mockResolvedValue([MISSING]);
    const download = scriptedDownload();
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Download" }));
    expect(mockDownload).toHaveBeenCalledExactlyOnceWith(
      "yt-dlp",
      expect.any(Function),
    );

    download.emit({
      type: "progress",
      status: "downloading",
      digest: null,
      completed: 1024 ** 3,
      total: 2 * 1024 ** 3,
      percent: 50,
    });
    const bar = screen.getByRole("progressbar", { name: "Downloading yt-dlp" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("1.0 GB / 2.0 GB · 50%")).toBeInTheDocument();

    // Cancel goes through the single cancel channel.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockCancel).toHaveBeenCalledOnce();

    // The one terminal failure frame (cancellation included) lands inline on
    // the requirement row, and the download becomes retryable.
    download.emit({ type: "error", message: "download cancelled" });
    download.settle();
    expect(await screen.findByText("download cancelled")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("a transport-level rejection frees the row — inline error, never stranded in 'downloading'", async () => {
    mockList.mockResolvedValue([MISSING]);
    mockDownload.mockRejectedValue({ kind: "io", message: "sidecar unreachable" });
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Download" }));

    // The rejection takes the same inline lane as a streamed terminal error…
    expect(await screen.findByText("sidecar unreachable")).toBeInTheDocument();
    // …and the row is released: no progress bar, no Cancel, and the Download
    // action is back and retryable.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("re-reads the catalogue on success so the backend re-evaluates statuses", async () => {
    mockList
      .mockResolvedValueOnce([MISSING])
      .mockResolvedValueOnce([
        listing({ requirements: [binaryReq({ status: "installed" })] }),
      ]);
    const download = scriptedDownload();
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Download" }));
    download.emit({ type: "success" });
    download.settle();

    // Installed comes from the backend's re-evaluation, never from the page
    // marking the requirement done itself.
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });
});
