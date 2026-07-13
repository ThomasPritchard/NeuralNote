# NeuralNote desktop design system

NeuralNote uses one dark, low-chroma interface. The visual hierarchy comes from spacing, typography, and a small range of charcoal surfaces rather than gradients or glow effects. Product behaviour and Tauri IPC contracts sit outside this system.

## Tokens

The source of truth is `app/desktop/src/styles.css`. Tailwind v4 maps the CSS variables through `@theme inline`, so project components use semantic utilities rather than literal colours.

| Role | Token | Use |
| --- | --- | --- |
| Canvas | `--background` | Note and graph canvas |
| Chrome | `--titlebar`, `--sidebar` | Window bar, ribbon, side panes, status bar |
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

- `--titlebar-height`: 52px
- `--ribbon-width`: 56px
- `--sidebar-width`: 296px
- `--chat-width`: 420px to 480px
- `--note-toolbar-height`: 44px
- `--statusbar-height`: 28px

At 1280px and below the sidebar and chat pane compact. At 1050px secondary status metadata and optional labels disappear. At the 920px minimum the sidebar is 200px and chat is 288px. Neither secondary pane is automatically unmounted, so a live chat stream and its transcript survive width changes. User-controlled visibility still works.

The title bar uses the same geometry variables. With the sidebar open, its first grid column matches the ribbon plus sidebar, so the note tab begins at the note column rather than the centre of the whole window. With the sidebar collapsed, the left title-bar cluster retains a 208px safety column so the traffic lights and vault controls cannot overlap the note tab. The 78px macOS traffic-light clearance and the dedicated Tauri drag layer remain intact.

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
