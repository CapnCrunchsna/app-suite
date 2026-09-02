/**
 * Generate an app's icon — `icon.svg` and `favicon.ico` — from one definition.
 *
 *     node tools/make-app-icon.mjs ledgerline-ui
 *
 * ## Why a generator and not two hand-drawn files
 *
 * An SVG and an ICO of the same mark drift the moment either is edited alone,
 * and the drift is invisible: the tab shows one, the page shows the other, and
 * nobody looks at a 16px square closely enough to notice. So the shape is
 * declared once, below, and both files are emitted from it. Editing the icon
 * means editing `ICONS` and re-running this.
 *
 * ## Why the ICO is rasterized here rather than by a library
 *
 * Nothing in this repo rasterizes SVG, and adding a headless browser or a native
 * canvas to draw a 32×32 square is a dependency with a lifetime attached to it.
 * Every mark here is axis-aligned rectangles with a rounded outer plate, which is
 * a few lines to fill directly — supersampled 4× and box-filtered down, so the
 * corners and edges are antialiased rather than stepped. PNG encoding is
 * `zlib.deflateSync`, which Node has; ICO is a header and a directory around the
 * PNGs, which Vista and later accept as-is.
 *
 * ## The convention this establishes
 *
 * Every app in this workspace gets: `apps/<app>/public/icon.svg` linked from
 * `index.html` as `type="image/svg+xml"`, and `apps/<app>/public/favicon.ico`
 * beside it for anything that will not take an SVG. Both generated, never
 * hand-edited. A new app adds an entry to `ICONS` and runs this once.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each icon is drawn on a 64×64 grid.
 *
 * `plate` is the rounded background square; `bars` are drawn over it in order.
 * Coordinates are [x, y, width, height], radius is in the same grid units.
 */
const ICONS = {
  /**
   * Ledgerline: ruled ledger paper with one line called out.
   *
   * The mark has to survive 16px in a browser tab, which rules out a trend line
   * (three segments of a 1px stroke turn to mush) and rules out type. Horizontal
   * bars of different lengths behind a vertical column rule stay legible all the
   * way down — at 16px it reads as a dark tile with a green stripe across it,
   * which is enough to find in a row of tabs.
   *
   * The colours are `LEDGERLINE_THEME.dark`: the ink navy ground, the green
   * accent, the gold `accent2` for the column rule. The dark half rather than the
   * light one because a favicon sits on browser chrome, not on the app's own
   * paper, and the ink square holds its shape against either.
   */
  'ledgerline-ui': {
    background: '#0b1220',
    radius: 12,
    /**
     * Sized off the 16px case, not the 128px one.
     *
     * At 16px a grid unit is a quarter of a pixel, so anything under 4 units
     * thick is drawn in greys and disappears. A first version had 3-unit stubs
     * left of the rule and 4-unit bars: legible from 32px up, mud at 16. These
     * are 7 units (1.75px at 16) with 6 units of gap, which is the smallest that
     * still resolves as three separate entries in a browser tab.
     */
    bars: [
      // The column rule — a ledger's vertical divider, in gold.
      { rect: [13, 12, 5, 40], fill: '#d9ae4a' },
      // Three entries. Two dim, and the one that matters in the accent green.
      { rect: [24, 15, 28, 7], fill: '#94a6c2' },
      { rect: [24, 28, 20, 7], fill: '#94a6c2' },
      { rect: [24, 41, 31, 7], fill: '#46d492' },
    ],
  },
};

const GRID = 64;
/** ICO sizes. 16 and 32 are what browsers ask for; 48 is what Windows shows on a
 *  pinned shortcut, and costs about a kilobyte. */
const ICO_SIZES = [16, 32, 48];
/** Supersampling factor for the rasterizer. 4× is the point where the rounded
 *  corners stop being visibly stepped at 16px. */
const SS = 4;

// ----------------------------------------------------------------- SVG ---

