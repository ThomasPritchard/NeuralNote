use std::time::{Duration, Instant};

use neuralnote_core::rich_edit::{
    analyze_note_for_rich_edit, apply_rich_edit_patch, RichEditApplyResult, RichEditBlock,
    RichEditDisposition, RichEditDocument, RichEditError, RichEditFallback, RichEditFallbackCode,
    RichEditPatch, MAX_RICH_NOTE_BYTES,
};
use ts_rs::{Config, TS};

fn rich(source: &str) -> neuralnote_core::rich_edit::RichEditDocument {
    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();
    assert_eq!(document.disposition, RichEditDisposition::Rich);
    document
}

#[test]
fn public_rich_edit_dtos_export_a_typed_native_boundary_contract() {
    let config = Config::default();
    for declaration in [
        RichEditBlock::decl(&config),
        RichEditFallback::decl(&config),
        RichEditFallbackCode::decl(&config),
        RichEditDisposition::decl(&config),
        RichEditDocument::decl(&config),
        RichEditPatch::decl(&config),
        RichEditApplyResult::decl(&config),
    ] {
        assert!(!declaration.is_empty());
        assert!(!declaration.contains("any"));
    }
}

fn raw_reason(source: &str) -> RichEditFallbackCode {
    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();
    match document.disposition {
        RichEditDisposition::Raw { reason } => reason.code,
        RichEditDisposition::Rich => panic!("expected raw fallback for {source:?}"),
    }
}

#[test]
fn analysis_preserves_bom_frontmatter_and_terminal_newlines_exactly() {
    let source =
        "\u{feff}---\n# comment\ntitle: &title Exact\nalias: *title\nsummary: |\n  first\n  second\n---\n# Heading\n\nBody  \n\n";

    let document = rich(source);

    assert_eq!(
        document.frontmatter_prefix,
        "\u{feff}---\n# comment\ntitle: &title Exact\nalias: *title\nsummary: |\n  first\n  second\n---\n"
    );
    assert_eq!(document.body, "# Heading\n\nBody  \n\n");
    assert_eq!(
        document
            .blocks
            .iter()
            .map(|block| {
                format!(
                    "{}{}{}",
                    block.leading_separator, block.markdown, block.trailing_separator
                )
            })
            .collect::<String>(),
        document.body
    );
}

#[test]
fn block_ranges_preserve_each_terminal_newline_shape() {
    for (source, separator) in [
        ("body", ""),
        ("body\n", "\n"),
        ("body\n\n", "\n\n"),
        ("body\n\n\n", "\n\n\n"),
    ] {
        let document = rich(source);

        assert_eq!(document.blocks[0].markdown, "body");
        assert_eq!(document.blocks[0].trailing_separator, separator);
    }
}

#[test]
fn closed_but_invalid_frontmatter_is_preserved_and_forces_raw_editing() {
    let source = "---\ninvalid: [yaml\n---\nbody\n";

    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();

    assert_eq!(document.frontmatter_prefix, "---\ninvalid: [yaml\n---\n");
    assert_eq!(document.body, "body\n");
    assert!(matches!(
        document.disposition,
        RichEditDisposition::Raw { reason }
            if reason.code == RichEditFallbackCode::MalformedFrontmatter
    ));
}

#[test]
fn non_mapping_and_oversized_frontmatter_force_raw_editing() {
    assert_eq!(
        raw_reason("---\n- list item\n---\nbody\n"),
        RichEditFallbackCode::MalformedFrontmatter
    );

    let oversized = format!("---\nvalue: {}\n---\nbody\n", "x".repeat(4_097));
    assert_eq!(
        raw_reason(&oversized),
        RichEditFallbackCode::MalformedFrontmatter
    );
}

#[test]
fn fenced_code_delimiter_length_is_exact_and_tags_remain_paragraph_text() {
    rich("~~~~typescript\nconst value = '<div>';\n~~~~\n\n#tag text\n");

    assert_eq!(
        raw_reason("~~~~rust\nfn main() {}\n```\n"),
        RichEditFallbackCode::MalformedMarkdown
    );
}

