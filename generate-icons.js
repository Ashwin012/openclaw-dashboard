#!/usr/bin/env node
// Generates simple solid-color PNG icons for the PWA manifest
// Color: #89b4fa (Catppuccin blue) — matches the accent color of the dashboard

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  // compression, filter, interlace = 0

  // Raw scanlines: filter_byte(0) + RGB per pixel
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // filter: none
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array(size).fill(row));
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// #89b4fa = rgb(137, 180, 250)
const outDir = path.join(__dirname, 'public');

fs.writeFileSync(path.join(outDir, 'icon-192.png'), makePNG(192, 137, 180, 250));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makePNG(512, 137, 180, 250));

console.log('Icons generated: icon-192.png and icon-512.png');
