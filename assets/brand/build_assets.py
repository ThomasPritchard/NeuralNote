#!/usr/bin/env python3
"""Build the NeuralNote raster brand pack from one transparent master mark."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


VIOLET = "#A879EF"
DARK = "#29282B"
INK = "#201E22"
CREAM = "#F2EBDD"
SOFT_WHITE = "#EFEDF2"


def rgba(hex_colour: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = hex_colour.removeprefix("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4)) + (alpha,)


def trim(image: Image.Image, threshold: int = 2) -> Image.Image:
    image = image.convert("RGBA")
    alpha = image.getchannel("A").point(lambda value: 255 if value > threshold else 0)
    box = alpha.getbbox()
    if box is None:
        raise ValueError("image has no visible pixels")
    return image.crop(box)


def contain(image: Image.Image, width: int, height: int) -> Image.Image:
    image = trim(image)
    scale = min(width / image.width, height / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def recolour(image: Image.Image, colour: str) -> Image.Image:
    image = image.convert("RGBA")
    result = Image.new("RGBA", image.size, rgba(colour, 0))
    result.putalpha(image.getchannel("A"))
    return result


def transparent_mark(master: Image.Image, colour: str | None = None, size: int = 1024) -> Image.Image:
    source = recolour(master, colour) if colour else master
    fitted = contain(source, round(size * 0.80), round(size * 0.80))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def extract_wordmark(board: Image.Image, colour: str) -> Image.Image:
    # Hero-panel crop. The generated board is 1536x1024; scale coordinates for equivalent exports.
    sx = board.width / 1536
    sy = board.height / 1024
    box = tuple(round(value * scale) for value, scale in zip((178, 151, 558, 225), (sx, sy, sx, sy)))
    crop = board.crop(box).convert("RGB")
    luminance = crop.convert("L")
    # Isolate the near-white wordmark from the charcoal panel while retaining antialiasing.
    alpha = luminance.point(lambda value: max(0, min(255, round((value - 72) * 1.55))))
    alpha = ImageEnhance.Contrast(alpha).enhance(1.15)
    wordmark = Image.new("RGBA", crop.size, rgba(colour, 0))
    wordmark.putalpha(alpha)
    return trim(wordmark, threshold=5)


def make_lockup(mark: Image.Image, wordmark: Image.Image, mark_colour: str | None = None) -> Image.Image:
    mark_source = recolour(mark, mark_colour) if mark_colour else mark
    fitted_mark = contain(mark_source, 260, 260)
    fitted_wordmark = contain(wordmark, 1050, 160)
    gap = 72
    width = fitted_mark.width + gap + fitted_wordmark.width
    height = max(fitted_mark.height, fitted_wordmark.height)
    canvas = Image.new("RGBA", (width + 32, height + 32), (0, 0, 0, 0))
    mark_y = (canvas.height - fitted_mark.height) // 2
    wordmark_y = (canvas.height - fitted_wordmark.height) // 2
    canvas.alpha_composite(fitted_mark, (16, mark_y))
    canvas.alpha_composite(fitted_wordmark, (16 + fitted_mark.width + gap, wordmark_y))
    return canvas


def make_app_icon(master: Image.Image, size: int = 1024) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    margin = round(size * 0.08)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=round(size * 0.23),
        fill=rgba(DARK),
    )
    shadow = tile.getchannel("A").filter(ImageFilter.GaussianBlur(round(size * 0.025)))
    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_layer.putalpha(shadow.point(lambda value: round(value * 0.18)))
    canvas.alpha_composite(shadow_layer, (0, round(size * 0.018)))
    canvas.alpha_composite(tile)
    fitted = contain(master, round(size * 0.57), round(size * 0.57))
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def make_preview(
    violet_mark: Image.Image,
    lockup_dark: Image.Image,
    lockup_light: Image.Image,
    app_icon: Image.Image,
) -> Image.Image:
    preview = Image.new("RGB", (1600, 900), rgba(CREAM)[:3])
    draw = ImageDraw.Draw(preview)
    draw.rounded_rectangle((36, 36, 1564, 430), radius=34, fill=rgba(DARK)[:3])
    draw.rounded_rectangle((36, 466, 1018, 864), radius=34, fill=(246, 241, 232))
    draw.rounded_rectangle((1054, 466, 1564, 864), radius=34, fill=(225, 216, 230))

    top = contain(lockup_dark, 1250, 230)
    preview.paste(top, ((1600 - top.width) // 2, 118), top)
    lower = contain(lockup_light, 760, 210)
    preview.paste(lower, (120, 560), lower)
    icon = app_icon.resize((310, 310), Image.Resampling.LANCZOS)
    preview.paste(icon, (1154, 510), icon)

    # A small transparent-mark proof on cream.
    mark = violet_mark.resize((96, 96), Image.Resampling.LANCZOS)
    preview.paste(mark, (850, 742), mark)
    return preview


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--master", type=Path, required=True)
    parser.add_argument("--board", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    master = trim(Image.open(args.master))
    board = Image.open(args.board)
    output = args.output

    violet_mark = transparent_mark(master)
    black_mark = transparent_mark(master, INK)
    white_mark = transparent_mark(master, SOFT_WHITE)
    save(violet_mark, output / "neuralnote-mark-violet.png")
    save(black_mark, output / "neuralnote-mark-black.png")
    save(white_mark, output / "neuralnote-mark-white.png")

    wordmark_light = extract_wordmark(board, SOFT_WHITE)
    wordmark_dark = extract_wordmark(board, INK)
    save(wordmark_light, output / "neuralnote-wordmark-light.png")
    save(wordmark_dark, output / "neuralnote-wordmark-dark.png")

    lockup_dark = make_lockup(master, wordmark_light)
    lockup_light = make_lockup(master, wordmark_dark)
    lockup_white = make_lockup(master, wordmark_light, SOFT_WHITE)
    lockup_black = make_lockup(master, wordmark_dark, INK)
    save(lockup_dark, output / "neuralnote-lockup-dark-bg.png")
    save(lockup_light, output / "neuralnote-lockup-light-bg.png")
    save(lockup_white, output / "neuralnote-lockup-white.png")
    save(lockup_black, output / "neuralnote-lockup-black.png")

    app_icon = make_app_icon(master)
    save(app_icon, output / "neuralnote-app-icon.png")

    for size in (16, 24, 32, 64, 128, 256, 512, 1024):
        save(app_icon.resize((size, size), Image.Resampling.LANCZOS), output / "icons" / f"neuralnote-app-icon-{size}.png")
        save(violet_mark.resize((size, size), Image.Resampling.LANCZOS), output / "marks" / f"neuralnote-mark-{size}.png")

    save(make_preview(violet_mark, lockup_dark, lockup_light, app_icon), output / "preview.png")


if __name__ == "__main__":
    main()