#[test]
fn analysis_returns_ordered_opaque_blocks_for_supported_nested_markdown() {
    let source = concat!(
        "# Plan\n\n",
        "- [ ] first\n  - nested\n  - `code` and **strong**\n\n",
        "> quoted\n> continuation\n\n",
        "```rust\nfn main() { println!(\"[[literal]]\"); }\n```\n\n",
        "---\n\n",
        "Unicode café with [site](https://example.com) and [note](Areas/note.md).\n"
    );

    let document = rich(source);

    assert_eq!(document.blocks.len(), 6);
    assert!(document.blocks[1].markdown.contains("  - nested"));
    assert_ne!(document.blocks[0].id, document.blocks[1].id);
    assert!(document.blocks.iter().all(|block| !block.id.contains(':')));
}

#[test]
fn blockquote_lazy_continuation_keeps_one_exact_top_level_range() {
    let source = "> quoted\nlazy continuation\n\nnext paragraph\n";

    let document = rich(source);

    assert_eq!(document.blocks.len(), 2);
    assert_eq!(document.blocks[0].markdown, "> quoted\nlazy continuation");
    assert_eq!(document.blocks[0].trailing_separator, "\n\n");
}

#[test]
fn crlf_frontmatter_is_preserved_when_the_body_itself_uses_lf() {
    let source = "\u{feff}---\r\ntitle: Exact\r\n---\r\nbody\n";

    let document = rich(source);

    assert_eq!(
        document.frontmatter_prefix,
        "\u{feff}---\r\ntitle: Exact\r\n---\r\n"
    );
    assert_eq!(document.body, "body\n");
}

#[test]
fn bom_without_frontmatter_remains_outside_the_editor_body() {
    let source = "\u{feff}body\n";

    let document = rich(source);

    assert_eq!(document.frontmatter_prefix, "\u{feff}");
    assert_eq!(document.body, "body\n");
}

#[test]
fn an_unindented_heading_ends_a_top_level_list_range() {
    let source = "- item\n  - nested\n# Heading\n\nparagraph\n";

    let document = rich(source);

    assert_eq!(document.blocks.len(), 3);
    assert_eq!(document.blocks[0].markdown, "- item\n  - nested");
    assert_eq!(document.blocks[0].trailing_separator, "\n");
    assert_eq!(document.blocks[1].markdown, "# Heading");
    assert_eq!(document.blocks[1].trailing_separator, "\n\n");
}

#[test]
fn duplicate_source_blocks_receive_distinct_stable_ids() {
    let source = "same\n\nsame\n";

    let first = rich(source);
    let second = rich(source);

    assert_ne!(first.blocks[0].id, first.blocks[1].id);
    assert_eq!(first.blocks, second.blocks);
}

#[test]
fn editor_markdown_excludes_exact_non_editor_separator_bytes() {
    let source = "\n\nfoo\n\n\nbar\n";

    let document = rich(source);

    assert_eq!(document.blocks.len(), 2);
    assert_eq!(document.blocks[0].leading_separator, "\n\n");
    assert_eq!(document.blocks[0].markdown, "foo");
    assert_eq!(document.blocks[0].trailing_separator, "\n\n\n");
    assert_eq!(document.blocks[1].leading_separator, "");
    assert_eq!(document.blocks[1].markdown, "bar");
    assert_eq!(document.blocks[1].trailing_separator, "\n");
    assert_eq!(
        document
            .blocks
            .iter()
            .map(|block| format!(
                "{}{}{}",
                block.leading_separator, block.markdown, block.trailing_separator
            ))
            .collect::<String>(),
        source
    );
}

