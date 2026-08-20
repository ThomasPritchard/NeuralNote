// The approval controls in Settings: the global mode, the per-tool exceptions,
// and the one confirmation that stands between a user and YOLO mode.
//
// Everything asserted here is rendered from values Rust computed. The suite
// checks that the page tells the truth about them — including the two truths it
// would be easiest to quietly drop: an override that currently does nothing, and
// a stored preference that cannot apply on this provider.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    setApprovalMode: vi.fn(),
    setToolApprovalOverride: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";
import type { AiStatus, ApprovalMode, ApprovalStatus } from "../lib/types";
import { ApprovalSettings } from "./ApprovalSettings";
import { YoloConfirmDialog } from "./YoloConfirmDialog";

const mockSetMode = vi.mocked(api.setApprovalMode);
const mockSetOverride = vi.mocked(api.setToolApprovalOverride);

const RESTRICTIVENESS: readonly ApprovalMode[] = ["alwaysAsk", "approveForMe", "yolo"];

/** The clamp, mirrored so a fixture cannot describe a state Rust would not
 *  produce — a settings suite passing against an impossible `effectiveModes` is
 *  a suite about nothing. */
function clamp(global: ApprovalMode, tool: ApprovalMode): ApprovalMode {
  return RESTRICTIVENESS.indexOf(global) <= RESTRICTIVENESS.indexOf(tool) ? global : tool;
}

function approvalStatus(patch: Partial<ApprovalStatus> = {}): ApprovalStatus {
  const mode = patch.mode ?? "alwaysAsk";
  const toolOverrides = patch.toolOverrides ?? {};
  return {
    ...ALWAYS_ASK_APPROVAL_STATUS,
    // The shared fixture is the mock backend's local lane, where the judge
    // cannot run. Most of this suite is about a cloud provider, so that is the
    // default here and the local-lane cases opt back out explicitly.
    classifierAvailable: true,
    mode,
    toolOverrides,
    effectiveModes: Object.fromEntries(
      Object.keys(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes).map((tool) => [
        tool,
        clamp(mode, toolOverrides[tool] ?? (tool === "transcribe_audio" ? "alwaysAsk" : "yolo")),
      ]),
    ),
    ...patch,
  };
}

function aiStatus(approval: ApprovalStatus): AiStatus {
  return {
    activeProvider: "openRouter",
    reasoningSupported: "unknown",
    reasoningControl: { kind: "pending" },
    openrouter: { hasKey: true, model: "anthropic/claude-sonnet-4.5", reasoning: false, reasoningEffort: null },
    local: { activeModelTag: null },
    approval,
  };
}

function setup(approval: ApprovalStatus = approvalStatus()) {
  const onStatusChange = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <ApprovalSettings status={aiStatus(approval)} onStatusChange={onStatusChange} />,
  );
  return { user, onStatusChange, view };
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });
const ALWAYS_ASK = /Ask me every time/;
const APPROVE_FOR_ME = /Approve routine actions for me/;
const YOLO = /YOLO/;

/** Open the collapsed Advanced disclosure — the per-tool overrides live behind
 *  it because three of the seven tools are pipeline internals, and putting them
 *  at the top level would make the page read like a debug panel. */
async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Advanced/));
}

const overrideSelect = (label: string) =>
  screen.getByLabelText(label) as HTMLSelectElement;

beforeEach(() => {
  mockSetMode.mockReset();
  mockSetOverride.mockReset();
});

describe("the global approval mode", () => {
  it("offers three modes, each with its consequence", () => {
    setup();

    expect(radio(ALWAYS_ASK)).toBeChecked();
    expect(screen.getByText(/Nothing runs until you say yes/)).toBeInTheDocument();
    expect(
      screen.getByText(/Anything it cannot take back still comes to you/),
    ).toBeInTheDocument();
    // YOLO being the CHEAPEST mode as well as the most permissive is exactly
    // the fact somebody could otherwise pick it for the wrong reason.
    expect(
      screen.getByText(/including things it cannot take back.*fastest/),
    ).toBeInTheDocument();
  });

  it("persists a mode change and renders the status the write returned", async () => {
    const next = aiStatus(approvalStatus({ mode: "approveForMe" }));
    mockSetMode.mockResolvedValue(next);
    const { user, onStatusChange } = setup();

    await user.click(radio(APPROVE_FOR_ME));

    // Render the echo, never a follow-up read: a read that failed after the
    // write landed would show "ask me" while the config said otherwise.
    expect(mockSetMode).toHaveBeenCalledExactlyOnceWith("approveForMe");
    expect(onStatusChange).toHaveBeenCalledWith(next);
  });

  it("surfaces a failed write instead of showing a mode that did not persist", async () => {
    mockSetMode.mockRejectedValue({ kind: "ai", message: "the config is read-only" });
    const { user } = setup();

    await user.click(radio(APPROVE_FOR_ME));

    expect(await screen.findByRole("alert")).toHaveTextContent("the config is read-only");
  });
});

