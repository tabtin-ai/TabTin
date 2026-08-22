/**
 * Preinstaller 历代 installSlug 孤儿清理。
 *
 * 背景：同一个内置 skill 在 sandbox 里可能存了多套副本——早期裸 slug 目录
 * （`operations` / `tabcode-operator`）+ 现在带前缀的 installSlug
 * （`device-operations` / `tabcode-tabcode-operator`）。installSlug 命名格式换过
 * 但旧目录从没删，registry 两套都扫到 → UI 重复、Installed 计数虚高。
 *
 * 清理逻辑：每轮 preinstall 末尾，对每个内置 source 算它当前的 canonicalKey 与
 * installSlug；扫 targetDir，凡「`.skill-meta.json` 派生出的 canonicalKey == 某内置
 * source 的 canonicalKey、但目录名不是当前 installSlug」的判为过期孤儿删掉。
 *
 * 安全红线（本文件重点锁死）：
 * - 旧裸 slug 孤儿（同 canonicalKey 不同目录名）被删；
 * - 当前 installSlug 保留；
 * - user skill（source:user / canonicalKey user:* / 无 meta）一律不碰；
 * - 无 meta / meta 损坏 / source 未知 / 不在本次内置集合的目录不删；
 * - 宁可漏删也别误删。
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { preinstallDefaultSkills } from '../../src/skills/skill-preinstaller.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function skillMd(body: string): string {
  return `---
name: demo
description: demo skill
metadata:
  version: 0.1.0
---
# Demo
${body}
`;
}

function makeRoot(): { sourceDir: string; targetDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'tabtin-preinstall-orphan-'));
  tempRoots.push(root);
  const sourceDir = path.join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'SKILL.md'), skillMd('source body'));
  const targetDir = path.join(root, 'target');
  mkdirSync(targetDir, { recursive: true });
  return { sourceDir, targetDir };
}

/** 在 targetDir 下手建一个已存在的 sandbox skill 目录（模拟历史副本 / user skill）。 */
function seedDir(
  targetDir: string,
  dirName: string,
  opts: { meta?: object | null; rawMeta?: string; body?: string },
): string {
  const dir = path.join(targetDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), skillMd(opts.body ?? `seeded ${dirName}`));
  if (opts.rawMeta !== undefined) {
    writeFileSync(path.join(dir, '.skill-meta.json'), opts.rawMeta);
  } else if (opts.meta !== null && opts.meta !== undefined) {
    writeFileSync(
      path.join(dir, '.skill-meta.json'),
      JSON.stringify(opts.meta, null, 2),
    );
  }
  return dir;
}

const exists = (targetDir: string, name: string) =>
  existsSync(path.join(targetDir, name));