#[test]
fn patch_preserves_outer_source_separators_exactly() {
    let source = "foo\n\n\nbar\n";
    let document = rich(source);
    let normalized = RichEditPatch {
        expected_revision: document.revision.clone(),
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "FOO\n\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &normalized),
        Err(RichEditError::InvalidPatch(_))
    ));

    let exact = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "FOO\n\n\n".into(),
    };
    let applied = apply_rich_edit_patch(source.as_bytes(), &exact).unwrap();
    assert_eq!(applied.content, "FOO\n\n\nbar\n");
}

#[test]
fn patch_preserves_terminal_separator_when_replacing_the_last_block() {
    let source = "foo\n\n\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "FOO\n".into(),
    };

    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &patch),
        Err(RichEditError::InvalidPatch(_))
    ));
}

#[test]
fn crlf_body_and_malformed_frontmatter_fail_closed_to_raw() {
    assert_eq!(
        raw_reason("---\r\ntitle: Exact\r\n---\r\nBody\r\n"),
        RichEditFallbackCode::CrLfBody
    );
    assert_eq!(
        raw_reason("---\ntitle: never closed\nBody"),
        RichEditFallbackCode::MalformedFrontmatter
    );
}

#[test]
fn raw_only_markdown_matrix_is_rejected() {
    let cases = [
        ("Title\n=====\n", "setext"),
        ("    indented code\n", "indented code"),
        (
            "[label][ref]\n\n[ref]: https://example.com\n",
            "reference link",
        ),
        ("| a | b |\n|---|---|\n| 1 | 2 |\n", "table"),
        ("A note[^1].\n\n[^1]: footnote\n", "footnote"),
        ("$x + y$\n", "math"),
        ("<div>raw</div>\n", "raw HTML"),
        ("before <span>inline HTML</span> after\n", "inline raw HTML"),
        ("before <Component prop=\"x\" /> after\n", "inline JSX"),
        ("export const value = 1\n", "MDX"),
        ("Hello {name}\n", "JSX expression"),
        ("[[Note|Alias]]\n", "wikilink"),
        ("![[image.png]]\n", "embed"),
        ("> [!NOTE]\n> callout\n", "callout"),
        ("paragraph ^block-id\n", "block ID"),
        ("See Note#^block-id\n", "block reference"),
        ("<!-- comment -->\n", "comment"),
        ("key:: value\n", "Obsidian property"),
        ("```dataview\nLIST\n```\n", "Dataview"),
        ("```rust linenos\nfn main() {}\n```\n", "fence metadata"),
        (
            "paragraph\n\n---\nkey: value\n---\n",
            "YAML-like body block",
        ),
        ("![alt](image.png)\n", "image"),
    ];

    for (source, label) in cases {
        assert_eq!(
            raw_reason(source),
            RichEditFallbackCode::UnsupportedSyntax,
            "{label} must fall back to raw editing"
        );
    }
}

#[test]
fn unsafe_or_ambiguous_links_are_rejected_but_allowed_links_remain_rich() {
    for source in [
        "[x](javascript:alert(1))\n",
        "[x](data:text/html,boom)\n",
        "[x](//example.com)\n",
        "[x](/absolute/path)\n",
        "[x](../escape.md)\n",
        "[x](unterminated\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich
        );
    }

    for source in [
        "[web](http://example.com)\n",
        "[secure](https://example.com/a?q=1)\n",
        "[email](mailto:person@example.com)\n",
        "[vault](Areas/ADHD/Study%20Strategies.md)\n",
        "escaped \\* punctuation and `inline` code\n",
    ] {
        rich(source);
    }
}

#[test]
fn malformed_markdown_and_invalid_utf8_are_rejected_without_conversion() {
    assert_eq!(
        raw_reason("```rust\nfn main() {}\n"),
        RichEditFallbackCode::MalformedMarkdown
    );
    assert_eq!(
        raw_reason("text with `unterminated code\n"),
        RichEditFallbackCode::MalformedMarkdown
    );
    assert!(matches!(
        analyze_note_for_rich_edit(&[0xff, 0xfe]),
        Err(RichEditError::InvalidUtf8)
    ));
}

