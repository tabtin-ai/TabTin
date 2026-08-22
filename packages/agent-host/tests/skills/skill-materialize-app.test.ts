/**
 * marketplace 分发 app skill 的按需本地物化（ app 子案）。
 *
 * 背景：`collectAppSources` 刻意把 `distribution==='marketplace'` 的 app skill 排除出
 * 默认预装（"等用户安装时再落盘"）。此前客户端 enable 链路只给 user+package_id 技能
 * 落盘，于是商店里的 app 技能点安装后本地没文件 → `LocalSkillRegistry` 扫不到 →
 * Agent `<skills>` 看不到。本测试锁死修复后的闭环：
 *
 *   bundled 源（appsRoot/<appId>/skills/<slug>/SKILL.md）
 *     → initSkillsModule({ dataRoot }).materializeAppSkill(...)
 *     → 拷进 {dataRoot}/users/{userId}/organizations/{orgId}/skills/<appId>-<slug>/
 *     → registry.getByKey('app:<appId>/<slug>') 立即可见
 *
 * 同时锁死安全红线：物化单个 app skill **不得**误删同目录其它内置 skill
 * （不走 preinstallDefaultSkills 的孤儿清理）。
 *
 * （硬切）：老布局 (spaceId + platformDataRoot) 已彻底移除，本测试
 * 统一走 dataRoot + userId。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOrganizationSkillsDir } from '@tabtin/terminal-core';
import {
  initSkillsModule,
  disposeSkillsModule,
  installSkillSource,
} from '../../src/skills/index.js';
import {
  isFirstPartyStarterPackAppId,
  parseAppSkillCanonicalKey,
  selectAppSkillsToReconcile,
  createLexicalSkillRecall,
} from '@tabtin/agent-runtime/skills';

const tempRoots: string[] = [];

afterEach(async () => {
  await disposeSkillsModule();
  for (const r of tempRoots.splice(0)) {
    await fsp.rm(r, { recursive: true, force: true });
  }
});

function skillMd(name: string, desc: string): string {
  return `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  version: 0.1.0\n---\n# ${name}\nbody\n`;
}

async function makeAppSource(
  appsRoot: string,
  appId: string,
  slug: string,
): Promise<void> {
  const dir = path.join(appsRoot, appId, 'skills', slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), skillMd(slug, `${slug} desc`), 'utf-8');
}

async function mkTempRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('materializeAppSkill — 商店 app 技能按需物化', () => {
  it('把 bundled app skill 拷进组织 skills 目录并让 registry 立即可见', async () => {
    const dataRoot = await mkTempRoot('tabtin-mat-dr-');
    const appsRoot = await mkTempRoot('tabtin-mat-apps-');
    const userId = 'user-1';
    const organizationId = 'wt-1';
    await makeAppSource(appsRoot, 'demoapp', 'demo-skill');

    const mod = await initSkillsModule({ dataRoot, userId, appsRoot, skillRecall: createLexicalSkillRecall() });
    await mod.ready();

    const result = await mod.materializeAppSkill({
      organizationId,
      userId,
      appId: 'demoapp',
      slug: 'demo-skill',
    });
    expect(result.installed).toBe(1);

    // 文件落到 users/{userId}/organizations/{orgId}/skills/demoapp-demo-skill/SKILL.md
    const skillsDir = resolveOrganizationSkillsDir(dataRoot, userId, organizationId);
    const md = path.join(skillsDir, 'demoapp-demo-skill', 'SKILL.md');
    await expect(fsp.access(md)).resolves.toBeUndefined();

    // registry 立即可见（不等 watcher debounce）
    const skill = mod.registry.getByKey('app:demoapp/demo-skill');
    expect(skill).toBeDefined();
    expect(skill?.canonicalKey).toBe('app:demoapp/demo-skill');
    expect(skill?.metaSource).toBe('app');
    expect(skill?.organizationId).toBe(organizationId);
  });

  it('bundled 源不存在时抛错（调用方据此回滚后端 enable）', async () => {
    const dataRoot = await mkTempRoot('tabtin-mat-dr-');
    const appsRoot = await mkTempRoot('tabtin-mat-apps-');
    const mod = await initSkillsModule({ dataRoot, userId: 'user-1', appsRoot, skillRecall: createLexicalSkillRecall() });
    await mod.ready();

    await expect(
      mod.materializeAppSkill({
        organizationId: 'wt-1',
        userId: 'user-1',
        appId: 'nope',
        slug: 'missing',
      }),
    ).rejects.toThrow(/未找到.*bundled/);
  });

  it('缺 organizationId / appId / slug 抛错', async () => {
    const dataRoot = await mkTempRoot('tabtin-mat-dr-');
    const appsRoot = await mkTempRoot('tabtin-mat-apps-');
    const mod = await initSkillsModule({ dataRoot, userId: 'user-1', appsRoot, skillRecall: createLexicalSkillRecall() });
    await mod.ready();

    await expect(
      mod.materializeAppSkill({ organizationId: '', userId: 'user-1', appId: 'a', slug: 's' }),
    ).rejects.toThrow(/必填/);
  });

  it('缺 userId + dataRoot 时抛错（ 硬切已移除老布局）', async () => {
    const dataRoot = await mkTempRoot('tabtin-mat-dr-');
    const appsRoot = await mkTempRoot('tabtin-mat-apps-');
    const mod = await initSkillsModule({ dataRoot, userId: 'user-1', appsRoot, skillRecall: createLexicalSkillRecall() });
    await mod.ready();

    await expect(
      mod.materializeAppSkill({ organizationId: 'wt-1', appId: 'a', slug: 's' }),
    ).rejects.toThrow(/需要 \(userId \+ dataRoot\)/);
  });
});

describe('isFirstPartyStarterPackAppId — 首发起步包预装白名单', () => {
  it('收录工作流 / 工程纪律 / Ponytail，排除已下线远程包和普通市场包', () => {
    expect(isFirstPartyStarterPackAppId('tabtin-workflow-skills-pack')).toBe(true);
    expect(isFirstPartyStarterPackAppId('tabtin-engineering-discipline-pack')).toBe(true);
    expect(isFirstPartyStarterPackAppId('ponytail')).toBe(true);
    expect(isFirstPartyStarterPackAppId('tabtin-document-ai-pack')).toBe(false);
    expect(isFirstPartyStarterPackAppId('tabtin-data-ai-pack')).toBe(false);
    expect(isFirstPartyStarterPackAppId('office-pack')).toBe(false);
    expect(isFirstPartyStarterPackAppId('tabslide')).toBe(false);
  });
});

describe('parseAppSkillCanonicalKey — 回补协调解析 app key', () => {
  it('解析 app:<appId>/<slug>', () => {
    expect(parseAppSkillCanonicalKey('app:tabdesktop/desktop-operator')).toEqual({
      appId: 'tabdesktop',
      slug: 'desktop-operator',
    });
  });

  it('非 app 前缀 / 无斜杠段 / 越界 → null', () => {
    expect(parseAppSkillCanonicalKey('user:test')).toBeNull();
    expect(parseAppSkillCanonicalKey('platform:device/operations')).toBeNull();
    expect(parseAppSkillCanonicalKey('app:noskill')).toBeNull();
    expect(parseAppSkillCanonicalKey('app:/slug')).toBeNull();
    expect(parseAppSkillCanonicalKey('app:appid/')).toBeNull();
    expect(parseAppSkillCanonicalKey('app:../evil/x')).toBeNull();
  });
});

describe('selectAppSkillsToReconcile — 回补协调纯 diff', () => {
  it('挑出「已启用 app 且本地缺失」的坐标；本地已有 / 非 app / 停用 / 非法 key 全跳过', () => {
    const visible = [
      { skill_key: 'app:tabdesktop/desktop-operator', source: 'app', enabled: true }, // 缺失 → 选
      { skill_key: 'app:tabweb/browser-operator', source: 'app', enabled: true },      // 本地已有 → 跳
      { skill_key: 'app:foo/disabled-skill', source: 'app', enabled: false },          // 停用 → 跳
      { skill_key: 'platform:device/operations', source: 'platform', enabled: true },  // 非 app → 跳
      { skill_key: 'user:test', source: 'user', enabled: true },                       // 非 app → 跳
      { skill_key: 'app:noslash', source: 'app', enabled: true },                      // 非法 key → 跳
      { source: 'app', enabled: true },                                                // 无 key → 跳
    ];
    const localKeys = new Set(['app:tabweb/browser-operator']);
    const result = selectAppSkillsToReconcile(visible, localKeys);
    expect(result).toEqual([
      { key: 'app:tabdesktop/desktop-operator', appId: 'tabdesktop', slug: 'desktop-operator' },
    ]);
  });

  it('enabled 缺省（undefined）视为启用；重复 key 去重', () => {
    const visible = [
      { skill_key: 'app:a/x', source: 'app' },
      { skill_key: 'app:a/x', source: 'app', enabled: true },
    ];
    const result = selectAppSkillsToReconcile(visible, new Set());
    expect(result).toEqual([{ key: 'app:a/x', appId: 'a', slug: 'x' }]);
  });

  it('兼容 Agent 携带集的 skill_canonical_key 字段', () => {
    const carried = [{
      skill_canonical_key: 'app:tabtin-document-ai-pack/ppt-master',
      source: 'app',
      enabled: true,
    }];
    const result = selectAppSkillsToReconcile(carried, new Set());
    expect(result).toEqual([{
      key: 'app:tabtin-document-ai-pack/ppt-master',
      appId: 'tabtin-document-ai-pack',
      slug: 'ppt-master',
    }]);
  });
});

describe('installSkillSource — 单条物化不做孤儿清理（安全红线）', () => {
  it('物化一个 skill 不会误删同目录其它内置 skill', async () => {
    const targetDir = await mkTempRoot('tabtin-mat-target-');
    const appsRoot = await mkTempRoot('tabtin-mat-src-');
    // 目录里先放一个「别的内置 skill 的当前目录」
    const siblingDir = path.join(targetDir, 'otherapp-other-skill');
    await fsp.mkdir(siblingDir, { recursive: true });
    await fsp.writeFile(path.join(siblingDir, 'SKILL.md'), skillMd('other', 'other'), 'utf-8');
    await fsp.writeFile(
      path.join(siblingDir, '.skill-meta.json'),
      JSON.stringify({ source: 'app', appId: 'otherapp', slug: 'other-skill', canonicalKey: 'app:otherapp/other-skill' }),
      'utf-8',
    );

    // 物化一个全新的 app skill
    await makeAppSource(appsRoot, 'newapp', 'new-skill');
    const result = await installSkillSource(targetDir, {
      sourceDir: path.join(appsRoot, 'newapp', 'skills', 'new-skill'),
      slug: 'new-skill',
      installSlug: 'newapp-new-skill',
      source: 'app',
      appId: 'newapp',
    });

    expect(result.installed).toBe(1);
    expect(result.removed).toBe(0);
    // 新 skill 落盘
    await expect(
      fsp.access(path.join(targetDir, 'newapp-new-skill', 'SKILL.md')),
    ).resolves.toBeUndefined();
    // 旧的兄弟内置目录**没被删**（installSkillSource 不做孤儿清理）
    await expect(
      fsp.access(path.join(siblingDir, 'SKILL.md')),
    ).resolves.toBeUndefined();
  });
});
