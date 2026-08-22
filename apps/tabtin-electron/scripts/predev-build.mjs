#!/usr/bin/env node
/**
 * predev-build.mjs — 从真实 workspace 依赖图按拓扑序构建 tabtin-electron 的全部依赖包。
 *
 * 取代旧的 predev-build.sh 手写 layer 拓扑表。构建顺序由各包 package.json 的
 * workspace:* 依赖实时算出（dependencies + peerDependencies + devDependencies +
 * optionalDependencies），与 CI 用的 `pnpm --filter "tabtin-electron^..." build`
 * 同一套依赖图——**永不与真实依赖漂移**，因此不再需要单独的拓扑 guard。
 *
 * 为什么不直接用 `pnpm --filter "tabtin-electron^..." build`（CI 就是这么干的）：
 *   本地 predev 比那条纯构建多需要三件 CI 故意不要的东西，本脚本一并保留：
 *     1) 增量跳过：dist 已最新的包不重 build——warm restart 才能秒级，而 tsc/tsup/vite
 *        都不是便宜的增量构建，裸 `^... build` 每次 `pnpm dev` 都会全量重建 63 个包。
 *     2) Go CLI 构建：packages/tabtin-cli-go/dist/tabtin(.exe)（不是 npm 包，`^...` 覆盖不到，
 *        但生产 `tabtin` 命令就指向它，必须跟 workspace 产物一起对齐）。
 *     3) workspace 构建锁：由 scripts/electron/run-predev-build-with-lock.mjs 持有，避免与
 *        tabtin-web 的 table 构建并行写 dist 导致竞态与虚假 TS 错误。
 *
 * 用法:
 *   node predev-build.mjs            # 增量构建（跳过 dist 已最新的包）
 *   node predev-build.mjs --force    # 强制全量构建
 *   node predev-build.mjs --check    # 只校验依赖图能拓扑排序（无环、包可定位），不构建——挂在 deps:check
 *   node predev-build.mjs --seed collab-live
 *     # 换种子：只建该包的 workspace 依赖闭包（不含种子自身）。
 *     # 非 tabtin-electron 种子会跳过 Go CLI。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_SEED_PKG = 'tabtin-electron'; // 默认闭包种子：electron 自身（其 package.json 的 name）
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'];
const STRICT_FIELDS = ['dependencies', 'peerDependencies']; // 解环时回退用的「必须先于」边
function runtimeCommandExists(command, platform = process.platform) {
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore' }).status === 0;
}

function resolvePnpmInvocation({
  platform = process.platform,
  comSpec = process.env.ComSpec ?? 'cmd.exe',
  commandExists = (command) => runtimeCommandExists(command, platform),
} = {}) {
  const useCorepack = !commandExists('pnpm') && commandExists('corepack');
  const command = useCorepack ? 'corepack' : 'pnpm';
  const args = useCorepack ? ['pnpm'] : [];

  if (platform === 'win32') {
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', command, ...args],
      usesCorepack: useCorepack,
    };
  }

  return { command, args, usesCorepack: useCorepack };
}

const PNPM = resolvePnpmInvocation();

function createPnpmBuildEnvironment({
  invocation = PNPM,
  platform = process.platform,
  env = process.env,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (!invocation.usesCorepack) {
    return { env, cleanup() {} };
  }

  const shimDir = fs.mkdtempSync(path.join(temporaryRoot, 'tabtin-pnpm-'));
  const isWindows = platform === 'win32';
  const shimName = isWindows ? 'pnpm.cmd' : 'pnpm';
  const shimContents = isWindows
    ? '@echo off\r\ncorepack pnpm %*\r\n'
    : '#!/bin/sh\nexec corepack pnpm "$@"\n';
  fs.writeFileSync(path.join(shimDir, shimName), shimContents, {
    encoding: 'utf8',
    mode: isWindows ? undefined : 0o755,
  });

  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const delimiter = isWindows ? ';' : ':';
  const inheritedPath = env[pathKey];

  return {
    env: {
      ...env,
      [pathKey]: inheritedPath
        ? `${shimDir}${delimiter}${inheritedPath}`
        : shimDir,
    },
    cleanup() {
      fs.rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const CHECK_ONLY = argv.includes('--check');

function parseSeedPkg(args = argv) {
  const index = args.indexOf('--seed');
  if (index === -1) return DEFAULT_SEED_PKG;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('[predev-build] --seed 需要包名，例如 --seed collab-live');
  }
  return value;
}

// 并发上限：单层内最多同时 build 多少个包。旧 bash 的 Layer 0 本就 ~20 个并行无 OOM；
// 这里设上限是为了防自动闭包凑出超大层时把 tsc/vite 进程数顶爆内存。
const CONCURRENCY = Math.max(4, os.cpus().length);

function normalizeBuildTarget(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'mac' || normalized === 'darwin') return 'darwin';
  if (normalized === 'win' || normalized === 'windows' || normalized === 'win32') return 'windows';
  if (normalized === 'linux') return 'linux';
  return '';
}

function normalizeBuildArch(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'amd64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return '';
}

function goBuildTargetEnv() {
  const goos = normalizeBuildTarget(process.env.TABTIN_BUILD_TARGET);
  const goarch = normalizeBuildArch(process.env.TABTIN_BUILD_ARCH);
  if (!goos || !goarch) return {};
  return { GOOS: goos, GOARCH: goarch };
}

function goBinaryBuildSetting(binary, key) {
  const r = spawnSync('go', ['version', '-m', binary], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if ((r.status ?? 1) !== 0) return undefined;
  const prefix = `\tbuild\t${key}=`;
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    ?.trim();
}

// ─────────────────────────────────────────────────────────────────────────
// workspace 发现 + 依赖图
// ─────────────────────────────────────────────────────────────────────────

function readManifest(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 扫描 packages/* 与 apps/* 建 name → 绝对目录 / name → manifest 映射 */
function discoverWorkspace() {
  const nameToDir = new Map();
  const nameToManifest = new Map();
  for (const base of ['packages', 'apps']) {
    const baseDir = path.join(ROOT, base);
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir)) {
      const pj = path.join(baseDir, entry, 'package.json');
      if (!fs.existsSync(pj)) continue;
      let m;
      try {
        m = readManifest(pj);
      } catch {
        continue;
      }
      if (m.name) {
        nameToDir.set(m.name, path.join(baseDir, entry));
        nameToManifest.set(m.name, m);
      }
    }
  }
  return { nameToDir, nameToManifest };
}