#[test]
fn every_public_error_has_a_safe_nonempty_display_message() {
    let errors = [
        RichEditError::InvalidUtf8,
        RichEditError::OversizedNote {
            actual: 2,
            limit: 1,
        },
        RichEditError::OversizedReplacement {
            actual: 2,
            limit: 1,
        },
        RichEditError::StaleRevision,
        RichEditError::InvalidPatch("ambiguous range".into()),
        RichEditError::RawOnly(neuralnote_core::rich_edit::RichEditFallback {
            code: RichEditFallbackCode::UnsupportedSyntax,
            message: "raw fallback".into(),
        }),
    ];

    for error in errors {
        assert!(!error.to_string().is_empty());
    }
}

#[test]
fn oversized_notes_and_replacements_are_bounded() {
    let oversized = vec![b'a'; MAX_RICH_NOTE_BYTES + 1];
    assert!(matches!(
        analyze_note_for_rich_edit(&oversized),
        Err(RichEditError::OversizedNote { .. })
    ));

    let document = rich("before\n");
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "a".repeat(MAX_RICH_NOTE_BYTES + 1),
    };
    assert!(matches!(
        apply_rich_edit_patch(b"before\n", &patch),
        Err(RichEditError::OversizedReplacement { .. })
    ));
}

#[test]
fn performance_corpus_keeps_five_thousand_supported_blocks_addressable() {
    let source = (0..5_000)
        .map(|index| format!("paragraph {index}\n\n"))
        .collect::<String>();

    let document = rich(&source);

    assert_eq!(document.blocks.len(), 5_000);
}

#[test]
fn patch_splices_only_the_selected_contiguous_source_range() {
    let source = "---\n# keep exact\ntitle: Test\n---\ncafé\n\nbeta\n\ngamma\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[1].id.clone()],
        replacement_markdown: "BETA **changed**\n\n".into(),
    };

    let applied = apply_rich_edit_patch(source.as_bytes(), &patch).unwrap();

    assert_eq!(
        applied.content,
        "---\n# keep exact\ntitle: Test\n---\ncafé\n\nBETA **changed**\n\ngamma\n"
    );
    assert_eq!(applied.frontmatter_prefix, document.frontmatter_prefix);
}

#[test]
fn patch_can_replace_a_contiguous_range_for_merge_split_move_or_delete() {
    let source = "one\n\ntwo\n\nthree\n\nfour\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[1].id.clone(), document.blocks[2].id.clone()],
        replacement_markdown: "three moved before two\n\ntwo\n\n".into(),
    };

    let applied = apply_rich_edit_patch(source.as_bytes(), &patch).unwrap();

    assert_eq!(
        applied.content,
        "one\n\nthree moved before two\n\ntwo\n\nfour\n"
    );
}

#[test]
fn empty_note_can_receive_its_first_block() {
    let document = rich("");
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: Vec::new(),
        replacement_markdown: "first paragraph\n".into(),
    };

    let applied = apply_rich_edit_patch(b"", &patch).unwrap();

    assert_eq!(applied.content, "first paragraph\n");
}

#[test]
fn stale_unknown_duplicate_reordered_and_ambiguous_ids_fail_closed() {
    let source = "one\n\ntwo\n\nthree\n";
    let document = rich(source);
    let replacement_markdown = String::from("changed\n\n");
    let cases = [
        RichEditPatch {
            expected_revision: "stale".into(),
            changed_block_ids: vec![document.blocks[0].id.clone()],
            replacement_markdown: replacement_markdown.clone(),
        },
        RichEditPatch {
            expected_revision: document.revision.clone(),
            changed_block_ids: vec!["unknown".into()],
            replacement_markdown: replacement_markdown.clone(),
        },
        RichEditPatch {
            expected_revision: document.revision.clone(),
            changed_block_ids: vec![document.blocks[0].id.clone(), document.blocks[0].id.clone()],
            replacement_markdown: replacement_markdown.clone(),
        },
        RichEditPatch {
            expected_revision: document.revision.clone(),
            changed_block_ids: vec![document.blocks[2].id.clone(), document.blocks[1].id.clone()],
            replacement_markdown: replacement_markdown.clone(),
        },
        RichEditPatch {
            expected_revision: document.revision.clone(),
            changed_block_ids: Vec::new(),
            replacement_markdown,
        },
    ];

    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &cases[0]),
        Err(RichEditError::StaleRevision)
    ));
    for patch in &cases[1..] {
        assert!(matches!(
            apply_rich_edit_patch(source.as_bytes(), patch),
            Err(RichEditError::InvalidPatch(_))
        ));
    }
}

