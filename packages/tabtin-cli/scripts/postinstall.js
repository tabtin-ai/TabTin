#!/usr/bin/env node
'use strict';

/**
 * npm i -g 后自动把包内 Skill 物化到 ~/.agents/skills（第三方 Agent 扫描目录）。
 *
 * 跳过条件：
 * - TABTIN_SKIP_SKILLS_INSTALL=1
 * - 非全局安装（避免仓库内 pnpm install 误触发）
 * - 包内 binaries/ 或 skills/manifest.json 缺失（未 build 的开发树）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PKG_ROOT, 'bin', 'tabtin.js');
const MANIFEST = path.join(PKG_ROOT, 'skills', 'manifest.json');

function log(msg) {
  process.stderr.write(`[@tabtin/cli postinstall] ${msg}\n`);
}

function isGlobalInstall() {
  // npm i -g → npm_config_global=true
  const g = process.env.npm_config_global;
  if (g === 'true' || g === true || g === '1') return true;
  // 部分环境用 npm_config_location=global
  if (process.env.npm_config_location === 'global') return true;
  return false;
}

function main() {
  if (process.env.TABTIN_SKIP_SKILLS_INSTALL === '1') {
    log('跳过 Skill 物化（TABTIN_SKIP_SKILLS_INSTALL=1）');
    return;
  }
  if (!isGlobalInstall()) {
    log('非全局安装，跳过 Skill 物化（仅 npm i -g 时自动执行）');
    return;
  }
  if (!fs.existsSync(LAUNCHER) || !fs.existsSync(MANIFEST)) {
    log('包内缺少 bin/tabtin.js 或 skills/manifest.json，跳过 Skill 物化');
    return;
  }

  // 固定落到约定目录，忽略父 shell 残留的 TABTIN_AGENTS_SKILLS_DIR，避免装错地方。
  // 自定义目录：装完后手动 tabtin skills install --dir <path>
  const agentsDir = path.join(os.homedir(), '.agents', 'skills');
  const bundleDir = path.join(PKG_ROOT, 'skills');
  log(`物化全部 Skill → ${agentsDir}`);

  const childEnv = { ...process.env, TABTIN_SKILLS_BUNDLE_DIR: bundleDir };
  delete childEnv.TABTIN_AGENTS_SKILLS_DIR;

  const result = spawnSync(
    process.execPath,
    [
      LAUNCHER,
      'skills',
      'install',
      '--target',
      'agents',
      '--dir',
      agentsDir,
      '--format',
      'json',
      '--jq',
      '{installed:(.installed|length),updated:(.updated|length),conflicts:(.conflicts|length),target}',
    ],
    {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    log(`启动失败: ${result.error.message}`);
    log('可稍后手动执行: tabtin skills install --target agents');
    // 不阻断 npm i -g
    return;
  }
  if (result.status !== 0) {
    log(`Skill 物化失败（exit ${result.status}）。可稍后手动: tabtin skills install --target agents`);
    return;
  }
  log('Skill 物化完成。重启 Cursor / Claude 后即可在 Slash Skills 中使用 tabtin-*。');
}

try {
  main();
} catch (err) {
  log(`异常: ${err && err.message ? err.message : err}`);
  // postinstall 永不拖垮全局安装
}