/** 取 manifest 在指定字段里的 @tabtin/* workspace:* 依赖 */
function workspaceDepsOf(manifest, fields) {
  const out = [];
  if (!manifest) return out; // 防幻影依赖（声明了 workspace:* 但包不存在）导致后续崩溃
  for (const field of fields) {
    const block = manifest[field];
    if (!block) continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:') && name.startsWith('@tabtin/')) {
        out.push(name);
      }
    }
  }
  return out;
}

/** 从 seed 出发、顺着全字段 workspace 依赖递归求闭包（要 build 哪些包） */
function computeClosure(seedManifest, nameToManifest) {
  const closure = new Set();
  const queue = workspaceDepsOf(seedManifest, DEP_FIELDS);
  while (queue.length) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const m = nameToManifest.get(name);
    if (!m) continue;
    for (const dep of workspaceDepsOf(m, DEP_FIELDS)) {
      if (!closure.has(dep)) queue.push(dep);
    }
  }
  return closure;
}

/**
 * Kahn 分层拓扑排序。返回 { levels, stuck }：
 *   levels[i] = 该层包名数组，其全部依赖都在更早的层；
 *   stuck     = 因成环排不进任何层的包（正常为空）。
 * edgesOf(name) 给出该包在 `names` 集合内的依赖。
 */
