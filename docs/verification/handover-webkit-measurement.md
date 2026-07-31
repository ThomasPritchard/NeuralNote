# Handover — WebKit text-measurement parity check

Give this whole file to an agent that can drive a real GUI. It is self-contained: it does not
depend on the conversation it came from, and it does not depend on any application code shipping
first. It answers a platform question, not a code question.

---

## What you are being asked to find out

NeuralNote is a Tauri 2 desktop app. Its automated tests run in headless **Chromium**. The shipped
app renders in **WebKit** (macOS WKWebView). A feature under development sizes table columns from
the measured pixel width of text, measured by a detached offscreen probe element rather than by
reading the visible text.

That technique is verified in Chromium. Nobody has checked it in WebKit. If a detached probe
disagrees with live rendering there, every column width is wrong on the only platform that
actually ships — and it would be wrong quietly, as columns that drift, not as an error.

**Your single question: in WKWebView, does a detached offscreen probe measure text to the same
width the browser actually paints it?**

You are not testing NeuralNote's code. You are testing whether the measurement technique is sound
on this platform. Report numbers, not a verdict.

---

## Setup

```bash
cd /Users/thomaspritchard/Documents/projects/NeuralNote-tables
git rev-parse --abbrev-ref HEAD      # expect: feat/table-in-place-editing
bash scripts/dev-build.sh            # debug profile — devtools are enabled
```

The build prints the bundle path on success. It takes a while on a cold cache. Then:

```bash
open '/Users/thomaspritchard/Documents/projects/NeuralNote-tables/target/debug/bundle/macos/NeuralNote-Dev-feat-table-in-place-editing.app'
```

If the build fails on a missing `binaries/ollama-*` or `yt-dlp` path, those are large gitignored
sidecars that a fresh worktree lacks. Copy them from the main checkout at
`/Users/thomaspritchard/Documents/projects/NeuralNote` and rebuild. **Do not** work around it by
editing the build config.

In the running app: open any vault, open any note, then open devtools (right-click → Inspect
Element, or ⌘⌥I). You need the Console.

**Sanity check before measuring — do not skip.** In the console run `navigator.userAgent`. It must
contain `AppleWebKit` and must **not** contain `Chrome/` or `Chromium`. If it says Chrome you are
inspecting the wrong window and every number you collect afterwards is meaningless.

---

## The measurement

Paste this whole snippet into the console and press Enter. Read it before you run it — you are
responsible for what it reports.

```js
(() => {
  const SAMPLES = [
    { label: 'ascii-plain',    text: 'Start date' },
    { label: 'ascii-long',     text: 'The quick brown fox jumps over the lazy dog' },
    { label: 'digits-tabular', text: '2026-04-03 1234567890' },
    { label: 'cjk',            text: '日本語のテキスト' },
    { label: 'emoji-zwj',      text: 'family 👨‍👩‍👧‍👦 here' },
    { label: 'combining',      text: 'café naïve Ωmega' },
    { label: 'punctuation',    text: '|---|:--:|---:|' },
  ];

  // Measure against a REAL element in the live document, so the probe inherits
  // exactly the styles the app paints with. Anything else measures a fiction.
  const host = document.querySelector('.cm-content') || document.body;
  const live = getComputedStyle(host);

  // Longhands, deliberately. The `font` shorthand drops properties that change
  // advance width — font-variant-numeric among them, and this app sets tabular-nums.
  const FONT_LONGHANDS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
    'fontVariantNumeric', 'fontVariantLigatures', 'fontFeatureSettings',
    'fontKerning', 'letterSpacing', 'wordSpacing', 'textTransform', 'textRendering',
  ];

  function makeProbe() {
    const el = document.createElement('span');
    for (const property of FONT_LONGHANDS) el.style[property] = live[property];
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.whiteSpace = 'pre';
    el.style.top = '-9999px';
    el.style.left = '-9999px';
    return el;
  }

  function probeWidth(text) {
    const el = makeProbe();
    el.textContent = text;
    document.body.append(el);
    const width = el.getBoundingClientRect().width;
    el.remove();
    return width;
  }

  // Ground truth: put the text in the live flow, in the host, and sum the rects
  // the engine actually produced for it.
  function liveWidth(text) {
    const el = document.createElement('span');
    el.style.whiteSpace = 'pre';
    el.textContent = text;
    host.append(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const width = [...range.getClientRects()].reduce((sum, r) => sum + r.width, 0);
    el.remove();
    return width;
  }

  const rows = SAMPLES.map(({ label, text }) => {
    const probe = probeWidth(text);
    const actual = liveWidth(text);
    return {
      label,
      probePx: +probe.toFixed(2),
      livePx: +actual.toFixed(2),
      deltaPx: +(probe - actual).toFixed(2),
      withinOnePx: Math.abs(probe - actual) <= 1,
    };
  });

  // NEGATIVE CONTROL. A probe deliberately given the wrong font MUST disagree.
  // If this shows a ~0 delta the harness is not measuring anything, and every
  // "pass" above is meaningless. This is the most important line of output.
  const control = (() => {
    const el = makeProbe();
    el.style.fontFamily = 'Times New Roman, serif';
    el.style.fontSize = '9px';
    el.textContent = SAMPLES[1].text;
    document.body.append(el);
    const wrong = el.getBoundingClientRect().width;
    el.remove();
    const right = liveWidth(SAMPLES[1].text);
    return {
      wrongFontPx: +wrong.toFixed(2),
      correctPx: +right.toFixed(2),
      deltaPx: +(wrong - right).toFixed(2),
      harnessCanDetectDifference: Math.abs(wrong - right) > 1,
    };
  })();

  console.log('USER AGENT', navigator.userAgent);
  console.log('FONT IN USE', {
    fontFamily: live.fontFamily,
    fontSize: live.fontSize,
    fontVariantNumeric: live.fontVariantNumeric,
    letterSpacing: live.letterSpacing,
  });
  console.table(rows);
  console.log('NEGATIVE CONTROL', control);
  console.log('FONTS READY', document.fonts.status);
  return { rows, control, fontsStatus: document.fonts.status };
})();
```

**Run it twice.** The first run may execute before webfonts settle, which has previously produced a
12% error. Wait for `FONTS READY` to read `loaded`, then run it again. Report both runs.

---

## How to judge it

**PASS** requires both:
1. Every row's `withinOnePx` is `true` on the second run, and
2. `harnessCanDetectDifference` is `true`.

**FAIL** if any row exceeds 1px on the second run.

**INVALID — report as invalid, not as a pass** if `harnessCanDetectDifference` is `false`, or if
the user agent does not say `AppleWebKit`, or if `FONTS READY` never reaches `loaded`. An invalid
run tells us nothing; do not round it up to a pass.

That negative control exists because "all deltas are zero" is exactly what you would also see if
the probe and the live measurement had accidentally become the same measurement. A harness that
cannot fail has not passed.

---

## Report back

- Both runs' full tables, verbatim — the numbers matter more than your conclusion
- The user-agent string and the font actually in use
- The negative control's numbers
- Which samples, if any, exceeded 1px, and by how much
- Anything that surprised you, including anything that made you unsure the app was in the state
  this document assumes

If the app will not build or will not launch, stop and report that. Do not substitute a different
browser to get a number — a Chromium number is precisely the thing already known and is not what
this asks for.
