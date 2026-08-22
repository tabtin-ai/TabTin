/**
 * 目录自带 Skill 扫描器单测（ W3）。
 *
 * 覆盖 Owner 硬约束与成本策略：
 * 1. 类型特征识别：任何位置的 SKILL.md + 合法 frontmatter 即是 Skill——
 *    `.agents/skills/`、`.cursor/skills/`、`skills/`、任意子目录一视同仁；
 *    frontmatter 缺 description / 缺 frontmatter → 不是 Skill。
 * 2. 成本约束：深度上限、目录数上限、技能数上限、skip 大目录、
 *    skill 目录视为叶子不深入。
 * 3. mtime 缓存：TTL 内复用；目录变更（mtime 变化 + 超 TTL）后重扫。
 * 4. canonical 标识：相对路径自然派生 + 唯一性；来源用结构化字段
 *    sourceType='workspace' 表达。
 * 5. 合成就近优先：同 slug 目录版胜出，遮蔽关系可解释。
 */

import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_SCAN_LIMITS,
  buildWorkspaceSkillKey,
  clearWorkspaceSkillScanCache,
  getCachedWorkspaceSkills,
  isWorkspaceRootAllowed,
  mergeWorkspaceSkillsForRuntime,
  scanWorkspaceSkills,
  scanWorkspaceSkillsGuarded,
} from '../workspace-skill-scanner.js';
import { computeWorkspaceShadowing, type LocalSkill } from '@tabtin/agent-runtime/skills';

let root: string;