function topoLevels(names, edgesOf) {
  const inSet = new Set(names);
  const indeg = new Map();
  const dependents = new Map(); // dep -> [依赖它的包]
  for (const n of names) {
    indeg.set(n, 0);
    dependents.set(n, []);
  }
  for (const n of names) {
    for (const d of edgesOf(n)) {
      if (!inSet.has(d) || d === n) continue;
      dependents.get(d).push(n);
      indeg.set(n, indeg.get(n) + 1);
    }
  }
  const levels = [];
  const placed = new Set();
  let frontier = names.filter((n) => indeg.get(n) === 0).sort();
  while (frontier.length) {
    levels.push(frontier);
    for (const n of frontier) placed.add(n);
    const next = [];
    for (const n of frontier) {
      for (const m of dependents.get(n)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    frontier = next.sort();
  }
  return { levels, stuck: names.filter((n) => !placed.has(n)) };
}

/**
 * 算出构建分层。优先用全字段边（dev/optional 也尊重，给出最严格安全的顺序）；
 * 若全字段成环，退回只用 dependencies+peerDependencies（必须先于的硬边）并告警；
 * 若硬边仍成环，那是真正的循环依赖——抛错列出环上的包。
 */
function planLevels(closureNames, depMapFull, depMapStrict) {
  const full = topoLevels(closureNames, (n) => depMapFull.get(n) || []);
  if (full.stuck.length === 0) return full.levels;

  console.warn(
    `[predev-build] ⚠️ dev/optional 依赖中存在环（涉及 ${full.stuck.length} 个包），` +
      `回退为仅按 dependencies+peerDependencies 排序：${full.stuck.join(', ')}`
  );
  const strict = topoLevels(closureNames, (n) => depMapStrict.get(n) || []);
  if (strict.stuck.length === 0) return strict.levels;

  throw new Error(
    `[predev-build] 真实依赖（dependencies/peerDependencies）存在循环，无法拓扑排序：\n` +
      `  ${strict.stuck.join(', ')}\n` +
      `  这是架构级循环依赖，请拆环后再构建。`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 增量新鲜度检测（与旧 predev-build.sh is_fresh 等价，含同样的硬经验兜底）
// ─────────────────────────────────────────────────────────────────────────

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 递归求 dir 下所有文件的最大 mtime（dir 不存在返回 null）——等价 bash 的 find -newer */
function newestMtimeUnder(dir) {
  let max = null;
  const stack = [dir];
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
      } else {
        const m = mtimeMs(full);
        if (m != null && (max == null || m > max)) max = m;
      }
    }
  }
  return max;
}

function outputEntryPaths(dir, manifest) {
  const relPaths = new Set();
  for (const field of ['main', 'module', 'types']) {
    const value = manifest?.[field];
    if (typeof value === 'string' && (value.startsWith('dist/') || value.startsWith('./dist/'))) {
      relPaths.add(value.replace(/^\.\//, ''));
    }
  }
  if (relPaths.size === 0) {
    relPaths.add(path.join('dist', 'index.js'));
    relPaths.add(path.join('dist', 'index.d.ts'));
  }
  return [...relPaths].map((relPath) => path.join(dir, relPath));
}

function outputEntryMtimes(dir, manifest) {
  return outputEntryPaths(dir, manifest).map((candidate) => ({
    path: candidate,
    mtime: mtimeMs(candidate),
  }));
}

// ── 源指纹（stat 指纹，取代易被 git rebase/切分支骗过的 mtime「更晚」判定）──
//
// 历史问题：旧实现只在「src mtime 晚于 .build-stamp」时重建。git checkout /
// rebase 切换内容后文件 mtime 不保证晚于旧 stamp（时刻先后、fs 精度、同秒），会被误判
// 「已最新」跳过，留下 stale dist，下游主进程按旧 .d.ts 编译报「属性不存在」。
//
// 现改为：把源输入的 stat 指纹写进 .build-stamp，按「与上次记录不一致即重建」判定——
// 对 mtime 倒退/相等、文件增删、size 变化都敏感；仍只 stat 不读内容，保持秒级 warm restart。

const FINGERPRINT_VERSION = 'fp-v1';
const FINGERPRINT_CONFIG_FILES = ['tsconfig.json', 'tsconfig.cjs.json', 'package.json', 'vite.config.ts', 'tsup.config.ts'];

/** 收集 dir/src 下所有文件的 (相对路径, size, mtimeMs) 签名，排序后返回 */
function collectSrcSignatures(dir) {
  const sigs = [];
  const stack = [path.join(dir, 'src')];
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
      } else {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        sigs.push(`${path.relative(dir, full)}\0${st.size}\0${st.mtimeMs}`);
      }
    }
  }
  return sigs.sort();
}

