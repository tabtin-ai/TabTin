#!/usr/bin/env node
/**
 * copy-static-assets.mjs — 跨平台替代 rsync 拷静态资源。
 *
 * 把 <srcDir> 下匹配指定扩展名的文件（默认 css）按目录结构原样拷到 <distDir>。
 * 背景：tabslide / tabwhiteboard 用 `import './x.css'` 且 package.json 标了
 *   `sideEffects: ["**\/*.css"]`，但 tsc 只编译 TS、不会把 css 落进 dist，
 *   原 build 脚本靠 `rsync -a --include='*\/' --include='*.css' --exclude='*' src/ dist/`
 *   把 css 拷过去——rsync 在 Windows 上不存在，故改用本脚本（语义等价）。
 *
 * 用法：node scripts/shared/copy-static-assets.mjs <srcDir> <distDir> [ext1,ext2,...]
 *   默认扩展名：css
 *   路径相对各包自身 cwd（pnpm --filter 会切到包目录再跑 build）。
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , srcArg, distArg, extArg] = process.argv;
if (!srcArg || !distArg) {
  console.error('用法: node copy-static-assets.mjs <srcDir> <distDir> [ext1,ext2,...]');
  process.exit(1);
}

const srcDir = path.resolve(srcArg);
const distDir = path.resolve(distArg);
const exts = (extArg ?? 'css')
  .split(',')
  .map((e) => e.trim().replace(/^\./, '').toLowerCase())
  .filter(Boolean);

// 源不存在直接静默成功，与 rsync 空源、不报错的行为一致。
if (!fs.existsSync(srcDir)) process.exit(0);

let copied = 0;
const stack = [srcDir];
while (stack.length) {
  const cur = stack.pop();
  let entries;
  try {
    entries = fs.readdirSync(cur, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    const full = path.join(cur, e.name);
    if (e.isDirectory()) {
      stack.push(full);
      continue;
    }
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (!exts.includes(ext)) continue;
    const rel = path.relative(srcDir, full);
    const target = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(full, target);
    copied++;
  }
}

console.log(
  `[copy-static-assets] 拷贝 ${copied} 个文件 [${exts.join(',')}]：` +
    `${path.relative(process.cwd(), srcDir)} → ${path.relative(process.cwd(), distDir)}`
);
