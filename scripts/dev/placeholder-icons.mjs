#!/usr/bin/env node
// Writes the neutral placeholder icons the console links: a solid dark-grey square (rounded in the SVGs). Uses only
// built-in modules; the PNG deflate stream comes from node:zlib. Re-run it to restore the files:
//
//   node scripts/dev/placeholder-icons.mjs
//
// Replace the output with your own artwork by overwriting the same file names at the same pixel sizes.
//   public/app/icons/        icon-192, icon-512, icon-maskable-512, apple-touch-icon (180), badge-96  (PWA manifest, push)
//   public/shared/brand/     favicon.svg, favicon-24.svg, favicon.ico (16/24/32 PNG frames), icon-24.png  (page <head>)
// The mark and lockup drawn inside the console are SVG symbols in public/app/index.html (#oc-mark, #oc-lockup).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GREY = [0x2b, 0x2d, 0x33];
const GREY_HEX = "#2B2D33";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A size x size solid PNG. `alpha` writes RGBA (colour type 6), otherwise opaque RGB (colour type 2). */
function png(size, alpha) {
  const channels = alpha ? 4 : 3;
  const row = Buffer.alloc(1 + size * channels); // filter byte 0 (none), then the pixels
  for (let x = 0; x < size; x++) {
    row.set(GREY, 1 + x * channels);
    if (alpha) row[1 + x * channels + 3] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** An .ico holding PNG frames (supported since Windows Vista and by every browser). */
function ico(sizes) {
  const frames = sizes.map((s) => png(s, true));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = frames.map((frame, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = sizes[i] % 256;
    entry[1] = sizes[i] % 256;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += frame.length;
    return entry;
  });
  return Buffer.concat([head, ...dir, ...frames]);
}
const svg = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${Math.round(size / 5)}" fill="${GREY_HEX}"/></svg>\n`;

const files = {
  "public/app/icons/icon-192.png": png(192, true),
  "public/app/icons/icon-512.png": png(512, true),
  "public/app/icons/icon-maskable-512.png": png(512, false),
  "public/app/icons/apple-touch-icon.png": png(180, false),
  "public/app/icons/badge-96.png": png(96, true),
  "public/shared/brand/icon-24.png": png(24, true),
  "public/shared/brand/favicon.ico": ico([16, 24, 32]),
  "public/shared/brand/favicon.svg": svg(16),
  "public/shared/brand/favicon-24.svg": svg(24),
};
for (const [rel, data] of Object.entries(files)) {
  const file = resolve(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
}
