/**
 * Step 8: --check 模式：跑全套 codegen + **内容 hash 比对** fail-fast。
 *
 * 用途：CI / pre-commit hook 校验「commit 进 git 的 generated 跟当前 zod schema
 * 重新生成出来的 generated」是否字节一致——不一致说明开发者改了 schema 但没跑
 * codegen（或反之，手改了 generated 文件）。
 *
 * **不依赖 git**（W1 P1-A 修复）：
 *   原版本基于 `git status --porcelain` 判定 dirty，但 untracked（开发者第一次
 *   跑、还没 commit 进 git）也会被报成 drift——这跟 harness 实证后判定「不
 *   合理」。改成基于内容 sha256：
 *   1. 跑前对 generated/ + 4 端 vendor 目录所有文件算 sha256，得到 before
 *   2. 跑全套 codegen（覆盖原文件）
 *   3. 重新算 hash 得到 after
 *   4. 对比：
 *      - 同 path 两边 hash 不同 → drift FAIL
 *      - before 有 after 没有（codegen 不再产出某文件）→ drift FAIL
 *      - before 没有 after 有：
 *          * 整个目录跑前都是空的（首次 fresh 状态）→ PASS（无 baseline 可比）
 *          * 否则 → drift FAIL（部分新增视为漂移）
 *
 * 这样的语义：
 *   - 开发者第一次本地跑（generated 还没 commit）→ PASS（empty baseline）
 *   - CI 上 fresh checkout（generated 已经 commit 进 git）→ 严格 hash 比对
 *   - schema 改了 generated 没改 → drift FAIL
 *   - 手改 generated 没改 schema → drift FAIL（codegen 会覆盖回 schema 对应版本）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { GENERATED_DIR, PKG_ROOT, VENDOR_PATHS } from './lib/paths.js';

console.log('═══════════════════════════════════════════════════════════════');
console.log('  @tabtin/wire-codegen — check mode (content-hash drift detect)');
console.log('═══════════════════════════════════════════════════════════════\n');

type HashMap = Map<string, string>;

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      // 忽略明显不是 codegen 产物的常见噪音
      if (e === '.DS_Store' || e === '__pycache__') continue;
      const p = resolve(cur, e);
      try {
        const s = statSync(p);
        if (s.isDirectory()) stack.push(p);
        else if (s.isFile()) out.push(p);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function snapshotHashes(roots: string[]): HashMap {
  const m: HashMap = new Map();
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      const rel = relative(PKG_ROOT, file);
      const buf = readFileSync(file);
      const h = createHash('sha256').update(buf).digest('hex');
      m.set(rel, h);
    }
  }
  return m;
}

const watchedRoots = [GENERATED_DIR, ...Object.values(VENDOR_PATHS)];

console.log('▶ 第 1 步：snapshot 跑前 hash...');
const before = snapshotHashes(watchedRoots);
console.log(`  ${before.size} 个文件被监控`);

console.log('\n▶ 第 2 步：跑全套 codegen pipeline...');
const codegenResult = spawnSync(
  'npx',
  ['tsx', resolve(PKG_ROOT, 'scripts', '00_codegen_all.ts')],
  {
    stdio: 'inherit',
    cwd: PKG_ROOT,
  },
);
if (codegenResult.status !== 0) {
  console.error('\n✘ codegen 跑失败。');
  process.exit(1);
}

console.log('\n▶ 第 3 步：snapshot 跑后 hash + 比对...');
const after = snapshotHashes(watchedRoots);
console.log(`  ${after.size} 个文件被监控`);

const allKeys = new Set<string>([...before.keys(), ...after.keys()]);
const drift: string[] = [];
const newOnly: string[] = [];
const removedOnly: string[] = [];

for (const key of allKeys) {
  const b = before.get(key);
  const a = after.get(key);
  if (b && a && b !== a) {
    drift.push(`${key}: hash ${b.slice(0, 8)} → ${a.slice(0, 8)}`);
  } else if (b && !a) {
    removedOnly.push(key);
  } else if (!b && a) {
    newOnly.push(key);
  }
}

// 「整个目录跑前是空」豁免：如果 before 完全空（首次本地跑），PASS。
const isFreshLocal = before.size === 0;
let totalIssues = drift.length + removedOnly.length;
if (!isFreshLocal) {
  totalIssues += newOnly.length;
}

if (totalIssues === 0) {
  if (isFreshLocal && newOnly.length > 0) {
    console.log(
      `\n  (检测到 ${newOnly.length} 个新文件——首次本地跑（empty baseline），视为 PASS)`,
    );
  }
  console.log(`
═══════════════════════════════════════════════════════════════
  ✔ All clean. Generated 与 zod schema 一致（hash 对齐）。
═══════════════════════════════════════════════════════════════`);
  process.exit(0);
}

console.error('\n✘ Schema → generated 漂移检测：\n');
if (drift.length) {
  console.error(`  ${drift.length} 个文件内容变化：`);
  for (const d of drift.slice(0, 10)) console.error(`    - ${d}`);
  if (drift.length > 10) console.error(`    ... +${drift.length - 10} more`);
}
if (removedOnly.length) {
  console.error(`\n  ${removedOnly.length} 个文件 codegen 不再生成（残留）：`);
  for (const r of removedOnly.slice(0, 10)) console.error(`    - ${r}`);
  if (removedOnly.length > 10) console.error(`    ... +${removedOnly.length - 10} more`);
}
if (!isFreshLocal && newOnly.length) {
  console.error(`\n  ${newOnly.length} 个文件 codegen 新增但 baseline 没有：`);
  for (const n of newOnly.slice(0, 10)) console.error(`    - ${n}`);
  if (newOnly.length > 10) console.error(`    ... +${newOnly.length - 10} more`);
}

console.error(`
═══════════════════════════════════════════════════════════════
  ✘ Schema → generated 漂移：请跑 \`pnpm --filter @tabtin/wire-codegen codegen\`
    重新生成后 commit。判定基于内容 hash，不依赖 git status。
═══════════════════════════════════════════════════════════════`);
process.exit(1);
