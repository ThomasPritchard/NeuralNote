import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { NativeE2eLayout } from "./native-root.js";

export const MARKDOWN_COMPATIBILITY_SOURCE = `---
title: Native Markdown Compatibility
aliases: [Native Matrix]
tags: [native, compatibility]
---

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Setext heading one
==================

Setext heading two
------------------

Paragraph one with *asterisk emphasis*, _underscore emphasis_, **asterisk strong**,
__underscore strong__, ***nested bold italic***, ~~strike~~, and \`inline code\`.

Paragraph two keeps a blank line. Embedded backticks: \`\`code with \` inside\`\`.

1. Ordered dot
2) Ordered parenthesis
   - Nested unordered
     1. Mixed nested ordered

- Dash item
* Asterisk item
+ Plus item
- [ ] Unchecked task
- [x] Checked task

> Blockquote

---
***
___

\`\`\`ts
const fenced = true;
\`\`\`

~~~text
tilde fence
~~~

\`\`\`\`markdown
\`\`\`nested fence\`\`\`
\`\`\`\`

[Internal](Start.md)
[External](https://example.com)
[Unsafe](javascript:alert(1))
![Remote alt](http://127.0.0.1:9/native-e2e-image.png)
![](never-read-standard-image.png)

| Left | Center | Right | Escaped |
| :--- | :----: | ----: | ------- |
| *one* | **two** | three | pipe \\| literal |

[[Start]] [[Start|Alias]] [[Start#Heading]] [[Start#^block-id]] [[Missing]]
![[never-read-obsidian-image.png]] ![[Never Read Obsidian Note]]

#tag #nested/tag #Unicode-東京 #emoji/🧠

> [!NOTE] Callout marker

Block identity ^block-id

<script>globalThis.executed = true</script>
<Component prop="value" />
$inline math$
$$block math$$
[^footnote]
==highlight==
%%comment%%
\`\`\`dataviewjs
globalThis.executed = true
\`\`\`
\`\`\`mermaid
graph TD; A-->B
\`\`\`
{{unknown-plugin:syntax}}

Malformed [[link and ![[embed and | table

Trailing spaces stay here.${"  "}
\tA tab and Unicode: café 東京 🧠
`;

export interface NativeFixtures {
  vault: string;
  start: string;
  markdown: string;
  crlf: string;
  mixed: string;
  oversized: string;
}

export function seedNativeFixtures(layout: NativeE2eLayout): NativeFixtures {
  const vault = path.join(layout.vaults, "Native Fixture");
  const archive = path.join(vault, "Archive");
  mkdirSync(archive, { recursive: true, mode: 0o700 });

  const start = path.join(vault, "Start.md");
  const markdown = path.join(vault, "Markdown Compatibility.md");
  const crlf = path.join(vault, "CRLF.md");
  const mixed = path.join(vault, "Mixed Endings.md");
  const oversized = path.join(vault, "Oversized.md");

  writeFileSync(start, "# Native start\n\nExact source.\n", "utf8");
  writeFileSync(markdown, MARKDOWN_COMPATIBILITY_SOURCE, "utf8");
  writeFileSync(crlf, "# CRLF\r\n\r\nFirst\r\nSecond\r\n", "utf8");
  writeFileSync(mixed, "# Mixed\r\n\rFirst\nSecond\r\nThird\r", "utf8");
  writeFileSync(oversized, "", "utf8");
  truncateSync(oversized, 8 * 1024 * 1024 + 1);

  writeFileSync(
    path.join(layout.config, "recent-vaults.json"),
    `${JSON.stringify(
      [{ name: "Native Fixture", path: vault, lastOpened: Date.now() }],
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return { vault, start, markdown, crlf, mixed, oversized };
}
