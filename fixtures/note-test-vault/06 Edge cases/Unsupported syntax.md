---
tags: [qa/unsupported]
---
# Unsupported syntax remains source

```dataview
TABLE file.name FROM #qa
```

Inline math $E = mc^2$ and block math:

$$
\int_0^1 x^2 dx
$$

Footnote reference[^1].

[^1]: Footnote definitions remain ordinary source until supported.

export const fixture = true

<Component prop="value" />

<script>document.body.dataset.compromised = "true"</script>
