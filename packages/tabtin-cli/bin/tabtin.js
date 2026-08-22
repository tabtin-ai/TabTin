#!/usr/bin/env node
'use strict';

/**
 * @tabtin/cli 启动器。
 *
 * 按 process.platform + process.arch 选出对应的预编译 tabtin Go 二进制
 * （见 ../binaries/），原样转发 argv / stdio / exit code。
 *
 * 首版（ 工作包二）只打包 Windows 与 macOS 四个平台；其它平台
 * 会在找不到匹配二进制时给出清晰报错，而不是静默失败。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// platform:arch → binaries/ 下的文件名。必须与 packages/tabtin-cli-go/Makefile
// 的 build-all 产物命名（dist/tabtin-<os>-<arch>[.exe]）保持一致。
const BINARY_MAP = {
  'win32:x64': 'tabtin-windows-amd64.exe',
  'win32:arm64': 'tabtin-windows-arm64.exe',
  'darwin:x64': 'tabtin-darwin-amd64',
  'darwin:arm64': 'tabtin-darwin-arm64',
};

function resolveBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}:${arch}`;
  const binaryName = BINARY_MAP[key];

  if (!binaryName) {
    const supported = Object.keys(BINARY_MAP)
      .map((k) => `  - ${k.replace(':', ' / ')}`)
      .join('\n');
    throw new LauncherError(
      `[@tabtin/cli] 不支持的平台: ${platform}/${arch}\n` +
        `当前 @tabtin/cli 仅打包以下平台的 tabtin 二进制：\n${supported}\n` +
        '其它平台请改用 `packages/tabtin-cli-go` 自行 `make build`，或等待后续版本补齐。'
    );
  }

  const binaryPath = path.join(__dirname, '..', 'binaries', binaryName);
  if (!fs.existsSync(binaryPath)) {
    throw new LauncherError(
      `[@tabtin/cli] 未找到 tabtin 二进制: ${binaryPath}\n` +
        `当前平台: ${platform}/${arch}，期望文件名: ${binaryName}\n` +
        '这通常意味着 npm pack 之前没有运行构建脚本。请先执行：\n' +
        '  pnpm --filter @tabtin/cli build   # 或 bash scripts/build-binaries.sh\n' +
        '再重新 npm pack / npm i -g。'
    );
  }

  return binaryPath;
}

class LauncherError extends Error {}

function main() {
  let binaryPath;
  try {
    binaryPath = resolveBinaryPath();
  } catch (err) {
    if (err instanceof LauncherError) {
      process.stderr.write(err.message + '\n');
      process.exit(1);
    }
    throw err;
  }

  if (process.platform !== 'win32') {
    // 二进制在 tarball 里可能丢 exec 位（依赖打包环节是否保留权限），
    // 这里兜底补一次，静默失败即可——真正没权限时 spawnSync 会报 EACCES。
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // ignore
    }
  }

  // 把包内 skills/ 根路径传给 Go CLI。用户已显式设置时不覆盖。
  const env = { ...process.env };
  if (!env.TABTIN_SKILLS_BUNDLE_DIR) {
    const skillsDir = path.join(__dirname, '..', 'skills');
    if (fs.existsSync(path.join(skillsDir, 'manifest.json'))) {
      env.TABTIN_SKILLS_BUNDLE_DIR = skillsDir;
    }
  }

  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    process.stderr.write(
      `[@tabtin/cli] 启动 tabtin 二进制失败: ${result.error.message}\n` +
        `二进制路径: ${binaryPath}\n`
    );
    process.exit(1);
  }

  if (result.signal) {
    // 被信号杀死（如 Ctrl-C 转发的 SIGINT）：透传信号语义，避免吞掉终止原因。
    process.kill(process.pid, result.signal);
    return;
  }

  process.exit(result.status === null ? 1 : result.status);
}

main();
