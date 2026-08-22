#!/usr/bin/env node
/**
 * Pre-build 脚本：下载 LSP server tarball 并解压到 `lsp-servers/`。
 *
 * 设计理由：
 *   - 国内用户首次启动 TabTin 时 npm registry 访问不稳定 → 不能"按需下载到 cache"
 *   - 解决：build 时预下载，打进 Electron 安装包（asarUnpack）
 *
 * 下载策略：
 *   1. 从 npm registry 拿 tarball URL（`npm view <pkg> dist.tarball`）
 *   2. 下载 .tgz 文件
 *   3. 用 tar 解压到 lsp-servers/<pkg>/（剥掉 tarball 顶层的 `package/` 目录）
 *   4. 写 .version 文件记录版本（方便升级时对比）
 *
 * 失败兜底：
 *   - 网络失败 / 包不存在 → 打印警告但不中断 build（下载是可选优化）
 *   - 运行时 spawn LSP 会用 bundled-paths.ts 检查文件存在性；找不到则由
 *     agent-runtime 的 spawn linter fallback 兜底（调 readDiagnosticsTool）
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVERS_DIR = join(ROOT, 'lsp-servers');

// 锁定版本 —— 跟随 TabTin 发布一起更新，避免上游 breaking change 偷偷生效
const SERVERS = [
  { name: 'typescript-language-server', version: '5.2.0' },
  { name: 'typescript', version: '5.6.3' }, // 兜底（用户项目没装 typescript 时用）
  { name: 'pyright', version: '1.1.409' },
];

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[download-lsp-servers] ${msg}`);
}

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`[download-lsp-servers] WARN: ${msg}`);
}

function fetchTarballUrl(pkg, version) {
  // 通过 `npm view` 拿真实 tarball URL（避免硬编码 URL 失效）
  // 优先用 TABTIN_NPM_REGISTRY env，回退到默认 registry
  const registryArg = process.env.TABTIN_NPM_REGISTRY
    ? `--registry=${process.env.TABTIN_NPM_REGISTRY}`
    : '';
  const cmd = `npm view ${pkg}@${version} dist.tarball ${registryArg}`.trim();
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function downloadFile(url, dest) {
  // 用 Node fetch（Node 18+ 内置）下载到本地
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download ${url} failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function extractTarball(tarballPath, destDir) {
  // 用系统 tar 解压（macOS / Linux / Windows 10+ 内置）
  // --strip-components=1 剥掉 tarball 顶层 `package/` 目录
  mkdirSync(destDir, { recursive: true });
  execSync(
    `tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1`,
    { stdio: 'pipe' },
  );
}

async function downloadServer(pkg, version) {
  const destDir = join(SERVERS_DIR, pkg);
  const versionFile = join(destDir, '.tabtin-version');

  // Skip if already downloaded with same version
  if (existsSync(versionFile)) {
    try {
      const recorded = await import('node:fs').then((fs) =>
        fs.promises.readFile(versionFile, 'utf8'),
      );
      if (recorded.trim() === version) {
        log(`${pkg}@${version} already downloaded, skipping`);
        return true;
      }
    } catch {
      // ignore, will re-download
    }
  }

  // Clean stale install
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }

  try {
    log(`Resolving tarball for ${pkg}@${version}...`);
    const url = fetchTarballUrl(pkg, version);
    log(`  → ${url}`);

    const tmp = join(tmpdir(), `${pkg.replace(/[/@]/g, '_')}-${randomUUID()}.tgz`);
    try {
      log(`  Downloading to ${tmp}...`);
      await downloadFile(url, tmp);
      log(`  Extracting to ${destDir}...`);
      extractTarball(tmp, destDir);
    } finally {
      // Cleanup tmp file
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }

    writeFileSync(versionFile, version);
    log(`  ✓ ${pkg}@${version}`);
    return true;
  } catch (error) {
    warn(`Failed to download ${pkg}@${version}: ${error.message}`);
    warn(
      `  LSP integration will fall back to system PATH or spawn linter for this language.`,
    );
    // Cleanup partial download
    if (existsSync(destDir)) {
      try {
        rmSync(destDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

async function main() {
  if (process.env.TABTIN_SKIP_LSP_DOWNLOAD) {
    log(
      `TABTIN_SKIP_LSP_DOWNLOAD set, skipping all downloads. LSP will use system PATH or fallback.`,
    );
    return;
  }

  mkdirSync(SERVERS_DIR, { recursive: true });

  const results = await Promise.all(
    SERVERS.map(({ name, version }) => downloadServer(name, version)),
  );

  const success = results.filter(Boolean).length;
  log(`Downloaded ${success}/${SERVERS.length} LSP server packages`);

  if (success < SERVERS.length) {
    warn(
      `Some packages failed to download. TabTin will still work but LSP integration may be limited until packages are available.`,
    );
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[download-lsp-servers] fatal: ${error.message}`);
  // Don't exit 1 —— 构建不能因为 LSP 下载失败挂掉
  // （fallback 路径在运行时由 bundled-paths.ts 处理）
});
