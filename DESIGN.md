# NeuralNote desktop design system

NeuralNote uses one dark, low-chroma interface. The visual hierarchy comes from spacing, typography, and a small range of charcoal surfaces rather than gradients or glow effects. Product behaviour and Tauri IPC contracts sit outside this system.

## Tokens

The source of truth is `app/desktop/src/styles.css`. Tailwind v4 maps the CSS variables through `@theme inline`, so project components use semantic utilities rather than literal colours.

| Role | Token | Use |
| --- | --- | --- |
| Canvas | `--background` | Note and graph canvas |
| Chrome | `--titlebar`, `--sidebar` | Window bar, navigation, side panes, status bar |
| Depth | `--surface-sunken`, `--surface-raised`, `--surface-hover` | Fields, cards, hover states |
| Selection | `--surface-selected` | Current rows, toggles, menu items |
| AI identity | `--primary` | Focus, selection, links, AI marks |
| Chat action | `--chat` | Send/stop action only |
| Healthy | `--healthy` | Connected providers and disk state only |
| Warning/error | `--warning`, `--destructive` | Explicit non-silent failure states |

Destructive actions pair `--destructive` with the dark `--destructive-foreground` token; small button text must retain WCAG AA contrast rather than defaulting to white.

Inter is used for UI and note reading. JetBrains Mono is reserved for paths, models, byte counts, timestamps, and metadata. Note prose is 16px with a 1.8 line height and a maximum measure of 72 characters.

## Geometry

The workspace and title bar share these variables:

- `--titlebar-height`: 48px
- `--navigation-width`: 56px compact or 192px expanded
- `--sidebar-width`: 296px preferred by default; 192px to 420px
- `--chat-width`: 420px to 480px
- `--note-toolbar-height`: 44px
- `--statusbar-height`: 28px

The navigation sidebar expands to show the vault identity, vault actions, and labelled quick links. Its compact mode retains the same actions as accessible icon buttons with visible tooltips. A fixed 56px CSS-pixel icon gutter stays in place at every font scale while the labels translate and fade, preventing controls from jumping during the width transition. Files and Search remain in a separate primary pane; changing the navigation mode never hides or remounts that pane.

Navigation expansion and cited-recall chat visibility use a restrained 200ms ease-out slide. Navigation width and the title-bar editor offset animate together; chat collapses through an overflow-clipped slot while its mounted pane translates and fades. Splitter dragging remains immediate. Reduced-motion preferences make these transitions effectively instant.

The Files/Search pane has an 8px splitter hit target around a quiet 1px divider. Dragging uses pointer capture. When the splitter has keyboard focus, Left and Right resize by 8px, Shift increases the step to 32px, Home and End select the bounds, and Enter toggles between the minimum and the previous width. Its separator semantics expose the controlled pane and the current, minimum, and maximum widths.

The saved layout is global frontend state under the versioned `nn:workspace-layout:v1` local-storage key. It records the preferred navigation expansion and Files/Search width. Missing or malformed state falls back to expanded navigation and 296px; unavailable or failed storage affects persistence only.

Effective geometry is derived from the measured workspace width plus the navigation and chat slots' current rendered widths, including intermediate animation frames. When chat opens, its full target width is reserved immediately so responsive navigation compaction starts alongside the chat transition; closing restores space from the rendered width. The layout preserves at least 192px for Files/Search and 240px for the editor. It temporarily clamps the Files/Search pane and, when necessary, temporarily compacts navigation without overwriting either preference. The preferred geometry returns when space does. Neither the Files/Search pane nor chat is automatically unmounted, so tree state, search state, a live chat stream, and its transcript survive responsive changes.

At 1050px secondary status metadata and optional labels disappear. At the 920px minimum the responsive geometry still follows the measured-space rules above, including the current chat width. User-controlled chat visibility still works.

The title bar consumes the same effective navigation, Files/Search, and chat geometry variables, including during splitter drags and responsive changes. The note tab therefore begins at the editor column rather than the centre of the whole window. The 78px macOS traffic-light clearance and the dedicated Tauri drag layer remain intact. The title-bar toggle changes the preferred navigation expansion only; it never hides Files/Search.

At window heights below 700px, the welcome card compacts its padding and gaps. The outer welcome surface scrolls vertically as a final safeguard for long vault names, multiple recents, and inline errors.

Graph chrome uses its measured pane width rather than the whole window breakpoint. Below 760px, the title and controls stack, the labelled search field flexes beside the semantically pressed 2D/3D toggle, and degradation notices move below both toolbar rows without overflowing the pane.

## Components

Locally owned primitives live in `app/desktop/src/components/ui`. They follow shadcn's New York source conventions but are styled for NeuralNote.

- `Button`: `primary`, `chat`, `quiet`, `ghost`, and `danger` tones; `sm`, `md`, `lg`, and `icon` sizes; built-in busy state.
- `IconButton`: requires an accessible label and provides a visible Radix tooltip.
- `Input` and `Textarea`: sunken surfaces with one consistent focus treatment.
- `Badge`: neutral, AI, healthy, warning, and danger states.
- `Dialog` and `DropdownMenu`: Radix focus management, Escape handling, focus return, and keyboard navigation.
- `Toggle` and `Switch`: Radix state semantics and keyboard handling.
- `Separator`, `Skeleton`, and `Progress`: quiet structural and loading states.

NeuralNote compositions live in `app/desktop/src/components/neural`: `PanelHeader`, `AiMark`, `StatusPill`, `InlineNotice`, and `EmptyState`.

## Usage rules

1. Use semantic tokens. Do not add literal indigo, violet, pink, or green values in components.
2. Violet identifies AI, focus, links, and selection. Pink is reserved for the primary chat action. Green means a provider or disk state is healthy.
3. Do not add pane-wide gradients, decorative glows, or a custom scroll-area component. Native scrolling is the default.
4. Icon-only controls use `IconButton`; a `title` attribute is not a substitute for the visible tooltip.
5. Dialogs and menus use the Radix-backed primitives. Do not recreate focus traps, Escape listeners, or arrow-key navigation.
6. Loading, empty, disabled, and error states must remain explicit. Failures must never disappear into colour alone.
7. Render untrusted note content through React/`react-markdown` defaults. Reject unsafe image URLs and replace failed images with the accessible fallback rather than a broken placeholder.
8. Respect `prefers-reduced-motion`. Keep focus rings visible and interactive targets at least 24px square.
