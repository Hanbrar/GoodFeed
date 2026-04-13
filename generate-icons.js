/**
 * generate-icons.js
 * Generates icon16.png, icon48.png, icon128.png inside good-feed/icons/
 * Run once: node generate-icons.js
 * No external dependencies — uses only Node built-ins (zlib, fs, path).
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC-32 ────────────────────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────────────────────
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.alloc(4);
  const crcVal    = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

// ── Create a solid-colour square PNG ─────────────────────────────────────────
function makePNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 2; // colour type: RGB truecolour
  ihdrData[10] = 0; // compression: deflate
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace: none

  // Raw image data: filter byte (None = 0) + RGB pixels per row
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const base = y * (1 + size * 3);
    raw[base] = 0; // filter type: None
    for (let x = 0; x < size; x++) {
      const off = base + 1 + x * 3;

      // Draw a filled circle with a white "G" letter feel:
      // Outer pixels → background, inner circle → accent colour
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const radius = size * 0.42;

      if (dist <= radius) {
        raw[off]     = r;
        raw[off + 1] = g;
        raw[off + 2] = b;
      } else {
        // Transparent-ish background — use a very dark colour
        raw[off]     = 15;
        raw[off + 1] = 15;
        raw[off + 2] = 15;
      }
    }
  }

  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, chunk('IHDR', ihdrData), idat, iend]);
}

// ── Write icons ───────────────────────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'good-feed', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

// X blue: #1d9bf0  →  rgb(29, 155, 240)
const [R, G, B] = [29, 155, 240];

for (const size of [16, 48, 128]) {
  const buf  = makePNG(size, R, G, B);
  const dest = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, buf);
  console.log(`✓  icon${size}.png  (${buf.length} bytes)`);
}

console.log('\nIcons written to good-feed/icons/');