describe("when the provider cannot run automatic checking", () => {
  const localLane = () =>
    approvalStatus({ mode: "approveForMe", classifierAvailable: false });

  it("offers the mode disabled, with its reason where everyone can read it", () => {
    setup(localLane());

    const option = radio(APPROVE_FOR_ME);
    expect(option).toBeDisabled();
    // Visible AND announced, right beside the control it explains. A reason that
    // only a mouse pointer can reach defeats the whole point of an explanatory
    // disabled state. (Scoped to this row: Advanced carries the same sentence
    // once for the seven per-tool selects.)
    const row = option.closest("label");
    expect(
      within(row!).getByText(/Needs a cloud provider\. Local models cannot yet judge this/),
    ).toBeVisible();
    expect(option).toHaveAccessibleName(/Needs a cloud provider/);
  });

  it("keeps the stored preference rather than rewriting it to something usable", async () => {
    // Silently rewriting a stored choice because it is momentarily unusable is
    // its own bug: switching back to a cloud provider has to restore it.
    const { user } = setup(localLane());

    expect(radio(APPROVE_FOR_ME)).toBeChecked();
    expect(screen.getByText(/Your choice is kept/)).toBeVisible();

    await user.click(radio(APPROVE_FOR_ME));
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  it("says so once in Advanced rather than seven times over", async () => {
    const { user } = setup(localLane());
    await openAdvanced(user);

    const select = overrideSelect("Creating and changing notes");
    const option = within(select).getByRole("option", {
      name: /Approve routine actions for me/,
    });
    expect(option).toBeDisabled();
  });
});

describe("the per-tool exceptions", () => {
  it("groups the tools by what the user is deciding, never by identifier", async () => {
    const { user, view } = setup();
    await openAdvanced(user);

    expect(screen.getByText("Writes to your vault")).toBeInTheDocument();
    expect(screen.getByText("Changes what the agent may do")).toBeInTheDocument();
    expect(screen.getByText("Reaches the internet")).toBeInTheDocument();
    expect(screen.getByText("Runs a program on your machine")).toBeInTheDocument();
    // "approve resolve_distil_route" means nothing to anyone.
    expect(view.container.textContent ?? "").not.toMatch(/resolve_distil_route/);
  });

  it("stores an override under its persisted key", async () => {
    mockSetOverride.mockResolvedValue(
      aiStatus(approvalStatus({ mode: "yolo", toolOverrides: { write_note: "alwaysAsk" } })),
    );
    const { user, onStatusChange } = setup(approvalStatus({ mode: "yolo" }));
    await openAdvanced(user);

    await user.selectOptions(
      overrideSelect("Creating and changing notes"),
      "alwaysAsk",
    );

    expect(mockSetOverride).toHaveBeenCalledExactlyOnceWith("write_note", "alwaysAsk");
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("clears an override with null rather than storing the current global", async () => {
    // Clearing restores the tool's COMPILED default, which for the tool that
    // spawns a host process is a pin the global can never loosen.
    mockSetOverride.mockResolvedValue(aiStatus(approvalStatus({ mode: "yolo" })));
    const { user } = setup(
      approvalStatus({ mode: "yolo", toolOverrides: { write_note: "alwaysAsk" } }),
    );
    await openAdvanced(user);

    await user.selectOptions(overrideSelect("Creating and changing notes"), "");

    expect(mockSetOverride).toHaveBeenCalledExactlyOnceWith("write_note", null);
  });

  it("shows a more-permissive override as inactive, with the reason, not hidden", async () => {
    // An override that silently does nothing is its own small lie — and hiding
    // it makes the user's own configuration unreadable to them.
    const { user } = setup(
      approvalStatus({ mode: "alwaysAsk", toolOverrides: { write_note: "yolo" } }),
    );
    await openAdvanced(user);

    expect(overrideSelect("Creating and changing notes")).toHaveValue("yolo");
    expect(
      screen.getByText(/Not in effect — the global setting above is stricter/),
    ).toBeVisible();
  });

  it("shows the effective mode, not the stored one, as what actually applies", async () => {
    const { user } = setup(
      approvalStatus({ mode: "alwaysAsk", toolOverrides: { write_note: "yolo" } }),
    );
    await openAdvanced(user);

    const row = overrideSelect("Creating and changing notes").closest("li");
    expect(within(row!).getByText("Asks you")).toBeInTheDocument();
  });

  it("explains a tool that always asks whatever the global mode is", async () => {
    const { user } = setup(approvalStatus({ mode: "yolo" }));
    await openAdvanced(user);

    const row = overrideSelect("Transcribing audio").closest("li");
    expect(
      within(row!).getByText(/Always asks whatever the global setting is/),
    ).toBeVisible();
    expect(within(row!).getByText("Asks you")).toBeInTheDocument();
  });

  it("still renders a gated tool this build has not been taught about", async () => {
    // The backend's key set is authoritative about what is gated. A row the UI
    // declined to render is an action the user cannot govern.
    const { user } = setup(
      approvalStatus({
        effectiveModes: { ...ALWAYS_ASK_APPROVAL_STATUS.effectiveModes, launch_rocket: "alwaysAsk" },
      }),
    );
    await openAdvanced(user);

    expect(screen.getByText("Other actions this build asks about")).toBeInTheDocument();
    expect(overrideSelect("launch_rocket")).toBeInTheDocument();
  });
});

// ── The YOLO entry confirmation ──────────────────────────────────────────────

/** The generated sentence's paragraph. Found by its lead-in rather than by
 *  `getByText`, which matches an element's DIRECT text nodes only — and this
 *  paragraph is deliberately split by the `<strong>` around the list. */
function irreversibleParagraph(): HTMLElement {
  const dialog = screen.getByRole("alertdialog");
  const paragraph = [...dialog.querySelectorAll("p")].find((el) =>
    el.textContent?.startsWith("That includes"),
  );
  if (paragraph === undefined) {
    throw new Error("the irreversible-actions paragraph did not render");
  }
  return paragraph;
}

describe("getting into YOLO mode", () => {
  it("confirms before turning it on, and writes nothing until it is confirmed", async () => {
    const { user } = setup();

    await user.click(radio(YOLO));

    expect(screen.getByRole("alertdialog")).toHaveTextContent("Turn on YOLO mode?");
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  it("opens with Cancel focused and the confirm in the destructive tone", async () => {
    const { user } = setup();

    await user.click(radio(YOLO));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    expect(screen.getByRole("button", { name: "Turn on YOLO mode" })).toHaveClass(
      "bg-destructive",
    );
  });

  it("leaves the stored mode alone when the confirmation is cancelled", async () => {
    const { user } = setup();

    await user.click(radio(YOLO));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockSetMode).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(radio(ALWAYS_ASK)).toBeChecked();
  });

  it("treats Escape as cancelling, never as confirming", async () => {
    // Every dismissal path has to land on the safe side. A confirmation whose
    // Escape key turns the permission ON would be the worst possible bug in the
    // one dialog written to slow somebody down.
    const { user } = setup();
    await user.click(radio(YOLO));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockSetMode).not.toHaveBeenCalled();
    expect(radio(ALWAYS_ASK)).toBeChecked();
  });

  it("persists the mode once the confirmation is accepted", async () => {
    mockSetMode.mockResolvedValue(aiStatus(approvalStatus({ mode: "yolo" })));
    const { user, onStatusChange } = setup();

    await user.click(radio(YOLO));
    await user.click(screen.getByRole("button", { name: "Turn on YOLO mode" }));

    expect(mockSetMode).toHaveBeenCalledExactlyOnceWith("yolo");
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("never nags once the mode is already on", async () => {
    // A mode that re-asks is a mode users click-train themselves out of
    // reading, which would spend the one moment this warning actually lands.
    const { user } = setup(approvalStatus({ mode: "yolo" }));

    await user.click(radio(YOLO));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockSetMode).not.toHaveBeenCalled();
  });
});

describe("the YOLO warning's generated sentence", () => {
  // GOLDEN. This is user-facing security copy assembled from
  // `approval.irreversibleActions`, which Rust derives from the same
  // reversibility table the gate consults. If a tool moves in or out of the
  // irreversible set, or the joining grammar changes, this assertion fails and a
  // human has to consciously re-bless what the user is shown. Do NOT update it
  // to match a new output without reading it.
  //
  // Pinned as a LITERAL on purpose: asserting the rendered list equals the
  // derived list would compare a value against its own source and pass forever.
  const BLESSED =
    "That includes things it cannot take back: saving how it files your notes, " +
    "fetching pages and captions from the internet, and running audio transcription " +
    "on your machine.";

  it("reads exactly as blessed", async () => {
    const { user } = setup();

    await user.click(radio(YOLO));

    expect(irreversibleParagraph().textContent).toBe(BLESSED);
  });

  it("bolds the consequences so they survive a skim", async () => {
    const { user } = setup();

    await user.click(radio(YOLO));

    const bold = irreversibleParagraph().querySelector("strong");
    expect(bold?.textContent).toContain("running audio transcription on your machine");
  });

  it("joins two consequences without a serial comma", () => {
    // Not a tautology: the items are the fixture's, the GRAMMAR is this repo's,
    // and this pins the grammar as a literal.
    render(
      <YoloConfirmDialog
        irreversibleActions={["fetching pages", "running transcription"]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(irreversibleParagraph().textContent).toBe(
      "That includes things it cannot take back: fetching pages and running transcription.",
    );
  });

  it("drops the sentence entirely when nothing is irreversible", () => {
    // A build that classified nothing as irreversible must not show a dangling
    // "That includes things it cannot take back:" with an empty list.
    render(
      <YoloConfirmDialog
        irreversibleActions={[]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("That includes");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "NeuralNote will stop asking before it acts",
    );
  });

  it("keeps the reassurances that make the mode survivable", () => {
    render(
      <YoloConfirmDialog
        irreversibleActions={["fetching pages"]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "You will still see everything it did in the chat, and you can still undo any note it writes.",
    );
    expect(dialog).toHaveTextContent("You can turn this off at any time in Settings.");
  });
});
