# RustSec dependency advisories

Status of every `cargo audit` **warning** in the workspace, with provenance,
platform reachability, and the upgrade trigger that will clear it.

`cargo audit` fails the quality gate only on **vulnerabilities**. As of
2026-07-15 there are **0 vulnerabilities** and **17 allowed warnings** (1
`unsound`, 16 `unmaintained`). The gate is green. We deliberately keep **no
`audit.toml` ignore-list**: silencing an advisory hides the day it turns into a
vulnerability. Each warning below is instead accounted for here.

Re-check with:

```bash
cargo audit                 # exit 0 = no vulnerabilities (warnings are allowed)
cargo tree -i <crate> -e normal,build [--target x86_64-unknown-linux-gnu]
cargo update --dry-run      # proves nothing bumps today
```

None of the 17 can be removed by a lockfile bump today: `cargo update` moves none
of them, and every parent is already at its latest crates.io release (`tauri`
2.11.x, `tauri-utils` 2.9.3, `muda` 0.19.3). They are all upstream-blocked.

---

## Group A — Tauri's Linux GTK3 stack (12 crates, Linux-target only)

**Not compiled on macOS or Windows.** These enter only through Tauri's Linux
WebKitGTK backend and are absent from the dependency graph for the host and the
shipped macOS bundle:

```
proc-macro-error → glib-macros → glib → atk → gtk → muda → tauri 2.11.3 → desktop
gdk / gdk-sys / gdkwayland-sys / gdkx11 / gdkx11-sys / gtk-sys / gtk3-macros / atk-sys
    → (same gtk-rs 0.18 generation) → gtk → muda → tauri
```

| Crate | Version | Advisory | Kind |
| --- | --- | --- | --- |
| `glib` | 0.18.5 | RUSTSEC-2024-0429 | unsound |
| `atk` | 0.18.2 | RUSTSEC-2024-0413 | unmaintained |
| `atk-sys` | 0.18.2 | RUSTSEC-2024-0416 | unmaintained |
| `gdk` | 0.18.2 | RUSTSEC-2024-0412 | unmaintained |
| `gdk-sys` | 0.18.2 | RUSTSEC-2024-0418 | unmaintained |
| `gdkwayland-sys` | 0.18.2 | RUSTSEC-2024-0411 | unmaintained |
| `gdkx11` | 0.18.2 | RUSTSEC-2024-0417 | unmaintained |
| `gdkx11-sys` | 0.18.2 | RUSTSEC-2024-0414 | unmaintained |
| `gtk` | 0.18.2 | RUSTSEC-2024-0415 | unmaintained |
| `gtk-sys` | 0.18.2 | RUSTSEC-2024-0420 | unmaintained |
| `gtk3-macros` | 0.18.2 | RUSTSEC-2024-0419 | unmaintained |
| `proc-macro-error` | 1.0.4 | RUSTSEC-2024-0370 | unmaintained |

**RUSTSEC-2024-0429 (`glib` unsound — `VariantStrIter`).** The unsoundness is in
`Iterator`/`DoubleEndedIterator` for `glib::VariantStrIter`. NeuralNote never
calls glib directly; the type is only reachable through Tauri's own Linux IPC
internals, and not at all on macOS/Windows where glib is not built.

**Nearest version that fixes it:** none in the Tauri 2.x line. Every current
Tauri 2.x (checked through 2.11.5) pins the gtk-rs **0.18** generation via
`muda`/`tao`/`wry`; the glib fix lands in gtk-rs **0.20+**, which the GTK3
bindings do not adopt. The GTK3 bindings themselves are unmaintained because
gtk-rs has moved to GTK4.

**Upgrade trigger:** Tauri's Linux backend moving off WebKitGTK/GTK3 (to
`webkitgtk-6` / GTK4), which retires the entire gtk-rs 0.18 chain in one step.
Re-run `cargo tree -i glib --target x86_64-unknown-linux-gnu` after any major
Tauri bump; when glib disappears (or reaches ≥0.20), delete this group.

---

## Group B — `unic-*` via `urlpattern` (5 crates, all targets)

Pulled by `tauri-utils`' URL-pattern matching, used at Tauri **build/codegen**
time on every platform:

```
unic-ucd-ident / unic-ucd-version / unic-char-property / unic-char-range / unic-common
    → urlpattern 0.3.0 → tauri-utils 2.9.3 → tauri-codegen → tauri-macros → tauri 2.11.3
```

| Crate | Version | Advisory | Kind |
| --- | --- | --- | --- |
| `unic-char-property` | 0.9.0 | RUSTSEC-2025-0081 | unmaintained |
| `unic-char-range` | 0.9.0 | RUSTSEC-2025-0075 | unmaintained |
| `unic-common` | 0.9.0 | RUSTSEC-2025-0080 | unmaintained |
| `unic-ucd-ident` | 0.9.0 | RUSTSEC-2025-0100 | unmaintained |
| `unic-ucd-version` | 0.9.0 | RUSTSEC-2025-0098 | unmaintained |

The `unic-*` family is unmaintained; upstream direction is the `unicode-*`
crates. `urlpattern` **0.6.0** exists on crates.io, but `tauri-utils 2.9.3`
(the latest release) pins `urlpattern ^0.3`, so the bump is semver-incompatible
and `cargo update -p urlpattern` locks 0 packages.

**Upgrade trigger:** `tauri-utils` releasing a version that bumps `urlpattern`
to a release which has dropped `unic-*`. Re-run `cargo tree -i unic-ucd-ident`
after any `tauri-utils` bump; when it resolves to nothing, delete this group.

---

## What was verified (2026-07-15)

- `cargo audit` → 0 vulnerabilities, 17 allowed warnings; quality gate green.
- `cargo update --dry-run` → moves none of the 17 (all at their pinned ceilings).
- `cargo tree -i` (host and `x86_64-unknown-linux-gnu`) → provenance above.
- Latest published parents (`tauri` 2.11.5, `tauri-utils` 2.9.3, `muda` 0.19.3)
  still carry the same transitives — no bump available that removes any warning.

Native platform CI (`.github/workflows/ci.yml`, `e2e.yml`) runs the workspace
build/test on the supported matrix and is the check that would catch a
platform-specific break from any future dependency change made to clear these.
