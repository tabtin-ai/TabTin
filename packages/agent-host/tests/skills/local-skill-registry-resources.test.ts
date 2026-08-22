import { createLexicalSkillRecall } from '@tabtin/agent-runtime/skills';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOrganizationSkillsDir } from '@tabtin/terminal-core';

import { LocalSkillRegistry } from '../../src/skills/local-skill-registry.js';

const tempRoots: string[] = [];
const USER_ID = 'user-1';
const ORGANIZATION_ID = 'wt-1';

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 建一个带 references/ + examples/ 的 skill 目录，返回初始化好的 registry。
 * canonicalKey 固定 `app:tabweb/tabweb-browser-operator`。
 */
async function buildRegistryWithResources(): Promise<LocalSkillRegistry> {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'tabtin-skill-res-'));
  tempRoots.push(dataRoot);

  const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
  const skillDir = path.join(skillsRoot, 'tabweb-browser-operator');
  mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  mkdirSync(path.join(skillDir, 'examples'), { recursive: true });

  writeFileSync(
    path.join(skillDir, '.skill-meta.json'),
    JSON.stringify({ source: 'app', appId: 'tabweb' }),
  );
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nslug: browser-operator\nname: Browser Operator\ndescription: Web automation.\n---\n\n# Browser Operator\n',
  );
  writeFileSync(
    path.join(skillDir, 'references', 'cli-reference.md'),
    '# tabtin browser 全子命令参考\n\nbody',
  );
  writeFileSync(
    path.join(skillDir, 'references', 'operations.md'),
    '> 端到端命令序列目录\n\nbody',
  );
  writeFileSync(
    path.join(skillDir, 'examples', 'two-phase.md'),
    '列表 + 详情两阶段采集完整可跑示例\n',
  );
  // 隐藏文件与 SKILL.md 不应出现在清单里
  writeFileSync(path.join(skillDir, 'references', '.secret'), 'nope');

  const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
    env: { dataRoot, userId: USER_ID },
    logger: { warn: () => undefined, info: () => undefined },
  });
  await registry.ready();
  return registry;
}

describe('LocalSkillRegistry Tier-3 resources', () => {
  it('listResources 列出 references/ + examples/ 的文件，带摘要，排除隐藏文件', async () => {
    const registry = await buildRegistryWithResources();
    const resources = await registry.listResources('app:tabweb/tabweb-browser-operator');

    const paths = resources.map((r) => r.path);
    expect(paths).toEqual([
      'examples/two-phase.md',
      'references/cli-reference.md',
      'references/operations.md',
    ]);
    expect(paths).not.toContain('references/.secret');

    const cli = resources.find((r) => r.path === 'references/cli-reference.md');
    expect(cli?.summary).toBe('tabtin browser 全子命令参考');
    const ops = resources.find((r) => r.path === 'references/operations.md');
    expect(ops?.summary).toBe('端到端命令序列目录');
  });

  it('listResources 对无 references/examples 的 key 返回空数组', async () => {
    const registry = await buildRegistryWithResources();
    expect(await registry.listResources('app:tabweb/does-not-exist')).toEqual([]);
  });

  it('readResource 读到附属文件全文', async () => {
    const registry = await buildRegistryWithResources();
    const res = await registry.readResource(
      'app:tabweb/tabweb-browser-operator',
      'references/cli-reference.md',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe('references/cli-reference.md');
      expect(res.content).toContain('tabtin browser 全子命令参考');
    }
  });

  it('readResource 拒绝 .. 路径穿越', async () => {
    const registry = await buildRegistryWithResources();
    const res = await registry.readResource(
      'app:tabweb/tabweb-browser-operator',
      '../SKILL.md',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('路径越界');
  });

  it('readResource 拒绝直接读 SKILL.md', async () => {
    const registry = await buildRegistryWithResources();
    const res = await registry.readResource(
      'app:tabweb/tabweb-browser-operator',
      'SKILL.md',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SKILL.md 请用 skills_read');
  });

  it('readResource 对不存在的文件返回带 hint 的失败', async () => {
    const registry = await buildRegistryWithResources();
    const res = await registry.readResource(
      'app:tabweb/tabweb-browser-operator',
      'references/nope.md',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('附属文件不存在');
      expect(res.hint).toBeTruthy();
    }
  });

  it('readResource 对未知 key 返回失败', async () => {
    const registry = await buildRegistryWithResources();
    const res = await registry.readResource(
      'app:tabweb/does-not-exist',
      'references/cli-reference.md',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('未找到技能');
  });
});
