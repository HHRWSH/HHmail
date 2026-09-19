// 断点续传把 Release 里的大文件拉到桌面发布目录，并逐个用 SHA256 校验。
// 背景运行：这台机器的 shell 到 GitHub release CDN 的连接不稳定，单次下载常在半途断掉，
// 所以用 --continue-at - 反复续传，直到大小与 Release 上的资产完全一致，再算哈希比对 SHA256SUMS.txt。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
const REPO = "HHRWSH/HHmail";
const TAG = "v1.0.0";
const DEST_BASE = path.join(os.homedir(), "Desktop", "mail_ai", "HHmail 1.0.0");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

function assetId(name) {
  const out = run("gh", ["api", `repos/${REPO}/releases/tags/${TAG}`, "--jq",
    `.assets[]|select(.name=="${name}")|"${""}" + (.id|tostring) + " " + (.size|tostring)`], { cwd: ROOT });
  const [id, size] = (out.stdout || "").trim().split(/\s+/);
  return { id, size: Number(size) };
}

const files = [
  ["HHmail-1.0.0-arm64.dmg", "macOS"],
  ["HHmail-1.0.0-arm64.zip", "macOS"],
  ["HHmail-1.0.0-x64.dmg", "macOS"],
  ["HHmail-1.0.0-x64.zip", "macOS"],
  ["HHmail-1.0.0.exe", "Windows"],
  ["HHmail-Setup-1.0.0.exe", "Windows"]
];

const token = run("gh", ["auth", "token"], { cwd: ROOT }).stdout.trim();
const report = [];

for (const [name, folder] of files) {
  const { id, size: want } = assetId(name);
  const dir = path.join(DEST_BASE, folder);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  // 尺寸已知：如果本地文件比目标大（续传过别的版本），先删掉重下
  if (fs.existsSync(out) && fs.statSync(out).size > want) fs.rmSync(out, { force: true });
  let ok = fs.existsSync(out) && fs.statSync(out).size === want;
  for (let attempt = 1; attempt <= 40 && !ok; attempt += 1) {
    run("curl", ["-sSL", "-C", "-", "--retry", "2", "--retry-all-errors",
      "-H", `Authorization: token ${token}`, "-H", "Accept: application/octet-stream",
      `https://api.github.com/repos/${REPO}/releases/assets/${id}`, "-o", out], { cwd: ROOT, timeout: 600000 });
    const have = fs.existsSync(out) ? fs.statSync(out).size : 0;
    ok = have === want;
    console.log(`${name}: 第 ${attempt} 次 → ${(have / 1048576).toFixed(1)}MB / ${(want / 1048576).toFixed(1)}MB${ok ? " ✅" : ""}`);
  }
  report.push({ name, ok, size: fs.existsSync(out) ? fs.statSync(out).size : 0, want });
}

// 用 Release 上的 SHA256SUMS.txt 校验
const sumsPath = path.join(DEST_BASE, "SHA256SUMS.txt");
if (!fs.existsSync(sumsPath)) {
  run("gh", ["release", "download", TAG, "-R", REPO, "-p", "SHA256SUMS.txt", "-D", DEST_BASE, "--clobber"], { cwd: ROOT });
}
const sums = fs.existsSync(sumsPath)
  ? Object.fromEntries(fs.readFileSync(sumsPath, "utf8").split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/).reverse()))
  : {};

const lines = ["=== 下载与校验结果 ==="];
let allOk = true;
for (const r of report) {
  const folder = files.find(([n]) => n === r.name)[1];
  const p = path.join(DEST_BASE, folder, r.name);
  let hash = "";
  if (fs.existsSync(p) && r.ok) {
    hash = run("node", ["-e", `
      const fs=require('fs'),c=require('crypto');
      const h=c.createHash('sha256');const s=fs.createReadStream(process.argv[1]);
      s.on('data',d=>h.update(d));s.on('end',()=>console.log(h.digest('hex')));`, p]).stdout.trim();
  }
  const expect = sums[r.name];
  const good = r.ok && hash && expect && hash === expect;
  allOk = allOk && Boolean(good);
  lines.push(`${good ? "[一致]" : "[问题]"} ${folder}/${r.name} ${r.ok ? (r.size / 1048576).toFixed(1) + "MB" : `不完整 ${(r.size / 1048576).toFixed(1)}MB`}${hash && expect ? (hash === expect ? " 哈希一致" : " 哈希不一致") : ""}`);
}
lines.push(allOk ? "全部下载并校验通过 ✔" : "仍有文件未完成（可稍后再试）");
fs.writeFileSync(path.join(DEST_BASE, "下载校验结果.txt"), lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
