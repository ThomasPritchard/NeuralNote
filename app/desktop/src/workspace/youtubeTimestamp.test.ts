// Contract fixture shared with neuralnote-core::capture::transcript tests.
// If the core renderer syntax changes, this exact parser fixture must change in
// the same slice so timestamp affordances cannot silently disappear.

import { describe, expect, it } from "vitest";
import { parseYoutubeTimestampJump } from "./youtubeTimestamp";

const CORE_RENDERED_CITATION =
  "[00:00:05](https://youtu.be/iG9CE55wbtY?t=5) Ground truth.";

describe("parseYoutubeTimestampJump", () => {
  it("parses the core renderer's exact single-bracket citation contract", () => {
    expect(parseYoutubeTimestampJump(CORE_RENDERED_CITATION)).toEqual({
      href: "https://youtu.be/iG9CE55wbtY?t=5",
      label: "00:05",
    });
  });

  it("rejects the obsolete doubled-bracket form", () => {
    expect(
      parseYoutubeTimestampJump(
        "[[00:00:05]](https://youtu.be/iG9CE55wbtY?t=5) Old form.",
      ),
    ).toBeNull();
  });
});
