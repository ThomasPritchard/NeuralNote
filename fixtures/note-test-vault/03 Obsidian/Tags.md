---
tags: [qa/tags, qa/tags/property]
aliases: [Tag grammar fixture]
---
# Obsidian tags

Valid tags: #qa/editor #qa/editor/nested #snake_case #hyphen-tag #café #测试 #🧠.

`#qa/editor` inside code is not a hit.

[A link label #qa/editor](https://example.com) is not a hit.

[A reference label #qa/editor][reference] is not a hit.

[reference]: https://example.com "#qa/editor in a title"

An embed fragment ![[Link Target#qa/editor]] is not a hit.

An HTML attribute <span data-tag="#qa/editor">stays inert</span>.

Escaped \#qa/editor is not a hit.

Invalid forms stay ordinary text: # #1984 word#joined ##heading.

Prefix control: #qa/editorExtra must not match an exact `tag:#qa/editor` search.
