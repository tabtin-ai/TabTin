/**
 * readProjectRules 读盘 helper —— 项目规则自动加载（AGENTS.md MVP）单测。
 *
 * 用真实临时文件（不 mock fs），覆盖 PRD §6 读盘 helper 清单：
 *   - 文件不存在 → null；空文件 → ''（交 hook 判空）
 *   - workspaceRoot 为空 / undefined → null
 *   - mtime 未变 → 返回缓存、不重读；mtime 变 → 重读新内容
 *   - 多 workspaceRoot 不串桶（各自缓存互不污染）
 *   - 超 maxChars 截断
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readProjectRules,
  __resetProjectRulesCacheForTests,
} from '../src/tools/project-rules.js';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-rules-'));
  tmpDirs.push(dir);
  return dir;
}

function agentsPath(dir: string): string {
  return path.join(dir, 'AGENTS.md');
}

/** 设定某文件 mtime 到确定时刻（避免快速连写撞同 mtime 导致测试 flaky）。 */
async function setMtime(file: string, ms: number): Promise<void> {
  const d = new Date(ms);
  await fs.utimes(file, d, d);
}

beforeEach(() => {
  __resetProjectRulesCacheForTests();
  tmpDirs = [];
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('readProjectRules', () => {
  it('正常读 → 返回文件内容', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(agentsPath(dir), '本项目用 TypeScript。', 'utf8');
    expect(await readProjectRules(dir)).toBe('本项目用 TypeScript。');
  });

  it('文件不存在 → null', async () => {
    const dir = await makeTmpDir();
    expect(await readProjectRules(dir)).toBeNull();
  });

  it('workspaceRoot 为 undefined / 空串 / 纯空白 → null', async () => {
    expect(await readProjectRules(undefined)).toBeNull();
    expect(await readProjectRules('')).toBeNull();
    expect(await readProjectRules('   ')).toBeNull();
  });

  it('空文件 → 返回空串（交 hook 判空跳过）', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(agentsPath(dir), '', 'utf8');
    expect(await readProjectRules(dir)).toBe('');
  });

  it('目录占用 AGENTS.md 名（非普通文件）→ null', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(agentsPath(dir));
    expect(await readProjectRules(dir)).toBeNull();
  });

  it('mtime 未变 → 命中缓存、不重读盘（即使磁盘内容已变）', async () => {
    const dir = await makeTmpDir();
    const file = agentsPath(dir);
    const t1 = Date.now();
    await fs.writeFile(file, 'version A', 'utf8');
    await setMtime(file, t1);

    expect(await readProjectRules(dir)).toBe('version A'); // 首读，缓存 {t1, A}

    // 偷偷改内容，但把 mtime 强行设回 t1 → helper 认为没变。
    await fs.writeFile(file, 'version B', 'utf8');
    await setMtime(file, t1);

    expect(await readProjectRules(dir)).toBe('version A'); // 命中缓存，没读到 B
  });

  it('mtime 变 → 重读新内容（热更新）', async () => {
    const dir = await makeTmpDir();
    const file = agentsPath(dir);
    const t1 = Date.now();
    await fs.writeFile(file, 'old rules', 'utf8');
    await setMtime(file, t1);
    expect(await readProjectRules(dir)).toBe('old rules');

    await fs.writeFile(file, 'new rules', 'utf8');
    await setMtime(file, t1 + 10_000); // mtime 前进 → 重读
    expect(await readProjectRules(dir)).toBe('new rules');
  });

  it('文件被删 → null，且清掉旧缓存（不返回陈旧内容）', async () => {
    const dir = await makeTmpDir();
    const file = agentsPath(dir);
    await fs.writeFile(file, 'will be deleted', 'utf8');
    expect(await readProjectRules(dir)).toBe('will be deleted');

    await fs.rm(file);
    expect(await readProjectRules(dir)).toBeNull();

    // 重新创建 → 下一轮能读到（缓存已被删，不会卡在 null）。
    await fs.writeFile(file, 'recreated', 'utf8');
    expect(await readProjectRules(dir)).toBe('recreated');
  });

  it('多 workspaceRoot 不串桶（各自缓存互不污染）', async () => {
    const dirA = await makeTmpDir();
    const dirB = await makeTmpDir();
    await fs.writeFile(agentsPath(dirA), 'rules for A', 'utf8');
    await fs.writeFile(agentsPath(dirB), 'rules for B', 'utf8');

    // 交替读，验证不会互相覆盖。
    expect(await readProjectRules(dirA)).toBe('rules for A');
    expect(await readProjectRules(dirB)).toBe('rules for B');
    expect(await readProjectRules(dirA)).toBe('rules for A');
    expect(await readProjectRules(dirB)).toBe('rules for B');
  });

  it('超 maxChars → 粗截（无标记，标记交 hook 侧）', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(agentsPath(dir), 'z'.repeat(1000), 'utf8');
    const out = await readProjectRules(dir, { maxChars: 100 });
    expect(out).toBe('z'.repeat(100));
  });

  // ── 收口（2026-05-29 review）：大小写严格 + 错误区分 ──

  it('大小写严格：小写 agents.md → null（跨端一致，不依赖 FS 大小写敏感性）', async () => {
    // 关键：本断言在大小写敏感（Linux）与不敏感（macOS/Windows）FS 上都成立。
    // 敏感 FS：stat('AGENTS.md') 直接 ENOENT → null。
    // 不敏感 FS：stat 命中 agents.md，但 readdir 真实名比对 'AGENTS.md' 不在 → null。
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'agents.md'), 'lowercase rules', 'utf8');
    expect(await readProjectRules(dir)).toBeNull();
  });

  it('大小写严格：精确大写 AGENTS.md 才读到', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'exact case', 'utf8');
    expect(await readProjectRules(dir)).toBe('exact case');
  });

  it('ENOENT（文件不存在）→ null，不 throw', async () => {
    const dir = await makeTmpDir();
    await expect(readProjectRules(dir)).resolves.toBeNull();
  });

  it('瞬时 IO 错误（EACCES，非 ENOENT）→ throw，让 hook 保留 last-good', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(agentsPath(dir), 'rules', 'utf8');
    // mock stat 抛一个非 ENOENT 的瞬时错误（权限）——helper 不应吞成 null，
    // 而应冒泡 throw，让 rules-injector 的 try/catch 保留上一轮已注入的规约。
    const spy = vi
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    await expect(readProjectRules(dir)).rejects.toThrow();
    spy.mockRestore();
  });
});