#[test]
fn changed_block_ids_must_cover_one_contiguous_source_range() {
    let source = "one\n\ntwo\n\nthree\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone(), document.blocks[2].id.clone()],
        replacement_markdown: "combined\n".into(),
    };

    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &patch),
        Err(RichEditError::InvalidPatch(_))
    ));
}

#[test]
fn raw_current_note_or_raw_replacement_cannot_be_spliced() {
    let raw_source = "[[raw-only]]\n";
    let raw_document = analyze_note_for_rich_edit(raw_source.as_bytes()).unwrap();
    let patch = RichEditPatch {
        expected_revision: raw_document.revision,
        changed_block_ids: Vec::new(),
        replacement_markdown: "safe\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(raw_source.as_bytes(), &patch),
        Err(RichEditError::RawOnly(_))
    ));

    let rich_document = rich("safe\n");
    let patch = RichEditPatch {
        expected_revision: rich_document.revision,
        changed_block_ids: vec![rich_document.blocks[0].id.clone()],
        replacement_markdown: "<script>alert(1)</script>\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(b"safe\n", &patch),
        Err(RichEditError::RawOnly(_))
    ));
}

#[test]
fn patch_cannot_create_or_reinterpret_a_frontmatter_boundary() {
    let document = rich("paragraph\n");
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "---\ntitle: injected\n---\nparagraph\n".into(),
    };

    assert!(matches!(
        apply_rich_edit_patch(b"paragraph\n", &patch),
        Err(RichEditError::InvalidPatch(_)) | Err(RichEditError::RawOnly(_))
    ));
}

#[test]
fn patch_cannot_merge_into_an_unselected_neighbour() {
    let source = "first\n\nsecond\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "merged".into(),
    };

    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &patch),
        Err(RichEditError::InvalidPatch(_))
    ));
}

#[test]
fn deleting_an_interior_heading_cannot_merge_unchanged_paragraphs() {
    let source = "first\n# remove\nsecond\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[1].id.clone()],
        replacement_markdown: String::new(),
    };

    assert!(matches!(
        apply_rich_edit_patch(source.as_bytes(), &patch),
        Err(RichEditError::InvalidPatch(_))
    ));
}

#[test]
fn nested_raw_constructs_in_lists_and_quotes_force_raw_editing() {
    for source in [
        "- item\n\n    indented code\n",
        "- item\n  ```dataview\n  LIST\n  ```\n",
        "> quote\n> ```dataview\n> LIST\n> ```\n",
        "- item\n  ```rust metadata\n  code\n  ```\n",
        "- item\n  ```rust\n  unclosed\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "nested raw-only syntax must fail closed: {source:?}"
        );
    }

    rich("- item\n    - nested item\n  ```text\n  [[literal code]]\n  ```\n");
}

