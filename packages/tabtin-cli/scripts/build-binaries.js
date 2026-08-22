#!/usr/bin/env node
'use strict';

/**
 * 跨平台编译 tabtin-cli-go，并把首版要打进 @tabtin/cli 的 Windows/macOS
 * 四个产物拷到 binaries/。不依赖 make / bash。
 *
 * Linux 仍会编进 tabtin-cli-go/dist/，但不拷进本包。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const PKG_DIR = path.resolve(SCRIPT_DIR, '..');
const GO_CLI_DIR = path.resolve(PKG_DIR, '../tabtin-cli-go');
const BINARIES_DIR = path.join(PKG_DIR, 'binaries');
const DIST_DIR = path.join(GO_CLI_DIR, 'dist');

const FIRST_PARTY = [
  { goos: 'windows', goarch: 'amd64', out: 'tabtin-windows-amd64.exe' },
  { goos: 'windows', goarch: 'arm64', out: 'tabtin-windows-arm64.exe' },
  { goos: 'darwin', goarch: 'amd64', out: 'tabtin-darwin-amd64' },
  { goos: 'darwin', goarch: 'arm64', out: 'tabtin-darwin-arm64' },
];

const EXTRA_DIST = [
  { goos: 'linux', goarch: 'amd64', out: 'tabtin-linux-amd64' },
  { goos: 'linux', goarch: 'arm64', out: 'tabtin-linux-arm64' },
];

function die(msg) {
  process.stderr.write(`[build-binaries] ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: false,
    ...opts,
  });
  if (r.error) die(`${cmd} 启动失败: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

function gitDescribe() {
  const r = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
    encoding: 'utf8',
    cwd: GO_CLI_DIR,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return 'dev';
}

function gitShort() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    cwd: GO_CLI_DIR,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return 'unknown';
}

function buildOne({ goos, goarch, out }) {
  const dest = path.join(DIST_DIR, out);
  const version = gitDescribe();
  const commit = gitShort();
  const buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ldflags = [
    '-s',
    '-w',
    `-X github.com/TabTin/tabtin-cli/internal/version.Version=${version}`,
    `-X github.com/TabTin/tabtin-cli/internal/version.GitCommit=${commit}`,
    `-X github.com/TabTin/tabtin-cli/internal/version.BuildDate=${buildDate}`,
  ].join(' ');

  process.stdout.write(`[build-binaries] GOOS=${goos} GOARCH=${goarch} → ${out}\n`);
  run('go', ['build', '-ldflags', ldflags, '-o', dest, '.'], {
    cwd: GO_CLI_DIR,
    env: {
      ...process.env,
      GOOS: goos,
      GOARCH: goarch,
      CGO_ENABLED: '0',
    },
  });
}

function main() {
  const goCheck = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (goCheck.status !== 0) {
    die('未找到 go，请先安装 Go 1.26+ 并加入 PATH');
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(BINARIES_DIR, { recursive: true });

  for (const t of [...FIRST_PARTY, ...EXTRA_DIST]) {
    buildOne(t);
  }

  for (const f of fs.readdirSync(BINARIES_DIR)) {
    if (f.startsWith('tabtin-')) {
      fs.unlinkSync(path.join(BINARIES_DIR, f));
    }
  }

  for (const { out } of FIRST_PARTY) {
    const src = path.join(DIST_DIR, out);
    if (!fs.existsSync(src)) die(`缺少构建产物: ${src}`);
    const dest = path.join(BINARIES_DIR, out);
    fs.copyFileSync(src, dest);
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      // Windows 可忽略
    }
    process.stdout.write(`  ✓ ${out}\n`);
  }

  process.stdout.write(
    `[build-binaries] 生成第三方 Agent Skill bundle → skills/\n`,
  );
  run(process.execPath, [path.join(SCRIPT_DIR, 'generate-skills-bundle.cjs')]);

  process.stdout.write(
    `[build-binaries] 完成。Linux 产物在 ${DIST_DIR}（本包首版不打包）。\n` +
      `[build-binaries] binaries/ + skills/ 已就绪，可以 npm pack。\n`,
  );
}

main();
