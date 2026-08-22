/**
 * 二进制资源全链路收尾：preinstaller 把 source 目录里的二进制 assets（图片/字体…）
 * 原样复制进 Space sandbox，字节必须一致。
 *
 * 配合后端落盘测试（base64 → bytes 落盘字节一致）共同保证：用户导入/发布带的
 * 二进制资源，经 files[] base64 传输 → 后端解码落盘 → preinstall 进 sandbox，
 * 全程字节无损。preinstaller 用 fs.copyFile 复制，本测试锁死这条「不会被文本化/
 * 截断」的红线（首次安装 + 升级覆盖两条路径都覆盖）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { preinstallDefaultSkills } from '../../src/skills/skill-preinstaller.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// 含 NUL / 高位字节的真二进制：任何「按文本读写」都会损坏它。
const RAW = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0xff, 0xfe, 0x10, 0x00, 0x01, 0x7f, 0x80,
]);

function skillMd(version: string): string {
  return `---
name: demo
description: demo skill
metadata:
  version: ${version}
---
# Demo ${version}
`;
}

function setup(sourceVersion: string, sandboxVersion: string | null) {
  const root = mkdtempSync(path.join(tmpdir(), 'tabtin-preinstall-bin-'));
  tempRoots.push(root);
  const sourceDir = path.join(root, 'source');
  mkdirSync(path.join(sourceDir, 'assets'), { recursive: true });
  writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd(sourceVersion));
  writeFileSync(path.join(sourceDir, 'assets', 'logo.png'), RAW);
  const targetDir = path.join(root, 'target');
  if (sandboxVersion !== null) {
    const dest = path.join(targetDir, 'demo');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), skillMd(sandboxVersion));
  }
  return { sourceDir, targetDir };
}

const sources = (sourceDir: string) => [
  { sourceDir, slug: 'demo', installSlug: 'demo', source: 'app' as const, appId: 'x' },
];

describe('preinstaller 二进制资源字节一致', () => {
  it('首次安装：二进制 asset 原样复制进 sandbox（字节一致）', async () => {
    const { sourceDir, targetDir } = setup('0.1.0', null);
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, errors: [] });
    const copied = readFileSync(path.join(targetDir, 'demo', 'assets', 'logo.png'));
    expect(copied.equals(RAW)).toBe(true);
  });

  it('升级覆盖：整目录重装后二进制 asset 仍字节一致', async () => {
    const { sourceDir, targetDir } = setup('0.3.0', '0.1.0');
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, errors: [] });
    const copied = readFileSync(path.join(targetDir, 'demo', 'assets', 'logo.png'));
    expect(copied.equals(RAW)).toBe(true);
  });
});