function statSignature(p) {
  try {
    const st = fs.statSync(p);
    return `${st.size}\0${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

function readStamp(stampPath) {
  try {
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 计算包的源指纹：src 文件 stat 集合 + 配置文件 stat + 上游依赖当前指纹。
 * 上游依赖指纹并入自身 → dep 重建（其 stamp 内容变化）会级联触发本包重建。
 * 依赖按拓扑序先于本包构建，故 markBuilt/isFresh 读到的 dep stamp 均为本轮最新。
 */
function computeFingerprint(name, ctx) {
  const dir = ctx.nameToDir.get(name);
  const h = crypto.createHash('sha256');
  h.update(`${FINGERPRINT_VERSION}\n`);
  h.update('--src--\n');
  for (const sig of collectSrcSignatures(dir)) h.update(`${sig}\n`);
  h.update('--config--\n');
  for (const cfg of FINGERPRINT_CONFIG_FILES) {
    h.update(`${cfg}\0${statSignature(path.join(dir, cfg))}\n`);
  }
  h.update('--deps--\n');
  for (const dep of (ctx.depMapFull.get(name) || []).slice().sort()) {
    const depDir = ctx.nameToDir.get(dep);
    if (!depDir) continue;
    h.update(`${dep}\0${readStamp(path.join(depDir, 'dist', '.build-stamp'))}\n`);
  }
  return h.digest('hex');
}

/** 该包是否 dist 已最新、可跳过 build。ctx 提供 nameToDir / depMapFull。 */
function isFresh(name, ctx) {
  const dir = ctx.nameToDir.get(name);
  if (!dir) return false;
  const manifest = ctx.nameToManifest.get(name);

  const storedFp = readStamp(path.join(dir, 'dist', '.build-stamp'));
  if (!storedFp) return false; // 没 stamp / 旧空 stamp → 没成功 build 过（或本次升级前的旧格式）

  // 关键产物存在性兜底——stamp 在、但 manifest 声明的 dist 入口缺失，说明上次 build
  // 失败、被部分清理、或 stamp 与产物落地不同步（2026-05-21 实测过：dist 整个不存在
  // 但 stamp 存活，误判 fresh → 下游 tsc 找不到类型）。
  const outputEntries = outputEntryMtimes(dir, manifest);
  if (outputEntries.some((entry) => entry.mtime == null)) {
    return false;
  }

  // 源指纹（src + 配置 + 上游依赖指纹）与上次 build 记录一致 → 可跳过。
  return computeFingerprint(name, ctx) === storedFp;
}

function markBuilt(name, ctx) {
  const dir = ctx.nameToDir.get(name);
  if (!dir) return;
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  // 写入当前源指纹作为 stamp 内容；下次以「指纹是否一致」判新鲜度。
  fs.writeFileSync(path.join(distDir, '.build-stamp'), computeFingerprint(name, ctx));
}

function hasBuildScript(name, ctx) {
  const m = ctx.nameToManifest.get(name);
  return !!(m && m.scripts && m.scripts.build);
}

// ─────────────────────────────────────────────────────────────────────────
// 构建执行
// ─────────────────────────────────────────────────────────────────────────

function shortName(name) {
  return name.replace(/^@tabtin\//, '');
}

/** 跑单个包的 build，缓冲输出；resolve { name, ok, output } */
function buildOne(name, ctx) {
  return new Promise((resolve) => {
    const child = spawn(PNPM.command, [...PNPM.args, '--filter', name, 'build'], {
      cwd: ROOT,
      env: ctx.buildEnv ?? process.env,
      shell: false,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ name, ok: false, output: `${out}\n${err.message}` }));
    child.on('close', (code) => resolve({ name, ok: code === 0, output: out }));
  });
}

/** 带并发上限地并行跑一批包 */
async function runPool(items, limit, worker) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      results[myIdx] = await worker(items[myIdx]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 构建一层：跳过 fresh / 无 build 脚本的，其余并行 build，失败即终止并打印日志 */
async function buildLevel(layerIdx, names, ctx) {
  const toBuild = [];
  const skipped = [];
  const noBuild = [];
  for (const name of names) {
    if (!hasBuildScript(name, ctx)) {
      noBuild.push(name);
      continue; // 纯类型/无产物包：pnpm 递归也会跳过它，单包 build 反而报 NO_SCRIPT
    }
    if (!FORCE && isFresh(name, ctx)) {
      skipped.push(name);
      continue;
    }
    toBuild.push(name);
  }

  const tag = `⏳ Layer ${layerIdx} (${names.length} 包)`;
  if (toBuild.length === 0) {
    const why = [];
    if (skipped.length) why.push(`${skipped.length} 个 dist 已最新`);
    if (noBuild.length) why.push(`${noBuild.length} 个无 build 脚本`);
    console.log(`${tag}: 全部跳过（${why.join('、') || '空层'}）`);
    return;
  }
  console.log(`${tag}: 构建 ${toBuild.map(shortName).join(' ')}`);
  if (skipped.length) console.log(`   ⏭  跳过（dist 已最新）: ${skipped.map(shortName).join(' ')}`);
  if (noBuild.length) console.log(`   ⏭  跳过（无 build 脚本）: ${noBuild.map(shortName).join(' ')}`);

  const results = await runPool(toBuild, CONCURRENCY, (name) => buildOne(name, ctx));

  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    if (r.ok) markBuilt(r.name, ctx);
  }
  if (failures.length) {
    for (const f of failures) {
      console.error(`\n❌ ${f.name} 构建失败:`);
      console.error(f.output);
    }
    throw new Error(`Layer ${layerIdx} 有 ${failures.length} 个包构建失败，终止`);
  }
}

// ─── Go CLI binary（packages/tabtin-cli-go/dist/tabtin[.exe]）──────────────
//
// 不是 npm workspace 包，不进依赖图拓扑（go 工具链独立）。但生产 tabtin 命令路径就是
// packages/tabtin-cli-go/dist/tabtin(.exe)（被 apps/tabtin-electron/src/main/cli/cli-server.ts
// 加进 PATH），所以必须跟其他 workspace 产物一起在 predev 阶段对齐到最新源码。
//
// 历史教训（W3 v1/v4，2026-05-04）：dist/tabtin mtime 落后源码 25 天，新增 cli flag
// 全没编译进生产 binary，LLM 调到的一直是旧版报 unknown flag。故这里带 mtime guard。
function buildGoCli() {
  const cliDir = path.join(ROOT, 'packages', 'tabtin-cli-go');
  // win32 下产物必须带 .exe：① Windows 只能把带 .exe/PATHEXT 后缀的文件当命令执行，
  // 裸 `tabtin`（无后缀）在 cmd/powershell 里就是「不是内部或外部命令」；
  // ② cli-server.ts 把 dist 加进 PATH 前会 existsSync(tabtin.exe)，名字不带 .exe 就检测不到、
  // 整个 Go CLI 都不会进 PATH。go build 对显式 `-o` 名不会自动补 .exe，必须我们自己补。
  const binaryName = process.platform === 'win32' ? 'tabtin.exe' : 'tabtin';
  const binaryRel = path.join('dist', binaryName);
  const binary = path.join(cliDir, binaryRel);
  const targetEnv = goBuildTargetEnv();
  const targetLabel = targetEnv.GOOS && targetEnv.GOARCH ? `${targetEnv.GOOS}/${targetEnv.GOARCH}` : '';
  if (!fs.existsSync(cliDir)) return;

  if (!FORCE && fs.existsSync(binary)) {
    if (targetEnv.GOOS && targetEnv.GOARCH) {
      const actualGoos = goBinaryBuildSetting(binary, 'GOOS');
      const actualGoarch = goBinaryBuildSetting(binary, 'GOARCH');
      if (actualGoos !== targetEnv.GOOS || actualGoarch !== targetEnv.GOARCH) {
        console.log(
          `  🧭 检测到 Go CLI 目标架构不匹配，重 build ${binaryRel} (${actualGoos || '?'}-${actualGoarch || '?'} → ${targetLabel})`
        );
      } else {
        const binMs = mtimeMs(binary);
        const srcMax = Math.max(
          newestMtimeUnder(path.join(cliDir, 'cmd')) ?? 0,
          newestMtimeUnder(path.join(cliDir, 'internal')) ?? 0,
          mtimeMs(path.join(cliDir, 'main.go')) ?? 0,
          mtimeMs(path.join(cliDir, 'go.mod')) ?? 0,
          mtimeMs(path.join(cliDir, 'go.sum')) ?? 0
        );
        if (binMs != null && srcMax <= binMs) {
          console.log(`  ⏭  跳过（${binaryRel} 已最新，目标 ${targetLabel}）`);
          return;
        }
        console.log(`  📝 检测到 Go 源码变更，重 build ${binaryRel} (${targetLabel})`);
      }
    } else {
    const binMs = mtimeMs(binary);
    const srcMax = Math.max(
      newestMtimeUnder(path.join(cliDir, 'cmd')) ?? 0,
      newestMtimeUnder(path.join(cliDir, 'internal')) ?? 0,
      mtimeMs(path.join(cliDir, 'main.go')) ?? 0,
      mtimeMs(path.join(cliDir, 'go.mod')) ?? 0,
      mtimeMs(path.join(cliDir, 'go.sum')) ?? 0
    );
    if (binMs != null && srcMax <= binMs) {
      console.log(`  ⏭  跳过（${binaryRel} 已最新）`);
      return;
    }
    console.log(`  📝 检测到 Go 源码变更，重 build ${binaryRel}`);
    }
  } else {
    console.log(`  🔨 build ${binaryRel}${targetLabel ? ` (${targetLabel})` : ''}`);
  }

  fs.mkdirSync(path.join(cliDir, 'dist'), { recursive: true });
  // 同步跑 go build（在所有 npm 包之后，无需并行）
  // win32 需 shell:true：非 shell 模式 Node 不按 PATHEXT 把 'go' 解析为 go.exe，会 ENOENT。
  const r = spawnSync('go', ['build', '-o', binaryRel, '.'], {
    cwd: cliDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ...targetEnv },
  });
  if ((r.status ?? 1) !== 0) {
    console.error('❌ tabtin-cli-go 构建失败:');
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`);
    process.exit(1);
  }
  console.log(`  ✅ ${binaryRel} rebuilt`);
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────