describe('preinstaller 历代 installSlug 孤儿清理', () => {
  it('platform 旧裸 slug 孤儿被删，当前带前缀 installSlug 保留', async () => {
    const { sourceDir, targetDir } = makeRoot();
    // 旧裸目录 operations：meta 无 slug / 无 canonicalKey（模拟旧 preinstaller 落盘）
    seedDir(targetDir, 'operations', {
      meta: { source: 'platform', domain: 'device' },
      body: 'OLD operations',
    });

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.installed).toBe(1); // 当前 device-operations 首装
    expect(r.removed).toBe(1); // 旧裸 operations 删
    expect(r.errors).toEqual([]);
    expect(exists(targetDir, 'device-operations')).toBe(true);
    expect(exists(targetDir, 'operations')).toBe(false);
  });

  it('app 旧裸 slug 孤儿被删，当前 appId 前缀 installSlug 保留（tabcode-operator → tabcode-tabcode-operator）', async () => {
    const { sourceDir, targetDir } = makeRoot();
    seedDir(targetDir, 'tabcode-operator', {
      meta: { source: 'app', appId: 'tabcode' },
      body: 'OLD tabcode',
    });

    const src = [
      {
        sourceDir,
        slug: 'tabcode-operator',
        installSlug: 'tabcode-tabcode-operator',
        source: 'app' as const,
        appId: 'tabcode',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.installed).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.errors).toEqual([]);
    expect(exists(targetDir, 'tabcode-tabcode-operator')).toBe(true);
    expect(exists(targetDir, 'tabcode-operator')).toBe(false);
  });

  it('同一 skill 多个历史孤儿全删，只留当前 installSlug', async () => {
    const { sourceDir, targetDir } = makeRoot();
    // gen1：纯裸 slug，meta 无 slug/canonicalKey → 靠目录名派生
    seedDir(targetDir, 'operations', {
      meta: { source: 'platform', domain: 'device' },
      body: 'gen1',
    });
    // gen2：另一种历史命名，meta 显式写了 canonicalKey
    seedDir(targetDir, 'device-ops-legacy', {
      meta: {
        source: 'platform',
        domain: 'device',
        slug: 'operations',
        canonicalKey: 'platform:device/operations',
      },
      body: 'gen2',
    });

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.installed).toBe(1);
    expect(r.removed).toBe(2);
    expect(exists(targetDir, 'device-operations')).toBe(true);
    expect(exists(targetDir, 'operations')).toBe(false);
    expect(exists(targetDir, 'device-ops-legacy')).toBe(false);
  });

  it('user skill 目录一律不碰（source:user / canonicalKey user:* / 无 meta）', async () => {
    const { sourceDir, targetDir } = makeRoot();
    seedDir(targetDir, 'user-a', { meta: { source: 'user', slug: 'user-a' } });
    seedDir(targetDir, 'user-b', { meta: { canonicalKey: 'user:user-b' } });
    seedDir(targetDir, 'user-c', { meta: null }); // 无 meta

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.removed).toBe(0);
    expect(exists(targetDir, 'user-a')).toBe(true);
    expect(exists(targetDir, 'user-b')).toBe(true);
    expect(exists(targetDir, 'user-c')).toBe(true);
  });

  it('无 meta / meta 损坏 / source 未知的目录不删（认不出 → 跳过）', async () => {
    const { sourceDir, targetDir } = makeRoot();
    seedDir(targetDir, 'broken', { rawMeta: '{not valid json', body: 'x' });
    seedDir(targetDir, 'weird', { meta: { source: 'something-else' } });
    seedDir(targetDir, 'no-meta', { meta: null });

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.removed).toBe(0);
    expect(exists(targetDir, 'broken')).toBe(true);
    expect(exists(targetDir, 'weird')).toBe(true);
    expect(exists(targetDir, 'no-meta')).toBe(true);
  });

  it('canonicalKey 不在本次 preinstall 内置集合里的目录不删（别的内置 skill 的当前目录）', async () => {
    const { sourceDir, targetDir } = makeRoot();
    // 一个属于「另一个内置 skill」的当前目录，本次 source 列表不含它 → 不该动
    seedDir(targetDir, 'mcp-operations', {
      meta: {
        source: 'platform',
        domain: 'mcp',
        slug: 'operations',
        canonicalKey: 'platform:mcp/operations',
        installSlug: 'mcp-operations',
      },
    });

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.removed).toBe(0);
    expect(exists(targetDir, 'mcp-operations')).toBe(true);
  });

  it('与内容 hash 升级共存：当前副本内容未变 → skip，但历史孤儿仍被清掉', async () => {
    const { sourceDir, targetDir } = makeRoot();
    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];

    // 第一次 preinstall：装当前 device-operations（写 meta + sourceContentHash）
    const r1 = await preinstallDefaultSkills(targetDir, src);
    expect(r1.installed).toBe(1);
    expect(r1.removed).toBe(0);

    // 之后才出现一个历史孤儿
    seedDir(targetDir, 'operations', {
      meta: { source: 'platform', domain: 'device' },
      body: 'OLD',
    });

    // 第二次 preinstall：源没变 → 当前 device-operations 走 hash skip；孤儿 operations 删
    const r2 = await preinstallDefaultSkills(targetDir, src);
    expect(r2.skipped).toBe(1);
    expect(r2.installed).toBe(0);
    expect(r2.removed).toBe(1);
    expect(exists(targetDir, 'device-operations')).toBe(true);
    expect(exists(targetDir, 'operations')).toBe(false);
  });

  it('preinstall 写入的 .skill-meta.json 含正确 canonicalKey 字段', async () => {
    const { sourceDir, targetDir } = makeRoot();
    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
    ];
    await preinstallDefaultSkills(targetDir, src);
    const meta = JSON.parse(
      readFileSync(
        path.join(targetDir, 'device-operations', '.skill-meta.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    expect(meta.canonicalKey).toBe('platform:device/operations');
  });

  it('多 source 一起 preinstall：各自的当前目录互不误删，只清各自孤儿', async () => {
    const { sourceDir, targetDir } = makeRoot();
    // 两个不同内置 skill，各塞一个旧裸 slug 孤儿
    seedDir(targetDir, 'operations', {
      meta: { source: 'platform', domain: 'device' },
    });
    seedDir(targetDir, 'phone-operator', {
      meta: { source: 'app', appId: 'tabphone' },
    });

    const src = [
      {
        sourceDir,
        slug: 'operations',
        installSlug: 'device-operations',
        source: 'platform' as const,
        domain: 'device',
      },
      {
        sourceDir,
        slug: 'phone-operator',
        installSlug: 'tabphone-phone-operator',
        source: 'app' as const,
        appId: 'tabphone',
      },
    ];
    const r = await preinstallDefaultSkills(targetDir, src);

    expect(r.installed).toBe(2);
    expect(r.removed).toBe(2);
    expect(exists(targetDir, 'device-operations')).toBe(true);
    expect(exists(targetDir, 'tabphone-phone-operator')).toBe(true);
    expect(exists(targetDir, 'operations')).toBe(false);
    expect(exists(targetDir, 'phone-operator')).toBe(false);
  });
});
