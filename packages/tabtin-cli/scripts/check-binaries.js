#!/usr/bin/env node
'use strict';

/**
 * npm pack / npm publish 前的 prepack 校验。
 *
 * npm 不会把空目录打进 tarball，如果 binaries/ 缺文件，`npm pack` 会“成功”但
 * 产出一个没有二进制的包——这个坑要在这里提前拦住，而不是等用户装完发现
 * `tabtin` 打不开才排查。
 */

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_BINARIES = [
  'tabtin-windows-amd64.exe',
  'tabtin-windows-arm64.exe',
  'tabtin-darwin-amd64',
  'tabtin-darwin-arm64',
];

const binariesDir = path.join(__dirname, '..', 'binaries');
const missing = EXPECTED_BINARIES.filter(
  (name) => !fs.existsSync(path.join(binariesDir, name))
);

if (missing.length > 0) {
  process.stderr.write(
    '[@tabtin/cli] 缺少以下二进制，拒绝打包：\n' +
      missing.map((name) => `  - binaries/${name}`).join('\n') +
      '\n\n请先运行：\n' +
      '  pnpm --filter @tabtin/cli build   # 或 node scripts/build-binaries.js\n'
  );
  process.exit(1);
}

process.stdout.write(
  `[@tabtin/cli] binaries/ 校验通过，${EXPECTED_BINARIES.length} 个平台产物齐备。\n`
);