function toSvg(icon) {
  const bars = icon.bars
    .map(({ rect: [x, y, w, h], fill }) => {
      // Bar corners are rounded by a third of their thickness: enough to look
      // drawn rather than clipped, small enough to vanish at 16px.
      const r = Math.min(w, h) / 3;
      return `  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${round(r)}" fill="${fill}"/>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" role="img" aria-label="Ledgerline">
  <rect width="${GRID}" height="${GRID}" rx="${icon.radius}" fill="${icon.background}"/>
${bars}
</svg>
`;
}

function round(value) {
  return Number(value.toFixed(2));
}

// ---------------------------------------------------------- rasterizer ---

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Is (x, y) inside a rounded rectangle? Grid units, sampled at pixel centres. */
function insideRounded(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  // Only the four corner boxes can be outside; everything else is in.
  const cx = x < rx + r ? rx + r : x > rx + w - r ? rx + w - r : x;
  const cy = y < ry + r ? ry + r : y > ry + h - r ? ry + h - r : y;
  if (cx === x && cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** RGBA pixel buffer at `size`, supersampled and box-filtered. */
function rasterize(icon, size) {
  const big = size * SS;
  // Accumulate at the supersampled resolution, then average SS×SS blocks. The
  // ground is transparent outside the plate, so the rounded corners composite
  // correctly onto whatever the browser puts behind them.
  const acc = new Float64Array(big * big * 4);
  const bg = hexToRgb(icon.background);
  const scale = GRID / big;

  const shapes = [
    { rect: [0, 0, GRID, GRID], r: icon.radius, rgb: bg },
    ...icon.bars.map(({ rect, fill }) => ({
      rect,
      r: Math.min(rect[2], rect[3]) / 3,
      rgb: hexToRgb(fill),
    })),
  ];

  for (let py = 0; py < big; py += 1) {
    for (let px = 0; px < big; px += 1) {
      const gx = (px + 0.5) * scale;
      const gy = (py + 0.5) * scale;
      let hit = null;
      // Painter's algorithm: last shape covering the point wins. Every shape here
      // is opaque, so there is nothing to blend at this stage.
      for (const shape of shapes) {
        const [x, y, w, h] = shape.rect;
        if (insideRounded(gx, gy, x, y, w, h, shape.r)) hit = shape.rgb;
      }
      const i = (py * big + px) * 4;
      if (hit) {
        acc[i] = hit[0];
        acc[i + 1] = hit[1];
        acc[i + 2] = hit[2];
        acc[i + 3] = 255;
      }
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const alpha = acc[i + 3] / 255;
          // Weight colour by coverage so a half-covered edge pixel does not pull
          // the average towards black through its transparent half.
          r += acc[i] * alpha;
          g += acc[i + 1] * alpha;
          b += acc[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

// ----------------------------------------------------------------- PNG ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGBA PNG, filter type 0 on every row. The images are tiny and the
 *  adaptive filters would save bytes nobody is counting. */
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- ICO ---

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 256 is written as 0 in an ICO directory; nothing here reaches it, but the
    // rule is why the field is a byte.
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

// ---------------------------------------------------------------- main ---

const app = process.argv[2];
if (!app) {
  console.error('usage: node tools/make-app-icon.mjs <app>');
  console.error(`known: ${Object.keys(ICONS).join(', ')}`);
  process.exit(1);
}

const icon = ICONS[app];
if (!icon) {
  console.error(`no icon defined for "${app}". Add one to ICONS in this file.`);
  process.exit(1);
}

const outDir = join(repoRoot, 'apps', app, 'public');
mkdirSync(outDir, { recursive: true });

const svg = toSvg(icon);
writeFileSync(join(outDir, 'icon.svg'), svg);

const ico = encodeIco(
  ICO_SIZES.map((size) => ({ size, png: encodePng(rasterize(icon, size), size) })),
);
writeFileSync(join(outDir, 'favicon.ico'), ico);

console.log(`${app}: icon.svg (${svg.length} B), favicon.ico (${ico.length} B, ${ICO_SIZES.join('/')}px)`);
