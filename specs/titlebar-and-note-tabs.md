# Integrated titlebar and note tabs

**Status:** Approved design, pending written-spec review

## Goal

Make the macOS titlebar match the supplied reference more closely and support
multiple open note tabs without weakening NeuralNote's unsaved-edit protection.

The visual target is a compact native-feeling titlebar whose document tabs meet
the content surface at the bottom edge. The behavioural target is familiar
desktop tab handling: ordinary navigation reuses the active tab, Command-click
opens a separate tab, and open paths are restored for each vault.

## Visual design

- Set the single authoritative `--titlebar-height` token to 48 CSS pixels. Remove
  responsive overrides of that token so every supported width uses the same value.
- Set the initial macOS traffic-light position to `{ x: 16, y: 23 }`, then verify
  the result in a real Tauri window against the reference image. Any adjustment
  must be based on that screenshot comparison rather than an unmeasured offset.
- Keep the sidebar toggle and vault switcher aligned on the same vertical axis as
  the traffic lights.
- Place the tab strip after the vault cluster and align its bottom edge with the
  titlebar border.
- Render tabs 36 pixels high with top corners only. The active tab uses the note
  pane surface, has no visible bottom border, and reads as attached to the note
  content. Inactive tabs use a quieter titlebar surface.
- Keep note icons, titles, dirty indicators, and close affordances. Titles truncate
  visually but remain available to assistive technology and in a tooltip.
- Make the chat and settings controls visually quiet like the reference. Their
  pressed and focus states remain clear without a persistent high-emphasis tile.
- Allow the strip to scroll horizontally. Tabs keep a readable minimum width and
  the active tab scrolls into view automatically. No overflow menu is included in
  this slice.
- Preserve the dedicated Tauri drag layer behind all interactive controls.

## Tab state model

Replace the single `useOpenNote` controller with a reducer-backed `useNoteTabs`
controller. Each tab has a stable ID independent of its path and owns:

- absolute and vault-relative paths;
- loaded `NoteDoc`, loading state, and read error;
- read or edit mode;
- editor draft and derived dirty state;
- saving state, save error, and external-change conflict state;
- per-tab load and save revision tokens.

The controller exposes an active-note facade compatible with the existing
`OpenNote` contract so `NotePane`, `StatusBar`, the Format menu, and the Save menu
continue to operate on one active tab. Tab collection operations stay separate:
open, activate, close, remap, remove, restore, and inspect dirty tabs.

Async completions address a stable tab ID plus revision token. A load or save that
finishes after the user switches tabs must update only the tab that started it. A
rename during a save must not let the save response restore the old path.

A normalized requested absolute path is the provisional identity while a note is
loading. The canonical path returned by Rust becomes the authoritative identity;
reconciliation merges simultaneous aliases into one tab without losing a draft.

## Opening and switching

- A normal file-tree click, search result, graph node, citation, generated-note
  link, or note link reuses the active tab when that tab is clean.
- If the active tab is dirty, ordinary navigation opens the target in a new tab so
  the existing draft is preserved without prompting.
- Command-clicking a file-tree note always requests a separate tab.
- Opening a path that is already present activates its existing tab and does not
  reread or duplicate it.
- Switching tabs never prompts because it does not destroy a draft.
- Template-created and newly created notes follow the same open policy.
- Closing the active tab activates the tab to its right, otherwise the tab to its
  left. Closing a background tab leaves the current tab active.

## Unsaved changes

- Closing a dirty tab shows the existing destructive confirmation before removing
  that tab and its in-memory draft.
- Closing the vault, closing the window, or quitting the app checks every open tab.
  If any tab is dirty, show one warning that unsaved changes will be lost. Cancel
  keeps the window and all tabs open; Discard proceeds with the requested action.
- Use a typed pending intent such as `close-tab`, `close-vault`, or `close-window`
  rather than storing an arbitrary callback. A new close request must not silently
  replace an existing confirmation.
- Cancel returns focus to the tab or close control that initiated the warning.
  Confirmed close moves focus to the newly selected neighbour.
- Saving and toggling edit mode always target the active tab.
- Unsaved editor drafts are never written to workspace-state storage.
- Replace the native Window-menu `Command-W` binding with a custom Close Tab menu
  action while a vault is open. Close Window remains a separate native-style menu
  action using `Command-Shift-W`, so one keypress cannot close both a tab and window.

## Rename and deletion

- Renaming or moving a file remaps every matching open tab while preserving its
  stable ID, draft, mode, and conflict state.
- Renaming or moving a folder remaps every open descendant tab.
- `FileTree` raises a typed delete request instead of owning the complete delete
  transaction. `Workspace` identifies affected tabs, runs the destructive guard,
  invokes deletion, refreshes the tree, and then updates tab state.
- Deleting a file or folder checks all affected tabs, including dirty background
  tabs. The destructive confirmation names the number of unsaved tabs at risk.
- After confirmed deletion, remove every affected tab. Tabs unaffected by the
  deletion retain their state and order.

## Restoration and persistence

Store vault-specific workspace state in `.neuralnote/workspace-state.json`:

```json
{
  "openPaths": ["Ideas.md", "Projects/APD action plan.md"],
  "activePath": "Projects/APD action plan.md"
}
```

- Paths are vault-relative and ordered as shown in the tab strip.
- Persist atomically through thin Tauri commands and the existing core atomic-write
  helper. The backend validates that every resolved path remains inside the vault.
