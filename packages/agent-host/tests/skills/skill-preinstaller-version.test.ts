/**
 * Preinstaller 升级判定：从「纯 version」切到「源内容 hash 优先」后的跨格式行为。
 *
 * 历史（旧逻辑）：判定只看 frontmatter `version`，source > sandbox 才 upgrade，
 * 同版本 / 版本缺失一律保守 skip。Phase A 让 skill-doc-parser 归一化
 * `frontmatter.version`（metadata.version 优先、回退顶层），保证新旧格式都能取到
 * 版本号，于是本文件原本测的是「跨格式 version 比较仍正确」。
 *
 * 现状（2026-06 治本）：preinstaller 改为以**源目录 content hash** 为主判据——
 * `.skill-meta.json` 记录上次装入时的源 hash，判定时跟当前源 hash 比，内容变了
 * 就 upgrade（详见 skill-preinstaller.ts 文件头 + skill-preinstaller-content-hash.test.ts）。
 * version 仅在 hash 算不出来时兜底。
 *
 * 因此本文件这些「sandbox 是手搓副本、**没有 hash 基线**」的跨格式场景，新预期一律是
 * **强制同步到源**（内置以源为准）——不再做 version 降级保护、不再因同版本/无版本而
 * skip。这正是让存量 sandbox 吃到重构成果的关键行为。逐用例预期见各 it 注释。
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

/** 新标准格式：name=kebab + metadata.version + metadata.tabtin.*（迁移后的 source 形态）。 */
function newFormat(version: string): string {
  return `---
name: demo
description: demo skill
metadata:
  version: ${version}
  tabtin:
    displayName: "Demo"
    autoActivateFor:
      - tabdemo
---
# Demo
new body ${version}
`;
}

/** 旧格式：顶层 version + 顶层 auto_activate_for（老 sandbox 副本形态）。 */
function oldFormat(version: string): string {
  return `---
name: Demo
description: demo skill
version: ${version}
auto_activate_for:
  - tabdemo
---
# Demo
old body ${version}
`;
}

function oldFormatNoVersion(): string {
  return `---
name: Demo
description: demo skill
---
# Demo
old body no version
`;
}

/** 手搓 sandbox：只有 SKILL.md，**没有 .skill-meta.json**（= 无 hash 基线）。 */
function setup(sourceContent: string, sandboxContent: string | null) {
  const root = mkdtempSync(path.join(tmpdir(), 'tabtin-preinstall-ver-'));
  tempRoots.push(root);
  const sourceDir = path.join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'SKILL.md'), sourceContent);
  const targetDir = path.join(root, 'target');
  if (sandboxContent !== null) {
    const dest = path.join(targetDir, 'demo');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), sandboxContent);
  }
  return { sourceDir, targetDir };
}

const sources = (sourceDir: string) => [
  { sourceDir, slug: 'demo', installSlug: 'demo', source: 'app' as const, appId: 'x' },
];

describe('preinstaller 跨格式升级判定（hash 优先，无基线一律同步）', () => {
  it('新格式 source(0.3.0) + 旧格式 sandbox(0.1.0) 无 hash 基线 → 同步到源', async () => {
    const { sourceDir, targetDir } = setup(newFormat('0.3.0'), oldFormat('0.1.0'));
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    expect(after).toContain('metadata:');
    expect(after).toContain('version: 0.3.0');
    expect(after).toContain('new body 0.3.0');
  });

  it('新格式 source(0.1.0) < 旧格式 sandbox(0.3.0) 无 hash 基线 → 仍同步到源（内置以源为准，不再做 version 降级保护）', async () => {
    const { sourceDir, targetDir } = setup(newFormat('0.1.0'), oldFormat('0.3.0'));
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    // 被源覆盖：旧逻辑会 skip 保留 sandbox 的 0.3.0，新逻辑同步到源 0.1.0
    expect(after).toContain('new body 0.1.0');
  });

  it('同版本(0.2.0) 无 hash 基线 → 同步到源（这正是只看 version 会漏的重构场景）', async () => {
    const { sourceDir, targetDir } = setup(newFormat('0.2.0'), oldFormat('0.2.0'));
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    // 旧逻辑：同版本 → skip（漏掉内容变更）。新逻辑：无 hash 基线 → 强制同步。
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    expect(after).toContain('new body 0.2.0');
  });

  it('首次安装（sandbox 无副本）→ 全量安装新格式', async () => {
    const { sourceDir, targetDir } = setup(newFormat('0.3.0'), null);
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    expect(after).toContain('version: 0.3.0');
  });

  it('旧格式 sandbox 无 version、无 hash 基线 → 同步到源（不再因版本缺失而保守 skip）', async () => {
    const { sourceDir, targetDir } = setup(newFormat('0.3.0'), oldFormatNoVersion());
    const r = await preinstallDefaultSkills(targetDir, sources(sourceDir));
    expect(r).toMatchObject({ installed: 1, skipped: 0, errors: [] });
    const after = readFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8');
    expect(after).toContain('new body 0.3.0');
  });
});
