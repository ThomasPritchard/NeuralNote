// WCAG contrast, measured in the browser tier by PAINTING the stack rather than
// by parsing it.
//
// The temptation is to read `getComputedStyle(el).color`, parse the numbers and
// do the arithmetic. That is how this measurement gets faked in both directions:
// a Tailwind alpha modifier (`text-foreground/80`) resolves to
// `color-mix(in oklab, …)`, and the computed value comes back as an `oklab()`
// string whose components are 0–1 — read as 0–255 that is a wildly wrong ratio.
// Letting the engine parse the colour and composite the alpha removes the whole
// class of error: whatever a browser can paint, a canvas can sample.
//
// Browser tier only (`*.browser.test.tsx`). jsdom has no canvas and no computed
// colours worth reading.

import { expect } from "vitest";

/** One sRGB channel, linearised for WCAG's relative-luminance formula. */
function linearise(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(pixel: Uint8ClampedArray): number {
  const [r, g, b] = pixel;
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** The contrast ratio between one element's text colour and the grounds behind
 *  it, composited in paint order.
 *
 *  @param el       the element whose `color` is being measured
 *  @param backdrop what is behind it, opaque — the surface this component sits
 *                  on, since an element's own background is usually translucent
 *                  and cannot be the whole ground on its own
 */
export function contrastRatio(el: HTMLElement, backdrop: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;

  const paint = (colours: string[], x: number) => {
    for (const colour of colours) {
      ctx.fillStyle = "#ff00ff";
      ctx.fillStyle = colour;
      // A colour the canvas could not parse leaves `fillStyle` untouched, and
      // the measurement would silently be of the sentinel instead.
      expect(ctx.fillStyle).not.toBe("#ff00ff");
      ctx.fillRect(x, 0, 1, 1);
    }
  };

  const style = getComputedStyle(el);
  const grounds = [backdrop, style.backgroundColor];
  paint(grounds, 0);
  paint([...grounds, style.color], 1);

  const ground = luminance(ctx.getImageData(0, 0, 1, 1).data);
  const text = luminance(ctx.getImageData(1, 0, 1, 1).data);
  const [light, dark] = text > ground ? [text, ground] : [ground, text];
  return (light + 0.05) / (dark + 0.05);
}