- Save after tab order, membership, or active-path changes. A single serialized
  writer coalesces rapid changes and guarantees that an older async write cannot
  finish after and overwrite a newer state. Vault close and Workspace unmount flush
  the latest queued state before teardown proceeds.
- On vault open, restore the recorded paths in order and select `activePath` after
  the requested notes finish loading. If `activePath` is missing or fails to load,
  activate the first successfully restored tab. If every path fails, show the empty
  note panel.
- Missing notes are skipped and reported once through the toast service.
- A missing state file means an empty tab set.
- A malformed or unsafe state file falls back to an empty tab set and produces a
  persistent recovery toast with a reset action. A recovery latch suppresses every
  automatic workspace-state write until Reset atomically replaces the bad file with
  defaults and clears the latch. It is never silently overwritten.
- Persistence failures leave the in-memory tabs usable and surface a deduplicated
  error toast.
- Closing the vault does not erase its workspace-state file. Reopening the vault or
  relaunching NeuralNote restores the same paths and active tab.

## Accessible interaction

- The strip uses `role="tablist"` with the accessible name `Open notes`.
- Each visual tab uses a non-semantic wrapper containing sibling controls: one
  `button role="tab"` trigger and one pointer close button. Interactive controls are
  never nested. Only the trigger carries `aria-selected` and `aria-controls`.
- Note triggers use stable IDs and roving `tabIndex`. The selected trigger is the
  only tab stop. Pointer close buttons use `tabIndex={-1}`; Delete and Command-W
  provide the equivalent keyboard operation from the focused tab.
- Left and Right move through tabs with wrapping. Home and End move to the first
  and last tabs. Focus automatically activates the local note because switching is
  immediate.
- Delete and Command-W close the focused or active tab through the same dirty-tab
  guard.
- Pointer close controls are at least 24 by 24 CSS pixels, identify the note in
  their accessible name, and do not activate a background tab before closing it.
  Keyboard users can perform the same action with Delete or Command-W.
- After a focused tab closes, focus moves to its selected neighbour. If no tabs
  remain, focus moves to the empty note panel.
- The active note pane is the tabpanel labelled by the active tab.
- Activating any note tab exits graph view and reveals its tabpanel. When graph view
  is active, add one transient Graph trigger to the same tablist and select it; it
  controls the graph panel, is not persisted, and closes back to the previous note.
  This keeps exactly one selected tab and one matching visible tabpanel.
- Visible focus indicators, reduced-motion behaviour, and full note-title tooltips
  remain available in every theme.

## Security and data handling

- Note titles and paths render through React text nodes only. Do not introduce
  `dangerouslySetInnerHTML`, HTML string construction, or URL-derived DOM sinks.
- Canonical path confinement remains a Rust responsibility. Frontend path checks
  are usability checks, not the security boundary.
- Workspace-state parsing rejects control characters, absolute paths, parent
  traversal, duplicate paths, and data above a conservative size limit.
- Canonical identity comes from Rust after sandboxed resolution. Tests cover
  equivalent spellings and simultaneous opens that resolve to the same file.
- Workspace-state writes must not follow a symlink outside the vault-owned
  `.neuralnote` directory, matching the existing config-write hardening.

## Test plan

Follow red, green, refactor for each behaviour.

### State and persistence

- two notes remain loaded concurrently and switching preserves draft, mode, and
  conflict state;
- duplicate opens activate without rereading;
- dirty active-tab navigation opens a new tab;
- out-of-order loads and background saves update only their owning tabs;
- typing during a save remains dirty;
- a save completed after rename cannot restore the old path;
- closing selects the deterministic neighbour;
- restore preserves order and active path;
- serialized writes cannot land out of order, teardown flushes the newest state,
  and recovery mode blocks writes until explicit reset;
- missing, malformed, unsafe, duplicate, and oversized workspace state is handled
  explicitly;
- atomic persistence and symlink protections match the existing config tests.

### Workspace journeys

- ordinary click reuses the clean active tab;
- Command-click opens or focuses a separate tab;
- dirty-tab close supports cancel and discard;
- any dirty tab blocks vault close, window close, and app quit;
- rename and folder rename remap all affected tabs;
- deletion warns for background dirty tabs and removes every affected tab only
  after confirmation;
- Save and Toggle Mode affect only the active tab;
- restored tabs appear when the vault is reopened;
- graph view owns a transient selected tab and activating a note exits graph view;

### Titlebar and accessibility

- active, inactive, dirty, loading, error, and overflow tab states;
- tab click and background close behaviour;
- roving focus, Left, Right, Home, End, Delete, and Command-W;
- correct tablist, tab, and tabpanel relationships;
- active-tab scroll-into-view without unwanted motion;
- visible focus and 24-pixel close targets;
- titlebar controls remain clickable above the drag region.

## Verification

- focused reducer, persistence, TitleBar, FileTree, and Workspace tests;
- full frontend test suite, typecheck, and production build;
- generated Rust and TypeScript binding check if persistence adds shared types;
- Rust workspace tests, strict Clippy, rustfmt, and core quality gate;
- keyboard-only pass through the tab strip;
- VoiceOver check for tab name, selection state, dirty state, and close behaviour;
- Tauri dev-mode screenshot comparison against the supplied reference at the
  default and minimum window widths.

## Explicitly deferred

- restoring unsaved drafts after a crash or relaunch;
- preserving editor caret position, selection, or browser undo history per tab;
- drag-to-reorder tabs;
- an overflow menu or searchable open-tab switcher;
- pinned or preview tabs;
- split panes.