function buildContext({ seedPkg, args = argv } = {}) {
  const seed = seedPkg ?? parseSeedPkg(args);
  const { nameToDir, nameToManifest } = discoverWorkspace();
  const seedManifest = nameToManifest.get(seed);
  if (!seedManifest) {
    throw new Error(`[predev-build] 找不到种子包 ${seed} 的 package.json`);
  }
  const closure = computeClosure(seedManifest, nameToManifest);
  const closureNames = [...closure];

  // 预算每个包的依赖（全字段 / 严格字段，都收敛到闭包内）
  const depMapFull = new Map();
  const depMapStrict = new Map();
  for (const n of closureNames) {
    const m = nameToManifest.get(n);
    depMapFull.set(n, workspaceDepsOf(m, DEP_FIELDS).filter((d) => closure.has(d)));
    depMapStrict.set(n, workspaceDepsOf(m, STRICT_FIELDS).filter((d) => closure.has(d)));
  }
  const levels = planLevels(closureNames, depMapFull, depMapStrict);
  return {
    nameToDir,
    nameToManifest,
    closure,
    levels,
    depMapFull,
    seedPkg: seed,
    includeGoCli: seed === DEFAULT_SEED_PKG,
  };
}

function runCheck(ctx) {
  // 校验：每个闭包包都能在磁盘定位（discoverWorkspace 已保证有 manifest+dir）。
  const missing = [...ctx.closure].filter((n) => !ctx.nameToDir.has(n));
  if (missing.length) {
    console.error(`[predev-build][check] ❌ 闭包内有包无法在 packages/*|apps/* 定位：${missing.join(', ')}`);
    process.exit(1);
  }
  const total = ctx.closure.size;
  const built = levelsFlat(ctx.levels).length;
  if (built !== total) {
    console.error(`[predev-build][check] ❌ 拓扑层覆盖 ${built} 个包，与闭包 ${total} 个不符（疑成环漏排）。`);
    process.exit(1);
  }
  console.log(
    `[predev-build][check] ✅ ${ctx.seedPkg} 依赖闭包 ${total} 个包，` +
      `可无环拓扑排序为 ${ctx.levels.length} 层（每层 ${ctx.levels.map((l) => l.length).join('/')}）。`
  );
}

