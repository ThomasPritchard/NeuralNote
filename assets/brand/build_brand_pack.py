#!/usr/bin/env python3
"""Build the NeuralNote brand guidelines PDF and product roadmap artwork."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"
GEIST = (
    ROOT
    / "prototype"
    / "neuralnote-proto"
    / "node_modules"
    / "@fontsource-variable"
    / "geist"
    / "files"
    / "geist-latin-wght-normal.woff2"
)
INTER = (
    ROOT
    / "app"
    / "desktop"
    / "node_modules"
    / "@fontsource-variable"
    / "inter"
    / "files"
    / "inter-latin-wght-normal.woff2"
)
MONO = (
    ROOT
    / "app"
    / "desktop"
    / "node_modules"
    / "@fontsource-variable"
    / "jetbrains-mono"
    / "files"
    / "jetbrains-mono-latin-wght-normal.woff2"
)

VIOLET = "#A879EF"
VIOLET_DEEP = "#7652C8"
DARK = "#29282B"
INK = "#201E22"
CREAM = "#F2EBDD"
SOFT_WHITE = "#EFEDF2"
MUTED = "#AAA5B0"
PANEL = "#323035"
BORDER = "#4A474E"
PINK = "#DB70A9"
HEALTHY = "#7BCF9B"
WARNING = "#E4B96C"

PAGE_W = 1920
PAGE_H = 1358
MARGIN = 104


def rgb(value: str) -> tuple[int, int, int]:
    value = value.removeprefix("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    return (*rgb(value), alpha)


def mix(a: str, b: str, amount: float) -> tuple[int, int, int]:
    ar, ag, ab = rgb(a)
    br, bg, bb = rgb(b)
    return (
        round(ar + (br - ar) * amount),
        round(ag + (bg - ag) * amount),
        round(ab + (bb - ab) * amount),
    )


def font_path(kind: str) -> Path:
    if kind == "mono":
        return MONO
    if kind == "ui":
        return INTER
    return GEIST if GEIST.exists() else INTER


def font(size: int, weight: int = 400, kind: str = "brand") -> ImageFont.FreeTypeFont:
    selected = font_path(kind)
    if not selected.exists():
        selected = Path("/System/Library/Fonts/SFNS.ttf")
    face = ImageFont.truetype(str(selected), size)
    try:
        axes = face.get_variation_axes()
        if axes:
            maximum = int(axes[0]["maximum"])
            minimum = int(axes[0]["minimum"])
            face.set_variation_by_axes([max(minimum, min(maximum, weight))])
    except OSError:
        pass
    return face


def text_width(draw: ImageDraw.ImageDraw, value: str, face: ImageFont.FreeTypeFont) -> float:
    return draw.textlength(value, font=face)


def fit_font(
    draw: ImageDraw.ImageDraw,
    value: str,
    max_width: int,
    start_size: int,
    minimum_size: int = 16,
    weight: int = 400,
    kind: str = "brand",
) -> ImageFont.FreeTypeFont:
    for size in range(start_size, minimum_size - 1, -1):
        face = font(size, weight, kind)
        if text_width(draw, value, face) <= max_width:
            return face
    return font(minimum_size, weight, kind)


def wrap_lines(
    draw: ImageDraw.ImageDraw,
    value: str,
    face: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    lines: list[str] = []
    for paragraph in value.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        line = words[0]
        for word in words[1:]:
            candidate = f"{line} {word}"
            if text_width(draw, candidate, face) <= max_width:
                line = candidate
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    *,
    size: int,
    colour: str = SOFT_WHITE,
    weight: int = 400,
    kind: str = "brand",
    max_width: int | None = None,
    line_gap: float = 1.25,
    anchor: str | None = None,
) -> int:
    face = font(size, weight, kind)
    lines = wrap_lines(draw, value, face, max_width) if max_width else value.split("\n")
    y = xy[1]
    advance = round(size * line_gap)
    for line in lines:
        draw.text((xy[0], y), line, font=face, fill=rgb(colour), anchor=anchor)
        y += advance
    return y


def rounded_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    *,
    fill: str = PANEL,
    outline: str = BORDER,
    radius: int = 28,
    width: int = 2,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=rgb(fill), outline=rgb(outline), width=width)


def contain(image: Image.Image, width: int, height: int) -> Image.Image:
    image = image.convert("RGBA")
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    return image


def paste_contain(
    canvas_image: Image.Image,
    source: Path | Image.Image,
    box: tuple[int, int, int, int],
    *,
    align: str = "center",
) -> None:
    image = Image.open(source).convert("RGBA") if isinstance(source, Path) else source.convert("RGBA")
    left, top, right, bottom = box
    fitted = contain(image, right - left, bottom - top)
    if align == "left":
        x = left
    elif align == "right":
        x = right - fitted.width
    else:
        x = left + (right - left - fitted.width) // 2
    y = top + (bottom - top - fitted.height) // 2
    canvas_image.alpha_composite(fitted, (x, y))


def gradient(size: tuple[int, int], top: str = "#18171A", bottom: str = DARK) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        amount = y / max(1, height - 1)
        draw.line((0, y, width, y), fill=mix(top, bottom, amount))
    return image.convert("RGBA")


def draw_grid(image: Image.Image, spacing: int = 80, alpha: int = 15) -> None:
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(0, image.width, spacing):
        draw.line((x, 0, x, image.height), fill=rgba(SOFT_WHITE, alpha), width=1)
    for y in range(0, image.height, spacing):
        draw.line((0, y, image.width, y), fill=rgba(SOFT_WHITE, alpha), width=1)
    image.alpha_composite(overlay)


def page_base(label: str, number: int, *, light: bool = False) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    background = CREAM if light else "#1B1A1D"
    image = Image.new("RGBA", (PAGE_W, PAGE_H), rgb(background) + (255,))
    if not light:
        draw_grid(image, 96, 10)
    draw = ImageDraw.Draw(image)
    ink = INK if light else SOFT_WHITE
    muted = "#6D6870" if light else MUTED
    draw_text(draw, (MARGIN, 55), f"{number:02d}", size=22, colour=VIOLET, weight=600, kind="mono")
    draw_text(draw, (MARGIN + 66, 55), label.upper(), size=22, colour=muted, weight=500, kind="mono")
    draw.line((MARGIN, 101, PAGE_W - MARGIN, 101), fill=rgb("#D4CBBF" if light else BORDER), width=2)
    draw_text(draw, (PAGE_W - MARGIN, PAGE_H - 54), "NEURALNOTE BRAND PACK / JULY 2026", size=17, colour=muted, weight=500, kind="mono", anchor="rs")
    return image, draw


def page_title(
    draw: ImageDraw.ImageDraw,
    title: str,
    subtitle: str,
    *,
    light: bool = False,
) -> None:
    ink = INK if light else SOFT_WHITE
    muted = "#625D65" if light else MUTED
    draw_text(draw, (MARGIN, 152), title, size=70, colour=ink, weight=560)
    draw_text(draw, (MARGIN, 245), subtitle, size=25, colour=muted, max_width=1350, line_gap=1.45)


def icon_server(draw: ImageDraw.ImageDraw, origin: tuple[int, int], scale: float = 1.0) -> None:
    x, y = origin
    w = round(110 * scale)
    h = round(34 * scale)
    gap = round(17 * scale)
    for row in range(3):
        top = y + row * (h + gap)
        draw.rounded_rectangle((x, top, x + w, top + h), radius=round(9 * scale), outline=rgb(VIOLET), width=max(2, round(4 * scale)))
        draw.ellipse((x + round(15 * scale), top + round(12 * scale), x + round(25 * scale), top + round(22 * scale)), fill=rgb(VIOLET))
        draw.line((x + round(40 * scale), top + round(17 * scale), x + round(86 * scale), top + round(17 * scale)), fill=rgb(MUTED), width=max(2, round(3 * scale)))


def icon_cloud(draw: ImageDraw.ImageDraw, origin: tuple[int, int], scale: float = 1.0) -> None:
    x, y = origin
    stroke = max(2, round(5 * scale))
    draw.arc((x + round(10 * scale), y + round(52 * scale), x + round(90 * scale), y + round(132 * scale)), 120, 300, fill=rgb(VIOLET), width=stroke)
    draw.arc((x + round(58 * scale), y + round(8 * scale), x + round(158 * scale), y + round(108 * scale)), 165, 355, fill=rgb(VIOLET), width=stroke)
    draw.arc((x + round(112 * scale), y + round(43 * scale), x + round(192 * scale), y + round(123 * scale)), 215, 60, fill=rgb(VIOLET), width=stroke)
    draw.line((x + round(38 * scale), y + round(122 * scale), x + round(165 * scale), y + round(122 * scale)), fill=rgb(VIOLET), width=stroke)


def icon_wave(draw: ImageDraw.ImageDraw, origin: tuple[int, int], width: int, height: int) -> None:
    x, y = origin
    points: list[tuple[int, int]] = []
    for index in range(width):
        amount = index / max(1, width - 1)
        envelope = math.sin(math.pi * amount) ** 0.85
        signal = math.sin(amount * math.pi * 11) * 0.58 + math.sin(amount * math.pi * 23) * 0.18
        py = y + height // 2 + round(signal * envelope * height * 0.44)
        points.append((x + index, py))
    draw.line(points, fill=rgb(VIOLET), width=max(4, height // 26), joint="curve")


def roadmap_card(
    image: Image.Image,
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    *,
    number: str,
    status: str,
    title: str,
    description: str,
    icon: str,
) -> None:
    left, top, right, bottom = box
    rounded_panel(draw, box, fill="#262529", outline="#4D4952", radius=42, width=3)
    draw_text(draw, (left + 46, top + 40), number, size=24, colour=VIOLET, weight=650, kind="mono")
    status_face = font(18, 650, "mono")
    status_width = round(text_width(draw, status, status_face)) + 34
    draw.rounded_rectangle((right - status_width - 38, top + 35, right - 38, top + 71), radius=18, fill=rgb("#3A3048"))
    draw.text((right - status_width // 2 - 38, top + 53), status, font=status_face, fill=rgb("#CEB3F5"), anchor="mm")

    icon_x = left + 46
    icon_y = top + 115
    if icon == "mark":
        paste_contain(image, BRAND / "neuralnote-mark-violet.png", (icon_x - 17, icon_y - 20, icon_x + 155, icon_y + 152), align="left")
    elif icon == "server":
        icon_server(draw, (icon_x + 8, icon_y + 3), 1.1)
    elif icon == "cloud":
        icon_cloud(draw, (icon_x - 5, icon_y - 3), 0.88)
    elif icon == "cli":
        draw_text(draw, (icon_x, icon_y + 2), ">_", size=92, colour=VIOLET, weight=650, kind="mono")

    draw_text(draw, (left + 46, top + 305), title, size=47, colour=SOFT_WHITE, weight=560, max_width=right - left - 92, line_gap=1.12)
    draw_text(draw, (left + 46, top + 436), description, size=23, colour=MUTED, weight=400, max_width=right - left - 92, line_gap=1.42)


def build_roadmap(output: Path) -> None:
    image = gradient((3840, 2160), "#141316", "#2A282D")
    draw_grid(image, 120, 13)
    draw = ImageDraw.Draw(image)

    # Violet atmospheric field, restrained to the top-right.
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((2760, -480, 4400, 1110), fill=rgba(VIOLET, 38))
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    image.alpha_composite(glow)

    paste_contain(image, BRAND / "neuralnote-lockup-dark-bg.png", (220, 132, 1130, 330), align="left")
    draw_text(draw, (220, 408), "PRODUCT ROADMAP", size=25, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (220, 468), "More knowledge, less setup.", size=92, colour=SOFT_WHITE, weight=560)
    draw_text(draw, (220, 586), "Built for instant use. Every surface extends the same user-owned knowledge system.", size=30, colour=MUTED, max_width=2500, line_gap=1.35)

    card_top = 770
    card_bottom = 1555
    card_width = 790
    gap = 50
    left = 220
    cards = [
        ("01", "FOUNDATION", "NeuralNote\nDesktop", "The local-first AI assistant for notes, capture, search and connected answers.", "mark"),
        ("02", "PLANNED", "NeuralNote\nAPI Server", "A reusable service layer for NeuralNote's core knowledge and AI capabilities.", "server"),
        ("03", "PLANNED", "NeuralNote\nCloud App", "A hosted NeuralNote experience for access, continuity and future connected workflows.", "cloud"),
        ("04", "PLANNED", "NeuralNote\nCLI", "A direct command-line surface for capture, automation and knowledge workflows.", "cli"),
    ]
    for index, (number, status, title, description, icon) in enumerate(cards):
        x = left + index * (card_width + gap)
        roadmap_card(
            image,
            draw,
            (x, card_top, x + card_width, card_bottom),
            number=number,
            status=status,
            title=title,
            description=description,
            icon=icon,
        )

    voice_box = (220, 1630, 3620, 1992)
    rounded_panel(draw, voice_box, fill="#241F2B", outline="#6A557F", radius=42, width=3)
    draw_text(draw, (280, 1680), "EXPLORATION / TO BE CONFIRMED", size=22, colour="#CEB3F5", weight=650, kind="mono")
    draw_text(draw, (280, 1740), "Neural Voice", size=58, colour=SOFT_WHITE, weight=560)
    draw_text(
        draw,
        (280, 1822),
        "A WhisperFlow-like voice app designed to help people talk to AI.",
        size=28,
        colour=MUTED,
        max_width=2100,
        line_gap=1.35,
    )
    icon_wave(draw, (2650, 1734), 760, 170)
    draw_text(draw, (3620, 2070), "NEURALNOTE PRODUCT FAMILY / JULY 2026", size=20, colour="#8D8793", weight=500, kind="mono", anchor="rs")

    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, quality=96, subsampling=0, optimize=True)


def cover_page() -> Image.Image:
    image = gradient((PAGE_W, PAGE_H), "#171619", DARK)
    draw_grid(image, 96, 12)
    draw = ImageDraw.Draw(image)
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((1090, -230, 2100, 800), fill=rgba(VIOLET, 45))
    glow = glow.filter(ImageFilter.GaussianBlur(130))
    image.alpha_composite(glow)
    paste_contain(image, BRAND / "neuralnote-lockup-dark-bg.png", (MARGIN, 210, 1280, 540), align="left")
    draw_text(draw, (MARGIN, 625), "BRAND PACK", size=26, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (MARGIN, 690), "More knowledge,\nless setup.", size=82, colour=SOFT_WHITE, weight=540, line_gap=1.08)
    draw_text(draw, (MARGIN, 930), "Built for instant use.", size=32, colour="#CEB3F5", weight=500)
    draw_text(draw, (MARGIN, 995), "Identity / palette / typography / applications / product roadmap", size=21, colour=MUTED, max_width=1180)
    draw_text(draw, (MARGIN, PAGE_H - 72), "JULY 2026 / VERSION 1.0", size=19, colour=MUTED, weight=500, kind="mono")
    paste_contain(image, BRAND / "neuralnote-app-icon.png", (1410, 855, 1785, 1230))
    return image


def approved_system_page() -> Image.Image:
    image, draw = page_base("Approved identity", 2)
    page_title(draw, "The identity stays. The promise gets clearer.", "One mark, one wordmark and one simple reason to choose NeuralNote.")
    rounded_panel(draw, (MARGIN, 390, 1120, 850), fill="#242326", outline=BORDER, radius=34)
    paste_contain(image, BRAND / "neuralnote-lockup-dark-bg.png", (180, 455, 1010, 690), align="left")
    draw_text(draw, (180, 730), "More knowledge, less setup.", size=45, colour=SOFT_WHITE, weight=540)
    draw_text(draw, (180, 792), "Built for instant use.", size=24, colour="#CEB3F5", weight=500)

    rounded_panel(draw, (1170, 390, PAGE_W - MARGIN, 850), fill=CREAM, outline="#D9D0C3", radius=34)
    paste_contain(image, BRAND / "neuralnote-app-icon.png", (1320, 445, 1695, 820))

    rounded_panel(draw, (MARGIN, 900, 835, 1195), fill=CREAM, outline="#D9D0C3", radius=30)
    paste_contain(image, BRAND / "neuralnote-lockup-light-bg.png", (160, 945, 770, 1110))
    draw_text(draw, (160, 1132), "LIGHT APPLICATION", size=17, colour=VIOLET_DEEP, weight=650, kind="mono")

    rounded_panel(draw, (885, 900, PAGE_W - MARGIN, 1195), fill="#242326", outline=BORDER, radius=30)
    palette = [(VIOLET, "VIOLET"), (DARK, "CHARCOAL"), (CREAM, "CREAM"), (SOFT_WHITE, "SOFT WHITE")]
    for index, (colour, label) in enumerate(palette):
        x = 940 + index * 205
        draw.rounded_rectangle((x, 958, x + 132, 1090), radius=22, fill=rgb(colour), outline=rgb(BORDER), width=2)
        draw_text(draw, (x, 1122), label, size=15, colour=MUTED, weight=650, kind="mono")
    return image


def brand_core_page() -> Image.Image:
    image, draw = page_base("Brand core", 3, light=True)
    page_title(draw, "Built for instant use.", "A complete knowledge workflow, built on files you own.", light=True)
    pillars = [
        ("01", "READY MADE", "Capture, organisation and search are already part of the product."),
        ("02", "AI ASSISTANT", "NeuralNote helps you understand what you saved and keeps answers connected to the source."),
        ("03", "USER OWNED", "Markdown and YAML remain open, portable and useful without NeuralNote."),
    ]
    card_w = 540
    gap = 46
    for index, (number, heading, body) in enumerate(pillars):
        x = MARGIN + index * (card_w + gap)
        box = (x, 420, x + card_w, 1045)
        rounded_panel(draw, box, fill="#FAF6ED", outline="#D6CCBF", radius=34, width=2)
        draw_text(draw, (x + 44, 464), number, size=22, colour=VIOLET_DEEP, weight=650, kind="mono")
        draw_text(draw, (x + 44, 550), heading, size=24, colour="#746B75", weight=650, kind="mono")
        draw_text(draw, (x + 44, 620), body, size=34, colour=INK, weight=500, max_width=card_w - 88, line_gap=1.32)
    draw_text(draw, (MARGIN, 1120), "BRAND PROMISE", size=20, colour=VIOLET_DEEP, weight=650, kind="mono")
    draw_text(draw, (MARGIN, 1172), "More knowledge, less setup.", size=50, colour=INK, weight=540)
    return image


def logo_system_page() -> Image.Image:
    image, draw = page_base("Logo system", 4)
    page_title(draw, "A note that connects.", "The symbol combines a note tile, a connected thought or page turn, and an index tab that doubles as a citation locator.")
    left = (MARGIN, 390, 890, 1120)
    right = (940, 390, PAGE_W - MARGIN, 1120)
    rounded_panel(draw, left, fill="#242326", outline=BORDER, radius=34)
    rounded_panel(draw, right, fill=CREAM, outline="#D9D0C3", radius=34)
    paste_contain(image, BRAND / "neuralnote-lockup-dark-bg.png", (180, 525, 820, 800))
    paste_contain(image, BRAND / "neuralnote-lockup-light-bg.png", (1020, 525, 1740, 800))
    draw_text(draw, (160, 955), "DARK SURFACES", size=20, colour=MUTED, weight=650, kind="mono")
    draw_text(draw, (1010, 955), "LIGHT SURFACES", size=20, colour="#6F6871", weight=650, kind="mono")
    draw_text(draw, (160, 1005), "Violet mark + soft-white wordmark", size=25, colour=SOFT_WHITE)
    draw_text(draw, (1010, 1005), "Violet mark + ink wordmark", size=25, colour=INK)
    draw_text(draw, (MARGIN, 1174), "Keep the diagonal fold transparent. It should reveal the surface behind the mark.", size=24, colour=MUTED, max_width=1500)
    return image


def palette_page() -> Image.Image:
    image, draw = page_base("Colour", 5, light=True)
    page_title(draw, "Low chroma. One clear signal.", "Charcoal and cream do the structural work. Violet carries NeuralNote's intelligence and identity.", light=True)
    swatches = [
        ("NEURAL VIOLET", VIOLET, "Primary mark / AI / focus"),
        ("DARK SURFACE", DARK, "Dark applications / chrome"),
        ("INK", INK, "Light-mode type / monochrome"),
        ("CREAM", CREAM, "Light applications / warmth"),
        ("SOFT WHITE", SOFT_WHITE, "Dark-mode type / monochrome"),
    ]
    swatch_w = 316
    gap = 28
    for index, (name, colour, role) in enumerate(swatches):
        x = MARGIN + index * (swatch_w + gap)
        draw.rounded_rectangle((x, 430, x + swatch_w, 765), radius=28, fill=rgb(colour), outline=rgb("#CFC4B7"), width=2)
        label_colour = SOFT_WHITE if colour in {DARK, INK} else INK
        if colour == VIOLET:
            label_colour = INK
        draw_text(draw, (x + 26, 648), name, size=18, colour=label_colour, weight=650, kind="mono")
        draw_text(draw, (x + 26, 690), colour, size=22, colour=label_colour, weight=600, kind="mono")
        draw_text(draw, (x, 805), role, size=21, colour="#625D65", max_width=swatch_w)

    draw_text(draw, (MARGIN, 930), "PRODUCT SEMANTICS", size=20, colour=VIOLET_DEEP, weight=650, kind="mono")
    semantics = [
        ("AI / FOCUS", VIOLET),
        ("CHAT ACTION", PINK),
        ("HEALTHY", HEALTHY),
        ("WARNING", WARNING),
    ]
    for index, (name, colour) in enumerate(semantics):
        x = MARGIN + index * 400
        draw.ellipse((x, 1005, x + 52, 1057), fill=rgb(colour))
        draw_text(draw, (x + 72, 1009), name, size=20, colour=INK, weight=650, kind="mono")
    draw_text(draw, (MARGIN, 1135), "Use semantic colour sparingly. Errors and health states must remain explicit in copy, not colour alone.", size=25, colour="#625D65", max_width=1500)
    return image


def typography_page() -> Image.Image:
    image, draw = page_base("Typography", 6)
    page_title(draw, "Quiet type. Clear hierarchy.", "The brand and the product use related but deliberately separate typography roles.")
    left = (MARGIN, 390, 1030, 1130)
    right = (1080, 390, PAGE_W - MARGIN, 1130)
    rounded_panel(draw, left, fill="#242326", outline=BORDER, radius=34)
    rounded_panel(draw, right, fill="#242326", outline=BORDER, radius=34)
    draw_text(draw, (150, 440), "BRAND / GEIST VARIABLE", size=19, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (150, 515), "NeuralNote", size=112, colour=SOFT_WHITE, weight=500)
    draw_text(draw, (150, 680), "Calm, compact and precise.", size=36, colour=MUTED, weight=400)
    draw_text(draw, (150, 785), "DISPLAY", size=18, colour="#7E7883", weight=650, kind="mono")
    draw_text(draw, (150, 830), "Geist Medium 500", size=31, colour=SOFT_WHITE, weight=500)
    draw_text(draw, (150, 910), "BODY", size=18, colour="#7E7883", weight=650, kind="mono")
    draw_text(draw, (150, 955), "Geist Regular 400", size=31, colour=SOFT_WHITE, weight=400)
    draw_text(draw, (1125, 440), "PRODUCT UI", size=19, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (1125, 515), "Inter", size=104, colour=SOFT_WHITE, weight=520, kind="ui")
    draw_text(draw, (1125, 650), "UI and note reading", size=28, colour=MUTED, kind="ui")
    draw_text(draw, (1125, 765), "JetBrains Mono", size=50, colour=SOFT_WHITE, weight=500, kind="mono")
    draw_text(draw, (1125, 842), "paths / models / time / metadata", size=21, colour=MUTED, kind="mono")
    draw_text(draw, (1125, 960), "Do not retype the raster wordmark.", size=27, colour="#CEB3F5", weight=500, max_width=600)
    return image


def product_expression_page() -> Image.Image:
    image, draw = page_base("Product expression", 7)
    page_title(draw, "Your AI-powered knowledge assistant.", "Open a Markdown vault and start. Notes, search and connected answers take priority over setup.")
    shell = (MARGIN, 390, PAGE_W - MARGIN, 1060)
    rounded_panel(draw, shell, fill="#202024", outline="#56515A", radius=38, width=3)
    # Simplified desktop chrome, intentionally not a feature screenshot.
    draw.rounded_rectangle((MARGIN + 24, 414, PAGE_W - MARGIN - 24, 494), radius=22, fill=rgb("#3A383D"))
    for index, colour in enumerate(("#FF6B65", "#E9B84F", "#64C66B")):
        draw.ellipse((MARGIN + 58 + index * 38, 442, MARGIN + 76 + index * 38, 460), fill=rgb(colour))
    paste_contain(image, BRAND / "neuralnote-mark-violet.png", (MARGIN + 190, 425, MARGIN + 250, 485), align="left")
    draw_text(draw, (MARGIN + 262, 435), "NeuralNote", size=24, colour=SOFT_WHITE, weight=500, kind="ui")
    draw.rectangle((MARGIN + 24, 510, MARGIN + 265, 1036), fill=rgb("#2B2A2E"))
    draw.rectangle((MARGIN + 281, 510, MARGIN + 650, 1036), fill=rgb("#252428"))
    draw.rectangle((MARGIN + 666, 510, PAGE_W - MARGIN - 470, 1036), fill=rgb("#29282B"))
    draw.rectangle((PAGE_W - MARGIN - 454, 510, PAGE_W - MARGIN - 24, 1036), fill=rgb("#302F33"))
    nav = ["Files", "Search", "Graph", "Settings"]
    for index, label in enumerate(nav):
        y = 590 + index * 92
        if index == 0:
            draw.rounded_rectangle((MARGIN + 54, y - 12, MARGIN + 235, y + 48), radius=15, fill=rgb("#433A4E"))
        draw_text(draw, (MARGIN + 84, y), label, size=23, colour=SOFT_WHITE if index == 0 else MUTED, weight=500, kind="ui")
    draw_text(draw, (MARGIN + 324, 560), "PERSONAL VAULT", size=17, colour=MUTED, weight=650, kind="mono")
    for index, label in enumerate(("Daily Notes", "Research", "Ideas", "Projects")):
        draw_text(draw, (MARGIN + 324, 630 + index * 70), label, size=22, colour="#D6D2DA", kind="ui")
    draw_text(draw, (MARGIN + 720, 575), "Ask what you know", size=40, colour=SOFT_WHITE, weight=550, kind="ui")
    draw_text(draw, (MARGIN + 720, 650), "Your assistant finds the relevant notes and keeps every answer connected to the source.", size=25, colour=MUTED, kind="ui", max_width=610, line_gap=1.42)
    draw.rounded_rectangle((MARGIN + 720, 805, MARGIN + 1260, 892), radius=20, fill=rgb("#232226"), outline=rgb(BORDER), width=2)
    draw_text(draw, (MARGIN + 752, 832), "What have I saved about retrieval?", size=22, colour="#D6D2DA", kind="ui")
    draw.rounded_rectangle((PAGE_W - MARGIN - 404, 575, PAGE_W - MARGIN - 78, 722), radius=22, fill=rgb("#3A3048"))
    draw_text(draw, (PAGE_W - MARGIN - 370, 604), "CITED ANSWER", size=17, colour="#CEB3F5", weight=650, kind="mono")
    draw_text(draw, (PAGE_W - MARGIN - 370, 652), "Every claim points\nback to your notes.", size=22, colour=SOFT_WHITE, kind="ui", line_gap=1.35)
    draw_text(draw, (MARGIN, 1124), "No pane-wide gradients. No decorative glow. No silent failures. Motion stays restrained and respects reduced-motion preferences.", size=23, colour=MUTED, max_width=1600)
    return image


def visual_language_page() -> Image.Image:
    image, draw = page_base("Visual language", 8, light=True)
    page_title(draw, "Knowledge has structure.", "Brand materials should feel like notes becoming connected, indexed and ready to interrogate.", light=True)
    cards = [
        ("01", "THE NOTE TILE", "Rounded, calm surfaces. One idea at a time."),
        ("02", "THE CONNECTION", "Thin paths and measured nodes. Never a decorative neural-net cliche."),
        ("03", "THE CITATION", "Precise labels, locators and source chips that make trust visible."),
        ("04", "THE FOLD", "A single diagonal cut that signals transformation without becoming a generic sparkle."),
    ]
    positions = [(MARGIN, 405), (1010, 405), (MARGIN, 790), (1010, 790)]
    for (number, title, body), (x, y) in zip(cards, positions):
        box = (x, y, x + 806, y + 320)
        rounded_panel(draw, box, fill="#FAF6ED", outline="#D8CEBF", radius=34, width=2)
        draw_text(draw, (x + 38, y + 34), number, size=20, colour=VIOLET_DEEP, weight=650, kind="mono")
        draw_text(draw, (x + 38, y + 92), title, size=24, colour="#6A626C", weight=650, kind="mono")
        body_width = 500 if number in {"01", "02", "04"} else 690
        draw_text(draw, (x + 38, y + 154), body, size=30, colour=INK, weight=500, max_width=body_width, line_gap=1.35)
        if number == "01":
            draw.rounded_rectangle((x + 620, y + 62, x + 738, y + 180), radius=24, outline=rgb(VIOLET_DEEP), width=5)
        elif number == "02":
            draw.line((x + 612, y + 104, x + 742, y + 176), fill=rgb(VIOLET_DEEP), width=4)
            for px, py in ((612, 104), (678, 140), (742, 176)):
                draw.ellipse((px - 10, py - 10, px + 10, py + 10), fill=rgb(VIOLET_DEEP))
        elif number == "03":
            draw.rounded_rectangle((x + 602, y + 74, x + 750, y + 138), radius=16, fill=rgb("#E8DDF4"))
            draw_text(draw, (x + 623, y + 93), "[12-18]", size=20, colour=VIOLET_DEEP, weight=650, kind="mono")
        else:
            paste_contain(image, BRAND / "neuralnote-mark-violet.png", (x + 594, y + 42, x + 760, y + 208))
    return image


def applications_page() -> Image.Image:
    image, draw = page_base("Applications", 9)
    page_title(draw, "The system scales from icon to story.", "Every application repeats the same few ingredients: violet signal, charcoal structure, cream contrast and precise labels.")
    # App icon tile.
    rounded_panel(draw, (MARGIN, 390, 610, 1120), fill="#242326", outline=BORDER, radius=36)
    paste_contain(image, BRAND / "neuralnote-app-icon.png", (180, 470, 530, 820))
    draw_text(draw, (155, 895), "APP ICON", size=20, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (155, 945), "Recognisable at 16 px.\nQuiet enough at 1024 px.", size=28, colour=SOFT_WHITE, max_width=390, line_gap=1.35)
    # Social / launch card.
    rounded_panel(draw, (660, 390, 1260, 1120), fill=CREAM, outline="#D8CEBF", radius=36)
    paste_contain(image, BRAND / "neuralnote-lockup-light-bg.png", (730, 480, 1180, 690))
    draw_text(draw, (730, 760), "More knowledge,\nless setup.", size=48, colour=INK, weight=540, line_gap=1.08)
    draw_text(draw, (730, 995), "LAUNCH / EDITORIAL", size=18, colour=VIOLET_DEEP, weight=650, kind="mono")
    # Product-family card.
    rounded_panel(draw, (1310, 390, PAGE_W - MARGIN, 1120), fill="#2C2930", outline="#665273", radius=36)
    paste_contain(image, BRAND / "neuralnote-mark-violet.png", (1380, 455, 1600, 675), align="left")
    draw_text(draw, (1380, 725), "AI ASSISTANT", size=18, colour=VIOLET, weight=650, kind="mono")
    draw_text(draw, (1380, 775), "Built for\ninstant use.", size=48, colour=SOFT_WHITE, weight=540, max_width=400, line_gap=1.08)
    draw_text(draw, (1380, 900), "Desktop / API / Cloud / CLI", size=21, colour=MUTED, kind="mono", max_width=390)
    return image


def asset_library_page() -> Image.Image:
    image, draw = page_base("Asset library", 10, light=True)
    page_title(draw, "Use the supplied masters.", "The approved pack is raster-only. Preserve the original files and choose the variant made for the surface.", light=True)
    rows = [
        ("PRIMARY MARK", "neuralnote-mark-violet.png", "Transparent / 1024 px"),
        ("DARK LOCKUP", "neuralnote-lockup-dark-bg.png", "Violet + soft white"),
        ("LIGHT LOCKUP", "neuralnote-lockup-light-bg.png", "Violet + ink"),
        ("MONOCHROME", "neuralnote-mark-black.png / neuralnote-mark-white.png", "One-colour production"),
        ("APP ICON", "neuralnote-app-icon.png", "Rounded tile / 1024 px"),
        ("SIZE EXPORTS", "icons/ and marks/", "16 / 24 / 32 / 64 / 128 / 256 / 512 / 1024"),
    ]
    y = 405
    for index, (role, filename, note) in enumerate(rows):
        fill = "#FAF6ED" if index % 2 == 0 else "#F3EDE3"
        draw.rounded_rectangle((MARGIN, y, PAGE_W - MARGIN, y + 112), radius=20, fill=rgb(fill))
        draw_text(draw, (MARGIN + 30, y + 28), role, size=18, colour=VIOLET_DEEP, weight=650, kind="mono")
        filename_face = fit_font(draw, filename, 730, 25, 18, 500, "mono")
        draw.text((MARGIN + 355, y + 24), filename, font=filename_face, fill=rgb(INK))
        draw_text(draw, (MARGIN + 1130, y + 26), note, size=23, colour="#625D65", max_width=520)
        y += 128
    draw_text(draw, (MARGIN, 1195), "Do not use app/desktop/public/icon.png. It is a legacy cyan-and-yellow asset, not the current NeuralNote identity.", size=23, colour="#8B3F45", weight=500, max_width=1580)
    return image


def product_family_page() -> Image.Image:
    image, draw = page_base("Product family", 11)
    page_title(draw, "A product family, not a feature list.", "The roadmap extends NeuralNote into new surfaces without promising dates or presenting planned products as shipped.")
    items = [
        ("01", "NeuralNote Desktop", "Foundation", "Local-first product home"),
        ("02", "NeuralNote API Server", "Planned", "Reusable service layer"),
        ("03", "NeuralNote Cloud App", "Planned", "Hosted NeuralNote experience"),
        ("04", "NeuralNote CLI", "Planned", "Automation and direct workflows"),
    ]
    y = 400
    for number, title, status, note in items:
        draw.rounded_rectangle((MARGIN, y, PAGE_W - MARGIN, y + 150), radius=26, fill=rgb("#252428"), outline=rgb(BORDER), width=2)
        draw_text(draw, (MARGIN + 34, y + 35), number, size=22, colour=VIOLET, weight=650, kind="mono")
        draw_text(draw, (MARGIN + 135, y + 30), title, size=38, colour=SOFT_WHITE, weight=540)
        draw_text(draw, (MARGIN + 965, y + 41), status.upper(), size=18, colour="#CEB3F5", weight=650, kind="mono")
        draw_text(draw, (MARGIN + 1215, y + 36), note, size=23, colour=MUTED, max_width=430)
        y += 176
    voice = (MARGIN, 1110, PAGE_W - MARGIN, 1262)
    draw.rounded_rectangle(voice, radius=26, fill=rgb("#2B2433"), outline=rgb("#6A557F"), width=2)
    draw_text(draw, (MARGIN + 34, 1145), "TBC", size=21, colour="#CEB3F5", weight=650, kind="mono")
    draw_text(draw, (MARGIN + 135, 1138), "Neural Voice", size=38, colour=SOFT_WHITE, weight=540)
    draw_text(draw, (MARGIN + 620, 1152), "WhisperFlow-like voice interface for talking to AI", size=23, colour=MUTED, max_width=900)
    return image


def roadmap_page(roadmap: Path) -> Image.Image:
    image, draw = page_base("Roadmap artwork", 12)
    roadmap_image = Image.open(roadmap).convert("RGBA")
    paste_contain(image, roadmap_image, (MARGIN, 140, PAGE_W - MARGIN, 1235))
    draw_text(draw, (MARGIN, 1252), "Standalone artwork supplied at 3840 x 2160 pixels.", size=19, colour=MUTED, kind="mono")
    return image


def build_pages(roadmap: Path) -> list[Image.Image]:
    return [
        cover_page(),
        approved_system_page(),
        brand_core_page(),
        logo_system_page(),
        palette_page(),
        typography_page(),
        product_expression_page(),
        visual_language_page(),
        applications_page(),
        asset_library_page(),
        product_family_page(),
        roadmap_page(roadmap),
    ]


def build_pdf(output: Path, page_directory: Path, roadmap: Path) -> None:
    page_directory.mkdir(parents=True, exist_ok=True)
    pages = build_pages(roadmap)
    page_paths: list[Path] = []
    for index, page in enumerate(pages, start=1):
        path = page_directory / f"neuralnote-brand-pack-{index:02d}.png"
        page.convert("RGB").save(path, quality=95, optimize=True)
        page_paths.append(path)

    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A4)
    pdf = canvas.Canvas(str(output), pagesize=(width, height), pageCompression=1)
    pdf.setTitle("NeuralNote Brand Pack")
    pdf.setAuthor("NeuralNote")
    pdf.setSubject("Brand identity, visual system and product roadmap")
    for path in page_paths:
        pdf.drawImage(str(path), 0, 0, width=width, height=height, preserveAspectRatio=True, anchor="c")
        pdf.showPage()
    pdf.save()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pdf",
        type=Path,
        default=ROOT / "output" / "pdf" / "neuralnote-brand-pack.pdf",
    )
    parser.add_argument(
        "--roadmap",
        type=Path,
        default=ROOT / "output" / "brand" / "neuralnote-roadmap.png",
    )
    parser.add_argument(
        "--pages",
        type=Path,
        default=ROOT / "tmp" / "pdfs" / "neuralnote-brand-pack-pages",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_roadmap(args.roadmap)
    build_pdf(args.pdf, args.pages, args.roadmap)
    print(args.pdf)
    print(args.roadmap)


if __name__ == "__main__":
    main()