#[test]
fn list_marker_spacing_preserves_nested_indented_code_semantics() {
    for source in [
        "-     indented code\n",
        "-      indented code\n",
        "1.     indented code\n",
        "10)     indented code\n",
        "-     ```rust\n",
        "-     ```rust\n      literal\n      ```\n",
        "1.     # still code\n",
        "-\t\tindented code\n",
        "1.\t\tindented code\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "nested indented code must fail closed: {source:?}"
        );
    }

    for source in [
        "-    paragraph\n",
        "1.    paragraph\n",
        "-\tparagraph\n",
        "1.\tparagraph\n",
        "-\t```rust\n\tliteral\n\t```\n",
        "1.\t```rust\n\tliteral\n\t```\n",
        "- ```text\n  -     literal\n  ```\n",
        "1. ```text\n   1.     literal\n   ```\n",
    ] {
        rich(source);
    }
}

#[test]
fn nested_container_prefixes_cannot_hide_obsidian_callouts() {
    for source in [
        "- > [!NOTE]\n  > body\n",
        "> > [!NOTE]\n> > body\n",
        "1. > [!WARNING]\n   > body\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "nested Obsidian callout must fail closed: {source:?}"
        );
    }

    rich("- [!NOTE] is ordinary list text\n");
    rich("> - [!NOTE] is a list inside a quote\n");
}

#[test]
fn blockquote_prefixes_cannot_hide_raw_only_document_constructs() {
    for source in [
        "> Setext title\n> ============\n",
        "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n",
        "> [reference]: https://example.com\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "container-prefixed raw construct must fail closed: {source:?}"
        );
    }
}

#[test]
fn nested_link_labels_cannot_hide_an_unsafe_destination() {
    for source in [
        "[outer [inner]](javascript:alert(1))\n",
        "[outer [inner] suffix](javascript:alert(1))\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich
        );
    }
}

#[test]
fn unmatched_link_label_scanning_has_a_bounded_linear_work_profile() {
    let source = format!("{}\n", "[a".repeat(20_000));

    let started = Instant::now();
    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();

    assert_eq!(document.disposition, RichEditDisposition::Rich);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "40 KiB of unmatched labels exceeded the linear-time budget: {:?}",
        started.elapsed()
    );
}

#[test]
fn character_references_cannot_hide_unsafe_link_destinations() {
    for source in [
        "[x](javascript&colon;alert(1))\n",
        "[x](Areas&sol;..&sol;secret.md)\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "character-reference destination must fail closed: {source:?}"
        );
    }
}

#[test]
fn encoded_vault_link_traversal_separators_and_double_encoding_are_rejected() {
    for source in [
        "[x](%2e%2e/escape.md)\n",
        "[x](Areas/%2e%2e/secret.md)\n",
        "[x](Areas%2fsecret.md)\n",
        "[x](Areas%5csecret.md)\n",
        "[x](%252e%252e%252fescape.md)\n",
        "[x](Areas/%00secret.md)\n",
        "[x](Areas/%zzsecret.md)\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "encoded traversal must fail closed: {source:?}"
        );
    }
}

#[test]
fn vault_link_queries_and_fragments_cannot_hide_parent_traversal() {
    for source in [
        "[..](..?x)\n",
        "[..](..#x)\n",
        "[x](Areas/..?x)\n",
        "[x](Areas/..#x)\n",
        "[x](Areas/..%3fx)\n",
        "[x](Areas/..%23x)\n",
    ] {
        assert_ne!(
            analyze_note_for_rich_edit(source.as_bytes())
                .unwrap()
                .disposition,
            RichEditDisposition::Rich,
            "query or fragment must not hide path traversal: {source:?}"
        );
    }

    rich("[x](Areas/note.md?view=compact)\n");
    rich("[x](Areas/note.md#Heading)\n");
    rich("[x](#Heading)\n");
}

#[test]
fn newline_dense_maximum_note_is_rejected_before_line_index_allocation() {
    let source = "\n".repeat(MAX_RICH_NOTE_BYTES);

    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();

    assert!(matches!(
        document.disposition,
        RichEditDisposition::Raw { reason }
            if reason.code == RichEditFallbackCode::UnsupportedSyntax
    ));

    let prefix = "---\ntitle: dense\n---\n";
    let source = format!(
        "{prefix}{}",
        "\n".repeat(MAX_RICH_NOTE_BYTES - prefix.len())
    );
    let document = analyze_note_for_rich_edit(source.as_bytes()).unwrap();
    assert!(matches!(
        document.disposition,
        RichEditDisposition::Raw { reason }
            if reason.code == RichEditFallbackCode::UnsupportedSyntax
    ));
}

