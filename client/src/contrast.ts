// Contrast helpers for drawing text on per-user assignment colors.
//
// Shift chips put text on a user's color. The default palette
// (server/index.ts) is already AAA with the near-black chip ink, but a user
// could carry any legacy/custom color. `safeBg` guarantees AAA regardless: it
// keeps the color's hue but lightens it (in HLS space) only as far as needed so
// near-black text clears WCAG AAA (7:1). Already-light colors pass untouched.

export const CHIP_INK = '#111827'; // near-black; the constant chip text color

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};
const rgbToHex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const L1 = lum(a), L2 = lum(b); const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
};

const rgbToHsl = ([r, g, b]: [number, number, number]): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2; const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
};
const hslToRgb = ([h, s, l]: [number, number, number]): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
};

const INK_RGB = hexToRgb(CHIP_INK);

// A background that keeps `hex`'s hue but is light enough for CHIP_INK text to
// meet AAA (7:1). No-op when the color already clears it.
export function safeBg(hex: string): string {
  let rgb = hexToRgb(hex);
  if (contrast(rgb, INK_RGB) >= 7) return hex;
  const [h, s, l0] = rgbToHsl(rgb);
  let l = l0;
  for (let i = 0; i < 50 && contrast(rgb, INK_RGB) < 7; i++) {
    l = Math.min(1, l + 0.02);
    rgb = hslToRgb([h, s, l]);
  }
  return rgbToHex(rgb);
}
