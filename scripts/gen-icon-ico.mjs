// 生成正式应用图标 resources/icon.ico（经典 BMP 条目，NSIS/Windows 全兼容）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeBmp(size, draw) {
  // RGBA 画布（自上而下）
  const px = new Uint8Array(size * size * 4);
  const setPx = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const fillRect = (x0, y0, x1, y1, r, g, b, a) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(x, y, r, g, b, a);
  };
  draw(setPx, fillRect);

  // BITMAPINFOHEADER(40B) + BGRA 自下而上 + AND 掩码（全 0，靠 alpha 通道）
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 高度
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y; // 自下而上
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = px[s + 2];     // B
      xor[d + 1] = px[s + 1]; // G
      xor[d + 2] = px[s];     // R
      xor[d + 3] = px[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size, 0);
  return Buffer.concat([header, xor, mask]);
}

function drawIcon(setPx, fillRect, size) {
  const r = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rx = Math.max(r - Math.min(x, size - 1 - x), 0);
      const ry = Math.max(r - Math.min(y, size - 1 - y), 0);
      let inside = true;
      if (rx > 0 && ry > 0) inside = (rx - r) ** 2 + (ry - r) ** 2 <= r * r;
      if (inside) setPx(x, y, 10, 132, 255, 255);
    }
  }
  const u = (v) => Math.round((v / 32) * size);
  fillRect(u(9), u(9), u(13), u(23), 255, 255, 255, 255);
  fillRect(u(9), u(9), u(23), u(14), 255, 255, 255, 255);
  fillRect(u(9), u(18), u(23), u(23), 255, 255, 255, 255);
}

// NSIS 3.0.4 的图标解析器只接受「单图像」ICO：只生成一张 256×256（Windows 会自动缩放）
const sizes = [256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6;
for (const size of sizes) {
  const data = makeBmp(size, (setPx, fillRect) => drawIcon(setPx, fillRect, size));
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset + 16, 12); // 数据紧跟本条 16 字节头之后
  offset += 16 + data.length;
  entries.push(e, data);
}
const ico = Buffer.concat([header, ...entries]);
fs.mkdirSync(path.join(ROOT, "resources"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "resources", "icon.ico"), ico);
console.log("✅ resources/icon.ico 已生成（单张 256×256 BMP 条目，NSIS 兼容，", ico.length, "字节）");