#[test]
fn patch_shape_is_bounded_before_secondary_validation_allocations() {
    let document = rich("body\n");
    let oversized_revision = RichEditPatch {
        expected_revision: "r".repeat(1_024),
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "changed\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(b"body\n", &oversized_revision),
        Err(RichEditError::InvalidPatch(_))
    ));

    let oversized_id = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec!["i".repeat(1_024)],
        replacement_markdown: "changed\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(b"body\n", &oversized_id),
        Err(RichEditError::InvalidPatch(_))
    ));

    let too_many_ids = serde_json::json!({
        "expectedRevision": "1",
        "changedBlockIds": vec!["id"; 10_001],
        "replacementMarkdown": "changed\n",
    });
    assert!(serde_json::from_value::<RichEditPatch>(too_many_ids).is_err());

    let oversized_wire_id = serde_json::json!({
        "expectedRevision": "1",
        "changedBlockIds": ["i".repeat(1_024)],
        "replacementMarkdown": "changed\n",
    });
    assert!(serde_json::from_value::<RichEditPatch>(oversized_wire_id).is_err());

    let valid_wire = serde_json::json!({
        "expectedRevision": "123",
        "changedBlockIds": ["rb0x123"],
        "replacementMarkdown": "changed\n",
    });
    let parsed = serde_json::from_value::<RichEditPatch>(valid_wire).unwrap();
    assert_eq!(parsed.expected_revision, "123");
    assert_eq!(parsed.changed_block_ids, ["rb0x123"]);
    assert_eq!(parsed.replacement_markdown, "changed\n");

    let too_many_direct = RichEditPatch {
        expected_revision: "1".into(),
        changed_block_ids: vec!["id".into(); 10_001],
        replacement_markdown: "changed\n".into(),
    };
    assert!(matches!(
        apply_rich_edit_patch(b"body\n", &too_many_direct),
        Err(RichEditError::InvalidPatch(_))
    ));
}

#[test]
fn wire_patch_rejects_missing_duplicate_and_unknown_fields() {
    let invalid = [
        r#"{"changedBlockIds":[],"replacementMarkdown":""}"#,
        r#"{"expectedRevision":"1","replacementMarkdown":""}"#,
        r#"{"expectedRevision":"1","changedBlockIds":[]}"#,
        r#"{"expectedRevision":"1","changedBlockIds":[],"replacementMarkdown":"","extra":1}"#,
        r#"{"expectedRevision":"1","expectedRevision":"2","changedBlockIds":[],"replacementMarkdown":""}"#,
        r#"{"expectedRevision":"1","changedBlockIds":[],"changedBlockIds":[],"replacementMarkdown":""}"#,
        r#"{"expectedRevision":"1","changedBlockIds":[],"replacementMarkdown":"","replacementMarkdown":"again"}"#,
    ];

    for wire in invalid {
        assert!(
            serde_json::from_str::<RichEditPatch>(wire).is_err(),
            "wire must be rejected: {wire}"
        );
    }

    let valid =
        r#"{"expectedRevision":"1","changedBlockIds":["rb0x1"],"replacementMarkdown":"body\n"}"#;
    assert!(serde_json::from_str::<RichEditPatch>(valid).is_ok());
}

#[test]
fn deletion_with_preserved_blank_boundaries_remains_valid() {
    let source = "first\n\n# remove\n\nsecond\n";
    let document = rich(source);
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[1].id.clone()],
        replacement_markdown: String::new(),
    };

    let applied = apply_rich_edit_patch(source.as_bytes(), &patch).unwrap();

    assert_eq!(applied.content, "first\n\nsecond\n");
}
