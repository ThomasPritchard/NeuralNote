**NeuralNote main comment audit**

Source: exact tracked snapshot of `b4fe8315d787bbe5226828557f7f4204d435731b`, measured on 28 September 2026. No source checkout edits.

The installed `cloc` 2.10 measured 719 Rust, TypeScript, TSX, JavaScript and MJS source files. The helper copies files into measurement groups, separates known dedicated tests/fixtures and generated bindings, and extracts 61 inline `#[cfg(test)] mod ... { ... }` blocks from 58 Rust files. A lightweight Rust lexical mask skips strings/comments while matching module braces. It does not evaluate conditional compilation; individual test-only helpers and external test-module declarations can remain in the production-module group.

The frontend group excludes test/spec files, the e2e folder, test contracts/harnesses and generated bindings. The Rust group excludes dedicated test paths, test/fixture/eval files and extracted inline test modules. Tooling outside those application source roots is reported separately. Paths and membership decisions are in `manifest.json` and `measure.py`.

The reported ratio is `comment / (code + comment)`. Blank lines are excluded, including placeholders left by extracted test modules. API documentation counts as comments. Inline comments on code lines follow `cloc`'s classification. The percentages measure source volume, not the proportion of comments that should be deleted or a runtime-performance penalty.

The combined application measurement is 54,985 code lines and 14,645 comment lines: 21.03% comments. Frontend: 23,880 code / 7,034 comments (22.75%). Rust production-module sections: 31,105 code / 7,611 comments (19.66%). These are reproducible tool counts with the classification limitations above.

As a consistency check, unsplit counts and the sum of all split groups both have 143,926 code lines and 26,782 comment lines. Splitting did not lose code/comment lines. Source files containing inline tests appear in both production and test measurement groups, so split file counts must not be summed as unique source files.

The durable baseline summary and per-file counts are retained beside this document. The audit script accepts a source snapshot and output directory; export the review commit before rerunning it. Generated measurement copies are disposable.

```sh
git archive b4fe8315d787bbe5226828557f7f4204d435731b | tar -x -C /path/to/empty-snapshot
python3 measure.py /path/to/empty-snapshot /path/to/measurement-output
```

## Focused remediation measurement

On the same classification rules, production comment lines fell from **14,645 to 14,090**
(**555 fewer**, net). Code lines increased from 54,985 to 55,820 while the bugs and bounds were
implemented. Comment share therefore moved from 21.03% to 20.15%; that percentage reflects both
comment removal and code growth. No runtime speedup is attributed to comment removal.

| File | Comment lines before → after | Comment share before → after |
| --- | ---: | ---: |
| `KeyChangeCaveat.tsx` | 40 → 4 | 63.49% → 14.81% |
| `sourceEditorTableMeasurement.ts` | 56 → 6 | 64.37% → 16.22% |
| `sourceEditorTableScrollSync.ts` | 287 → 94 | 53.15% → 27.09% |
| `useVaultTree.ts` | 69 → 8 | 51.49% → 10.67% |
| `ai/events.rs` | 329 → 209 | 62.91% → 51.86% |
| `ai/verify.rs` | 43 → 21 | 46.74% → 30.00% |

The event protocol retains substantial API documentation. This is deliberate: the cleanup targets
repetition, historical narration and false/stale claims, without enforcing a comment quota.
Generated TypeScript comments were regenerated from Rust and are excluded from these production
counts. The remediated CSV and summary are retained alongside the baseline.
