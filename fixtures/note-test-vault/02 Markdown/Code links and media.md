---
tags: [qa/markdown, qa/links]
---
# Code, links, and media

Supported same-folder link: [Markdown link target](Markdown%20link%20target.md).

Parent traversal is an inert safety control: [Rejected parent link](../03%20Obsidian/Link%20Target.md).

External link: [Example](https://example.com), bare URL https://example.org, and autolink <https://example.net>.

Image syntax remains inert: ![Missing test image](missing-image.png)

Inline code masks syntax: `#not-a-tag [[Not a link]] **not strong**`.

```markdown
#not-a-tag
[[Not a link]]
<script>alert("never execute")</script>
```

Raw HTML remains editable source and is never mounted:

<button onclick="alert('never')">inert raw HTML</button>
