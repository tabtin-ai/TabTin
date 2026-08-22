/**
 * Preinstaller 升级判定治本：源目录 content hash 检测。
 *
 * 背景 bug：原判定只看 frontmatter `version`——source == sandbox 就 skip。
 * Skills 大重构（frontmatter 标准化、多文件拆分、新增 metadata.tabtin.category）
 * 改了内容但**没 bump version**，于是所有存量 sandbox 一律 skip，重构成果全没生效。
 *
 * 治本：preinstaller 在 `.skill-meta.json` 记录「上次装入时的源目录 content hash」
 * （sourceContentHash），判定时算「当前源 hash」跟它比——内容变了就 upgrade，
 * 跟 version 有没有 bump 无关。
 *
 * 本文件锁死这条主链路的 5 个核心场景 + 两个易踩坑：
 *   ① version 没变但源内容变 → upgrade（本 bug 核心）
 *   ② 源内容不变 → skip（顺带证明没踩「源 hash vs sandbox hash 直接比」的坑）
 *   ③ 老 sandbox 无 sourceContentHash → upgrade 并写入 hash（存量 sandbox 首次同步）
 *   ④ 首装 install 写入正确 hash
 *   ⑤ upgrade 后 meta 含与最新源一致的 hash
 *   ⑥ 多文件 skill：只改 references/ 子文件（SKILL.md 不动）也能触发 upgrade
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeSkillContentHash } from '@tabtin/terminal-core';

import { preinstallDefaultSkills } from '../../src/skills/skill-preinstaller.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** 新标准格式 SKILL.md（metadata.version + 可控 body）。 */
function skillMd(version: string, body: string): string {
  return `---
name: demo
description: demo skill
metadata:
  version: ${version}
---
# Demo
${body}
`;
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tabtin-preinstall-hash-'));
  tempRoots.push(root);
  return root;
}

const sources = (sourceDir: string) => [
  { sourceDir, slug: 'demo', installSlug: 'demo', source: 'app' as const, appId: 'x' },
];

function readMeta(targetDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(targetDir, 'demo', '.skill-meta.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

describe('preinstaller 源内容 hash 检测（治本）', () => {
  it('① version 没变但源内容变 → upgrade（本 bug 核心场景）', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    const targetDir = path.join(root, 'target');

    // 首装：建立 hash 基线
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'body v1'));
    const r1 = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r1).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    // 源内容变了但 version 一字不动（= 本次重构的真实情况）
    writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      skillMd('0.3.0', 'body v2 changed by refactor'),
    );
    const r2 = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r2).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    expect(after).toContain('body v2 changed by refactor');
  });

  it('② 源内容不变 → skip（证明没踩「源 hash vs sandbox hash 直接比」的坑）', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    const targetDir = path.join(root, 'target');

    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'stable body'));
    const r1 = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r1).toMatchObject({ installed: 1, skipped: 0 });

    // 源没动，再装一次。此时 sandbox 多了 .skill-meta.json（source 没有）——
    // 若实现错误地直接比 source dir vs sandbox dir 的 hash，会因这个多出来的文件
    // 恒不等 → 每次必然 upgrade。正确实现比的是「当前源 hash vs meta 记录的源
    // hash」→ 相等 → skip。
    const r2 = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r2).toMatchObject({ installed: 0, skipped: 1, errors: [] });
  });

  it('③ 老 sandbox 无 sourceContentHash → upgrade 并写入 hash', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'source body'));

    const targetDir = path.join(root, 'target');
    const dest = path.join(targetDir, 'demo');
    mkdirSync(dest, { recursive: true });
    // 模拟旧 preinstaller 落的 sandbox：有 SKILL.md + meta，但 meta 无 sourceContentHash
    writeFileSync(path.join(dest, 'SKILL.md'), skillMd('0.3.0', 'STALE sandbox body'));
    writeFileSync(
      path.join(dest, '.skill-meta.json'),
      JSON.stringify({
        source: 'app',
        slug: 'demo',
        installSlug: 'demo',
        appId: 'x',
        preinstalledAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const after = readFileSync(path.join(dest, 'SKILL.md'), 'utf-8');
    expect(after).toContain('source body'); // 存量 sandbox 被源覆盖

    const meta = readMeta(targetDir);
    expect(typeof meta.sourceContentHash).toBe('string');
    expect(meta.sourceContentHash).toBe(await computeSkillContentHash(sourceDir));
  });

  it('③b 老 sandbox 完全没有 .skill-meta.json → 同样强制 upgrade（哪怕 sandbox version 更高）', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.1.0', 'source content'));

    const targetDir = path.join(root, 'target');
    const dest = path.join(targetDir, 'demo');
    mkdirSync(dest, { recursive: true });
    // sandbox version 故意更高：新设计「内置以源为准」，无 hash 基线一律同步
    writeFileSync(path.join(dest, 'SKILL.md'), skillMd('0.9.0', 'higher-version-but-no-meta'));

    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(dest, 'SKILL.md'), 'utf-8');
    expect(after).toContain('source content');
  });

  it('④ 首装 install 写入正确 sourceContentHash（含多文件目录）', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(path.join(sourceDir, 'references'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'body'));
    writeFileSync(
      path.join(sourceDir, 'references', 'guide.md'),
      '# guide\nmulti-file skill\n',
    );

    const targetDir = path.join(root, 'target');
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const meta = readMeta(targetDir);
    expect(meta.sourceContentHash).toBe(await computeSkillContentHash(sourceDir));
  });

  it('⑤ upgrade 后 .skill-meta.json 含与最新源一致的 sourceContentHash', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    const targetDir = path.join(root, 'target');

    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'v1'));
    await preinstallDefaultSkills(targetDir, sources(sourceDir));
    const hash1 = readMeta(targetDir).sourceContentHash;

    // 改源 → 升级
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'v2 changed'));
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const hash2 = readMeta(targetDir).sourceContentHash;
    expect(hash2).toBe(await computeSkillContentHash(sourceDir));
    expect(hash2).not.toBe(hash1); // 内容变了 → hash 也变了
  });

  it('⑥ 多文件 skill：只改 references/ 子文件、SKILL.md 不动也能触发 upgrade', async () => {
    const root = makeRoot();
    const sourceDir = path.join(root, 'source');
    mkdirSync(path.join(sourceDir, 'references'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('0.3.0', 'body'));
    writeFileSync(path.join(sourceDir, 'references', 'ops.md'), 'old ops\n');
    const targetDir = path.join(root, 'target');

    await preinstallDefaultSkills(targetDir, sources(sourceDir));

    // SKILL.md 一字不改，只改子文件——这正是「多文件拆分重构」的典型形态，
    // 只看 SKILL.md version 的旧逻辑会漏掉它。
    writeFileSync(path.join(sourceDir, 'references', 'ops.md'), 'NEW ops content\n');
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const copied = readFileSync(
      path.join(targetDir, 'demo', 'references', 'ops.md'),
      'utf-8',
    );
    expect(copied).toContain('NEW ops content');
  });
});
