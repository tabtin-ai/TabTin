import { createLexicalSkillRecall } from '@tabtin/agent-runtime/skills';
/**
 * 内置 skill「单份共享 + 全局可见」去重复用测试。
 *
 * 覆盖两层：
 * 1. `removeBuiltinCopiesFromSpace`（迁移）：只删 platform/app 内置副本，user skill 保留；
 * 2. 共享 registry 归属：`scope='shared'` 的内置 skill registryKey 不带 spaceId、
 *    对任意 organization 都能看到（全局可见）——即「一份共享、去重」。
 *
 * （硬切）：老 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/`
 * 双层扫描已移除，第二个 describe 块统一走 dataRoot + userId + organizationIds
 * 新布局；遗留未迁移 `scope='space'` 根的去重分支改用 `addScanRoot` 手动挂载覆盖
 * （不再依赖 scanner 自动发现该老布局）。
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOrganizationSkillsDir } from '@tabtin/terminal-core';

import { removeBuiltinCopiesFromSpace } from '../../src/skills/skill-preinstaller.js';
import { LocalSkillRegistry } from '../../src/skills/local-skill-registry.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function skillMd(name: string): string {
  return `---
name: ${name}
description: ${name} description
metadata:
  version: 0.1.0
---
# ${name}
body
`;
}

function seedSkill(
  dir: string,
  name: string,
  meta: object | null,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name));
  if (meta) writeFileSync(path.join(dir, '.skill-meta.json'), JSON.stringify(meta, null, 2));
}

describe('removeBuiltinCopiesFromSpace（迁移：只删内置副本）', () => {
  it('删 platform/app 内置副本，保留 user skill 与无 meta 目录', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-shared-mig-'));
    tempRoots.push(root);
    const spaceSkills = path.join(root, 'skills');

    seedSkill(path.join(spaceSkills, 'device-operations'), 'ops', {
      source: 'platform',
      domain: 'device',
      slug: 'operations',
      canonicalKey: 'platform:device/operations',
    });
    seedSkill(path.join(spaceSkills, 'tabdoc-tabdoc-operator'), 'doc', {
      source: 'app',
      appId: 'tabdoc',
      slug: 'tabdoc-operator',
      canonicalKey: 'app:tabdoc/tabdoc-operator',
    });
    seedSkill(path.join(spaceSkills, 'my-user-skill'), 'mine', {
      source: 'user',
      slug: 'my-user-skill',
    });
    seedSkill(path.join(spaceSkills, 'no-meta-skill'), 'nometa', null);

    const r = await removeBuiltinCopiesFromSpace(spaceSkills);

    expect(r.removed).toBe(2); // 两个内置副本
    expect(r.errors).toEqual([]);
    expect(existsSync(path.join(spaceSkills, 'device-operations'))).toBe(false);
    expect(existsSync(path.join(spaceSkills, 'tabdoc-tabdoc-operator'))).toBe(false);
    // user / 无 meta 一律保留
    expect(existsSync(path.join(spaceSkills, 'my-user-skill'))).toBe(true);
    expect(existsSync(path.join(spaceSkills, 'no-meta-skill'))).toBe(true);
  });

  it('目录不存在 → no-op 不报错', async () => {
    const r = await removeBuiltinCopiesFromSpace('/nonexistent/skills/dir');
    expect(r).toEqual({ removed: 0, errors: [] });
  });
});

describe('共享内置 registry 归属（scope=shared 全局可见 + 去重）', () => {
  it('shared 内置对任意 organization 可见，且 registryKey 不带 spaceId（单份）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-shared-reg-'));
    tempRoots.push(root);

    // 共享store：一份内置 platform skill
    const sharedDir = path.join(root, '_shared-skills');
    seedSkill(path.join(sharedDir, 'device-operations'), 'ops', {
      source: 'platform',
      domain: 'device',
      slug: 'operations',
      canonicalKey: 'platform:device/operations',
    });

    // dataRoot/users/{userId}/organizations/<org>/skills 各放一个 user skill
    const dataRoot = path.join(root, 'data-root');
    const userId = 'user-1';
    const orgA = 'org-A';
    const orgB = 'org-B';
    const mkOrgUserSkill = (orgId: string, slug: string) => {
      const dir = path.join(resolveOrganizationSkillsDir(dataRoot, userId, orgId), slug);
      seedSkill(dir, slug, { source: 'user', slug });
    };
    mkOrgUserSkill(orgA, 'user-a');
    mkOrgUserSkill(orgB, 'user-b');

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId, organizationIds: [orgA, orgB], sharedBuiltinRoot: sharedDir },
    });
    await registry.ready();

    const all = registry.listAll();
    // 共享内置只有一条（不随 organization 复制）
    const builtins = all.filter((s) => s.canonicalKey === 'platform:device/operations');
    expect(builtins).toHaveLength(1);
    expect(builtins[0]!.scope).toBe('shared');

    // 两个 organization 各自都能看到共享内置 + 自己的 user skill，且互不串
    const aKeys = registry.listForSpace('unused', { organizationId: orgA }).map((s) => s.canonicalKey).sort();
    const bKeys = registry.listForSpace('unused', { organizationId: orgB }).map((s) => s.canonicalKey).sort();
    expect(aKeys).toContain('platform:device/operations');
    expect(bKeys).toContain('platform:device/operations');
    expect(aKeys).toContain('user:user-a');
    expect(aKeys).not.toContain('user:user-b');
    expect(bKeys).toContain('user:user-b');
    expect(bKeys).not.toContain('user:user-a');
  });

  it('启用共享store后，未迁移遗留 space 根里的 per-space 内置副本被内存忽略（去重即时生效）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-shared-skip-'));
    tempRoots.push(root);

    // 共享store一份内置
    const sharedDir = path.join(root, '_shared-skills');
    seedSkill(path.join(sharedDir, 'device-operations'), 'ops', {
      source: 'platform',
      domain: 'device',
      slug: 'operations',
      canonicalKey: 'platform:device/operations',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { sharedBuiltinRoot: sharedDir },
    });
    await registry.ready();

    // （硬切）：scanner 不再自动发现老 `.../spaces/{sp}/skills/` 根，
    // 用 addScanRoot 手动挂载模拟「历史遗留、尚未迁移」的场景——仍应覆盖
    // tryIngest 里 scope='space' 的共享去重分支。
    const legacySpaceSkills = path.join(root, 'legacy-space-skills');
    seedSkill(path.join(legacySpaceSkills, 'device-operations'), 'ops', {
      source: 'platform',
      domain: 'device',
      slug: 'operations',
      canonicalKey: 'platform:device/operations',
    });
    seedSkill(path.join(legacySpaceSkills, 'user-a'), 'user-a', { source: 'user', slug: 'user-a' });
    await registry.addScanRoot({
      kind: 'space',
      path: legacySpaceSkills,
      organizationId: 'org-1',
      spaceId: 'space-A',
    });

    // 内置只有共享那一条（scope=shared），legacy space 副本被忽略
    const builtins = registry
      .listAll()
      .filter((s) => s.canonicalKey === 'platform:device/operations');
    expect(builtins).toHaveLength(1);
    expect(builtins[0]!.scope).toBe('shared');
    // user skill 仍在
    expect(registry.listForSpace('space-A').map((s) => s.canonicalKey)).toContain('user:user-a');
  });

  it('启动首扫拿到半截 shared catalog 时，ready guard 会重扫 shared root 补齐', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-shared-ready-'));
    tempRoots.push(root);

    const sharedDir = path.join(root, '_shared-skills');
    seedSkill(path.join(sharedDir, 'tabdata-table-association'), 'table-association', {
      source: 'app',
      appId: 'tabdata',
      slug: 'table-association',
      canonicalKey: 'app:tabdata/table-association',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { sharedBuiltinRoot: sharedDir },
    });
    await registry.ready();

    expect(registry.listAll().map((s) => s.canonicalKey)).toEqual([
      'app:tabdata/table-association',
    ]);

    // 模拟启动首扫期间目录视图不完整；ready 后磁盘实际已经补齐。
    seedSkill(path.join(sharedDir, 'tabfiles-tabfiles-operator'), 'tabfiles-operator', {
      source: 'app',
      appId: 'tabfiles',
      slug: 'tabfiles-operator',
      canonicalKey: 'app:tabfiles/tabfiles-operator',
    });

    await expect(
      registry.ensureSharedBuiltinCatalogReady({
        expectedCount: 2,
        rootPath: sharedDir,
        attempts: 1,
        delayMs: 0,
      }),
    ).resolves.toBe(2);

    expect(registry.listAll().map((s) => s.canonicalKey).sort()).toEqual([
      'app:tabdata/table-association',
      'app:tabfiles/tabfiles-operator',
    ]);
  });
});