const SKILL_MD = (slug: string, description = `Use for ${slug} things`): string =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`;

async function addSkillDir(relDir: string, slug: string, content?: string): Promise<void> {
  const dir = join(root, relDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content ?? SKILL_MD(slug), 'utf-8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-skill-scan-'));
  clearWorkspaceSkillScanCache();
}, 30_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  clearWorkspaceSkillScanCache();
}, 30_000);

describe('类型特征识别（不依赖路径约定）', () => {
  it('任何位置的合法 SKILL.md 都被识别：.agents/.cursor/skills/自定义目录一视同仁', async () => {
    await addSkillDir('.agents/skills/alpha', 'alpha');
    await addSkillDir('.cursor/skills/beta', 'beta');
    await addSkillDir('skills/gamma', 'gamma');
    await addSkillDir('tools/review/delta', 'delta');

    const result = await scanWorkspaceSkills(root);
    const slugs = result.skills.map((s) => s.slug).sort();
    expect(slugs).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    // 来源分类用结构化字段表达（消费端不判 key 前缀）
    for (const skill of result.skills) {
      expect(skill.sourceType).toBe('workspace');
      expect(skill.rootKind).toBe('workspace');
      expect(skill.workspaceRelPath).toBeTruthy();
    }
  });

  it('内容 schema 不通过就不是 Skill：缺 frontmatter / 缺 description 均拒绝', async () => {
    const noFm = join(root, 'docs/readme-dir');
    await mkdir(noFm, { recursive: true });
    await writeFile(join(noFm, 'SKILL.md'), '# 没有 frontmatter\n', 'utf-8');

    const noDesc = join(root, 'docs/no-desc');
    await mkdir(noDesc, { recursive: true });
    await writeFile(join(noDesc, 'SKILL.md'), '---\nname: no-desc\n---\nbody\n', 'utf-8');

    await addSkillDir('docs/legit', 'legit');

    const result = await scanWorkspaceSkills(root);
    expect(result.skills.map((s) => s.slug)).toEqual(['legit']);
  });

  it('根目录自身的 SKILL.md 不作为 skill（Workspace 根不是 skill 目录）', async () => {
    await writeFile(join(root, 'SKILL.md'), SKILL_MD('root-doc'), 'utf-8');
    await addSkillDir('sub/real', 'real');

    const result = await scanWorkspaceSkills(root);
    expect(result.skills.map((s) => s.slug)).toEqual(['real']);
  });

  it('扫描结果携带稳定内容哈希，相同内容复制到不同目录时哈希一致', async () => {
    const content = SKILL_MD('same-content');
    await addSkillDir('skills/first', 'same-content', content);
    await addSkillDir('tools/copied', 'same-content', content);

    const result = await scanWorkspaceSkills(root);
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.skills[1].contentHash).toBe(result.skills[0].contentHash);
  });

  it('skill 目录是自包含叶子：其子目录里的 SKILL.md 不再收录', async () => {
    await addSkillDir('skills/outer', 'outer');
    await addSkillDir('skills/outer/examples/inner', 'inner');

    const result = await scanWorkspaceSkills(root);
    expect(result.skills.map((s) => s.slug)).toEqual(['outer']);
  });
});

describe('成本约束', () => {
  it('跳过 node_modules 等大目录', async () => {
    await addSkillDir('node_modules/evil-pkg/skills/evil', 'evil');
    await addSkillDir('.git/hooks/sneaky', 'sneaky');
    await addSkillDir('src/good', 'good');

    const result = await scanWorkspaceSkills(root);
    expect(result.skills.map((s) => s.slug)).toEqual(['good']);
  });

  it('深度上限之外的 skill 不收录', async () => {
    // maxDepth=4：root(0)/a(1)/b(2)/c(3)/d(4) —— depth 4 目录本身还会被检查
    // SKILL.md，但不会再入队 depth 5。
    await addSkillDir('a/b/c/deep-ok', 'deep-ok'); // skill 目录在 depth 4 → 识别
    await addSkillDir('a/b/c/d/e/too-deep', 'too-deep'); // depth 6 → 不可达

    const result = await scanWorkspaceSkills(root);
    expect(result.skills.map((s) => s.slug)).toEqual(['deep-ok']);
  });

  it('技能数上限截断并标记 truncated', async () => {
    await addSkillDir('skills/one', 'one');
    await addSkillDir('skills/two', 'two');
    await addSkillDir('skills/three', 'three');

    const result = await scanWorkspaceSkills(root, {
      limits: { maxSkills: 2 },
    });
    expect(result.skills.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('目录访问数上限截断并标记 truncated', async () => {
    for (let i = 0; i < 10; i += 1) {
      await mkdir(join(root, `dir-${i}`), { recursive: true });
    }
    await addSkillDir('dir-9/last', 'last');

    const result = await scanWorkspaceSkills(root, {
      limits: { maxDirs: 3 },
    });
    expect(result.truncated).toBe(true);
    expect(result.scannedDirs).toBeLessThanOrEqual(3);
  });
});

describe('mtime 缓存', () => {
  it('TTL 内直接复用结果（不感知新增）；force 强制重扫', async () => {
    await addSkillDir('skills/first', 'first');
    const first = await scanWorkspaceSkills(root);
    expect(first.skills.length).toBe(1);

    await addSkillDir('skills/second', 'second');
    const cachedHit = await scanWorkspaceSkills(root);
    expect(cachedHit.scannedAt).toBe(first.scannedAt); // 同一份缓存对象

    const forced = await scanWorkspaceSkills(root, { force: true });
    expect(forced.skills.length).toBe(2);
  });

  it('超 TTL 后 stat 校验：目录 mtime 变化触发重扫', async () => {
    await addSkillDir('skills/first', 'first');
    let clock = 1_000_000;
    const now = (): number => clock;

    const first = await scanWorkspaceSkills(root, { now });
    expect(first.skills.length).toBe(1);

    // 新增 skill 会改根目录（skills/ 的父链不变但 skill 目录本身新增）——
    // 这里直接改已有 skill 目录的 mtime 模拟内容变更。
    const skillDir = join(root, 'skills/first');
    await utimes(skillDir, new Date(), new Date(Date.now() + 5_000));

    clock += DEFAULT_WORKSPACE_SCAN_LIMITS.cacheTtlMs + 1_000; // 越过 TTL，进入 stat 校验窗
    const second = await scanWorkspaceSkills(root, { now });
    expect(second.scannedAt).toBe(clock); // mtime 不一致 → 重扫（新 scannedAt）
  });

  it('getCachedWorkspaceSkills 同步返回最近一次扫描结果', async () => {
    expect(getCachedWorkspaceSkills(root)).toEqual([]);
    await addSkillDir('skills/first', 'first');
    await scanWorkspaceSkills(root);
    expect(getCachedWorkspaceSkills(root).map((s) => s.slug)).toEqual(['first']);
  });
});

describe('canonical 标识派生', () => {
  it('key 从相对路径自然派生，段内非法字符 slug 化', async () => {
    await addSkillDir('.agents/skills/my-skill', 'my-skill');
    const result = await scanWorkspaceSkills(root);
    // `.agents` 段的点被清洗为合法段
    expect(result.skills[0].canonicalKey).toBe('workspace:agents/skills/my-skill');
  });

  it('清洗后碰撞追加序号保唯一', () => {
    const taken = new Set(['workspace:skills/foo']);
    expect(buildWorkspaceSkillKey('skills/foo', taken)).toBe('workspace:skills/foo-2');
  });
});

describe('合成就近优先', () => {
  const base = (slug: string, key: string): LocalSkill => ({
    canonicalKey: key,
    source: 'user',
    slug,
    name: slug,
    description: `base ${slug}`,
    docPath: `/base/${slug}/SKILL.md`,
    realpath: `/base/${slug}/SKILL.md`,
    content: '',
    rootKind: 'space',
    indexedAt: 0,
  });
  const ws = (slug: string, key: string): LocalSkill => ({
    ...base(slug, key),
    sourceType: 'workspace',
    rootKind: 'workspace',
    workspaceRelPath: `skills/${slug}`,
  });

  it('同 slug 冲突目录版胜出，遮蔽关系可解释', () => {
    const merged = mergeWorkspaceSkillsForRuntime(
      [base('deploy', 'platform:ops/deploy'), base('other', 'user:other')],
      [ws('deploy', 'workspace:skills/deploy')],
    );
    expect(merged.skills.map((s) => s.canonicalKey).sort()).toEqual([
      'user:other',
      'workspace:skills/deploy',
    ]);
    expect(merged.shadowed).toEqual([
      { workspaceKey: 'workspace:skills/deploy', hiddenKey: 'platform:ops/deploy' },
    ]);
  });

  it('目录列表为空时原样返回基座', () => {
    const baseList = [base('a', 'user:a')];
    const merged = mergeWorkspaceSkillsForRuntime(baseList, []);
    expect(merged.skills).toBe(baseList);
    expect(merged.shadowed).toEqual([]);
  });

  it('遮蔽判定唯一出口：merge 结果与 computeWorkspaceShadowing（查看器同源）一致', () => {
    const baseList = [
      base('deploy', 'platform:ops/deploy'),
      base('other', 'user:other'),
    ];
    const wsList = [
      ws('deploy', 'workspace:skills/deploy'),
      ws('deploy', 'workspace:nested/skills/deploy'), // 目录内同 slug：后到被去重
    ];
    const merged = mergeWorkspaceSkillsForRuntime(baseList, wsList);
    const shadowing = computeWorkspaceShadowing(
      baseList.map((s) => ({ canonicalKey: s.canonicalKey, slug: s.slug })),
      wsList.map((s) => ({ canonicalKey: s.canonicalKey, slug: s.slug })),
    );
    // 同一份遮蔽关系
    expect(merged.shadowed).toEqual(shadowing.shadowed);
    // 目录内去重：浅层（先到）胜出，后到进 duplicate 列表且不进合成结果
    expect(shadowing.duplicateWorkspaceKeys).toEqual(['workspace:nested/skills/deploy']);
    expect(merged.skills.map((s) => s.canonicalKey)).not.toContain(
      'workspace:nested/skills/deploy',
    );
    expect(shadowing.workspaceWinnerBySlug.get('deploy')).toBe('workspace:skills/deploy');
  });
});

describe('守卫出口（发现/注入对称性）', () => {
  it('isWorkspaceRootAllowed：边界内（含根本身）允许，边界外拒绝', () => {
    expect(isWorkspaceRootAllowed(root, [root])).toBe(true);
    expect(isWorkspaceRootAllowed(join(root, 'sub/dir'), [root])).toBe(true);
    expect(isWorkspaceRootAllowed('/etc', [root])).toBe(false);
    // 前缀相似但不是子路径（/foo vs /foo-bar）不放行
    expect(isWorkspaceRootAllowed(`${root}-sibling`, [root])).toBe(false);
    expect(isWorkspaceRootAllowed('', [root])).toBe(false);
  });

  it('scanWorkspaceSkillsGuarded：越界返回 null（不扫不缓存），边界内等价于普通扫描', async () => {
    await addSkillDir('skills/alpha', 'alpha');

    const denied = await scanWorkspaceSkillsGuarded('/etc', { allowedRoots: [root] });
    expect(denied).toBeNull();
    expect(getCachedWorkspaceSkills('/etc')).toEqual([]);

    const allowed = await scanWorkspaceSkillsGuarded(root, { allowedRoots: [root] });
    expect(allowed?.skills.map((s) => s.slug)).toEqual(['alpha']);
  });
});