function levelsFlat(levels) {
  return levels.reduce((acc, l) => acc.concat(l), []);
}

async function main() {
  const pnpmRuntime = createPnpmBuildEnvironment();
  try {
    const ctx = { ...buildContext(), buildEnv: pnpmRuntime.env };

    if (CHECK_ONLY) {
      runCheck(ctx);
      return;
    }

    console.log(
      `⏳ 按真实依赖图拓扑构建 ${ctx.seedPkg} 的 ${ctx.closure.size} 个 workspace 依赖` +
        `（${ctx.levels.length} 层${FORCE ? '，--force 全量' : '，增量'}）`
    );
    for (let i = 0; i < ctx.levels.length; i++) {
      await buildLevel(i, ctx.levels[i], ctx);
    }

    if (ctx.includeGoCli) {
      console.log('⏳ Go CLI: tabtin-cli-go (Go binary)');
      buildGoCli();
    }

    console.log('✅ predev 构建完成');
  } finally {
    pnpmRuntime.cleanup();
  }
}

// 仅在被直接执行时跑构建；作为模块被测试导入时不触发 main()。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export {
  buildContext,
  computeFingerprint,
  createPnpmBuildEnvironment,
  isFresh,
  markBuilt,
  parseSeedPkg,
  resolvePnpmInvocation,
};
