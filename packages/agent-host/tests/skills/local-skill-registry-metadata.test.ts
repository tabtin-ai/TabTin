import { createLexicalSkillRecall } from '@tabtin/agent-runtime/skills';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOrganizationSkillsDir } from '@tabtin/terminal-core';

import { LocalSkillRegistry } from '../../src/skills/local-skill-registry.js';
import {
  collectAppSources,
  collectPackageSkillSources,
  collectPlatformSources,
  preinstallDefaultSkills,
} from '../../src/skills/skill-preinstaller.js';

const tempRoots: string[] = [];
const USER_ID = 'user-1';
const ORGANIZATION_ID = 'wt-1';

function writeSkill(dir: string, frontmatter: string, body = '# Test Skill\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter.trim()}\n---\n\n${body}`,
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('LocalSkillRegistry rich metadata', () => {
  it('preserves SKILL.md frontmatter metadata for local list surfaces', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'tabtin-skills-'));
    tempRoots.push(dataRoot);

    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const skillDir = path.join(skillsRoot, 'phone-operator');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, '.skill-meta.json'),
      JSON.stringify({ source: 'app', appId: 'tabphone' }),
    );
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
slug: phone-operator
name: Phone Operator
description: Operate phones from Tin.
version: 0.1.0
tags:
  - device
  - automation
x-tabtin-apps:
  - tabphone
requires:
  bins:
    - adb
install:
  - id: android-platform-tools
    kind: brew
    formula: android-platform-tools
    bins:
      - adb
os_filter:
  - darwin
  - linux
agents:
  - filename: phone-agent.md
    name: Phone Agent
emoji: ":phone:"
homepage: https://tabtin.example/phone
always: true
---

# Phone Operator
`,
    );

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });

    await registry.ready();
    const skills = registry.listForSpace('sp-1');

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      canonicalKey: 'app:tabphone/phone-operator',
      source: 'app',
      appId: 'tabphone',
      tags: ['device', 'automation'],
      xTabtinApps: ['tabphone'],
      requires: { bins: ['adb'] },
      install: [
        expect.objectContaining({
          id: 'android-platform-tools',
          kind: 'brew',
          bins: ['adb'],
        }),
      ],
      osFilter: ['darwin', 'linux'],
      agents: [
        expect.objectContaining({
          filename: 'phone-agent.md',
          name: 'Phone Agent',
        }),
      ],
      emoji: ':phone:',
      homepage: 'https://tabtin.example/phone',
      always: true,
    });
  });

  it('preinstalls same-slug platform skills without overwriting canonical keys', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-platform-skills-'));
    tempRoots.push(root);

    const bundledRoot = path.join(root, 'bundled');
    for (const domain of ['device', 'mcp', 'tabslide']) {
      writeSkill(
        path.join(bundledRoot, 'platform', domain, 'operations'),
        `
name: ${domain}-operations
description: ${domain} operations
version: 0.1.0
`,
      );
    }

    const dataRoot = path.join(root, 'data-root');
    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const sources = await collectPlatformSources(bundledRoot);

    expect(sources.map(s => s.installSlug).sort()).toEqual([
      'device-operations',
      'mcp-operations',
      'tabslide-operations',
    ]);

    const result = await preinstallDefaultSkills(skillsRoot, sources);
    expect(result).toMatchObject({ installed: 3, skipped: 0, errors: [] });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    const skills = registry.listForSpace('sp-1');
    expect(skills.map(s => s.canonicalKey).sort()).toEqual([
      'platform:device/operations',
      'platform:mcp/operations',
      'platform:tabslide/operations',
    ]);
    expect(skills.map(s => path.basename(path.dirname(s.docPath))).sort()).toEqual([
      'device-operations',
      'mcp-operations',
      'tabslide-operations',
    ]);
  });

  it('upgrades same-hash builtin skills when source metadata changes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-skill-source-migrate-'));
    tempRoots.push(root);

    const bundledRoot = path.join(root, 'bundled');
    const appsRoot = path.join(root, 'apps');
    const skillFrontmatter = `
name: html-spec
description: TabSlide HTML spec
version: 0.1.0
`;
    writeSkill(
      path.join(bundledRoot, 'platform', 'tabslide', 'html-spec'),
      skillFrontmatter,
    );
    writeSkill(
      path.join(appsRoot, 'tabslide', 'skills', 'html-spec'),
      skillFrontmatter,
    );

    const dataRoot = path.join(root, 'data-root');
    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);

    const platformSources = await collectPlatformSources(bundledRoot);
    expect(await preinstallDefaultSkills(skillsRoot, platformSources)).toMatchObject({
      installed: 1,
      skipped: 0,
      errors: [],
    });

    const appSources = await collectAppSources(appsRoot);
    expect(await preinstallDefaultSkills(skillsRoot, appSources)).toMatchObject({
      installed: 1,
      skipped: 0,
      errors: [],
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    expect(registry.getByKey('app:tabslide/html-spec')).toBeTruthy();
    expect(registry.getByKey('platform:tabslide/html-spec')).toBeUndefined();
  });

  it('does not preinstall skills for default-disabled builtin apps', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-disabled-app-skill-'));
    tempRoots.push(root);

    const appsRoot = path.join(root, 'apps');
    const appDir = path.join(appsRoot, 'tabslide');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, 'app.json'),
      JSON.stringify({
        id: 'tabslide',
        distribution: 'builtin',
        catalog: { isDefaultEnabled: false },
      }),
      'utf-8',
    );
    writeSkill(
      path.join(appDir, 'skills', 'html-spec'),
      `
name: html-spec
description: TabSlide HTML spec
version: 0.1.0
`,
    );

    const dataRoot = path.join(root, 'data-root');
    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const staleSkillDir = path.join(skillsRoot, 'tabslide-html-spec');
    mkdirSync(staleSkillDir, { recursive: true });
    writeFileSync(
      path.join(staleSkillDir, '.skill-meta.json'),
      JSON.stringify({
        source: 'app',
        slug: 'html-spec',
        installSlug: 'tabslide-html-spec',
        canonicalKey: 'app:tabslide/html-spec',
        appId: 'tabslide',
        sourceContentHash: 'old-hash',
      }),
      'utf-8',
    );
    writeSkill(
      staleSkillDir,
      `
name: html-spec
description: stale
version: 0.1.0
`,
    );

    const appSources = await collectAppSources(appsRoot);
    expect(appSources).toEqual([]);
    const result = await preinstallDefaultSkills(skillsRoot, appSources);
    expect(result).toMatchObject({ installed: 0, skipped: 0, removed: 1, errors: [] });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    expect(registry.getByKey('app:tabslide/html-spec')).toBeUndefined();
  });

  it('uses legacy preinstalled directory name as canonical slug when meta slug is absent', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'tabtin-legacy-platform-skill-'));
    tempRoots.push(dataRoot);

    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const skillDir = path.join(skillsRoot, 'operations');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, '.skill-meta.json'),
      JSON.stringify({ source: 'platform', domain: 'device' }),
    );
    writeSkill(
      skillDir,
      `
name: device-operations
description: Device operations.
version: 0.1.0
`,
    );

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    const skills = registry.listForSpace('sp-1');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      canonicalKey: 'platform:device/operations',
      source: 'platform',
      appId: 'device',
      slug: 'operations',
    });
  });

  it('keeps app canonical slug stable when install directory is prefixed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-app-skills-'));
    tempRoots.push(root);

    const appsRoot = path.join(root, 'apps');
    writeSkill(
      path.join(appsRoot, 'tabdoc', 'skills', 'tabdoc-operator'),
      `
name: TabDoc Operator
description: Create and edit docs.
version: 1.0.0
`,
    );

    const dataRoot = path.join(root, 'data-root');
    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const sources = await collectAppSources(appsRoot);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      slug: 'tabdoc-operator',
      installSlug: 'tabdoc-tabdoc-operator',
      source: 'app',
      appId: 'tabdoc',
    });

    const result = await preinstallDefaultSkills(skillsRoot, sources);
    expect(result).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    const skills = registry.listForSpace('sp-1');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      canonicalKey: 'app:tabdoc/tabdoc-operator',
      source: 'app',
      appId: 'tabdoc',
      slug: 'tabdoc-operator',
    });
    expect(path.basename(path.dirname(skills[0].docPath))).toBe('tabdoc-tabdoc-operator');
  });

  it('does not preinstall marketplace app skills as built-in app skills', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-marketplace-app-skills-'));
    tempRoots.push(root);

    const appsRoot = path.join(root, 'apps');
    const builtinApp = path.join(appsRoot, 'tabdoc');
    const marketplaceApp = path.join(appsRoot, 'office-pack');

    mkdirSync(builtinApp, { recursive: true });
    writeFileSync(
      path.join(builtinApp, 'app.json'),
      JSON.stringify({ id: 'tabdoc', distribution: 'builtin' }),
      'utf8',
    );
    writeSkill(
      path.join(builtinApp, 'skills', 'tabdoc-operator'),
      `
name: TabDoc Operator
description: Create and edit docs.
version: 1.0.0
`,
    );

    mkdirSync(marketplaceApp, { recursive: true });
    writeFileSync(
      path.join(marketplaceApp, 'app.json'),
      JSON.stringify({ id: 'office-pack', distribution: 'marketplace' }),
      'utf8',
    );
    writeSkill(
      path.join(marketplaceApp, 'skills', 'meeting-notes-to-actions'),
      `
name: Meeting Notes
description: Convert meetings into notes and actions.
version: 1.0.0
`,
    );

    const sources = await collectAppSources(appsRoot);

    expect(sources.map(source => source.appId)).toEqual(['tabdoc']);
    expect(sources.map(source => source.slug)).toEqual(['tabdoc-operator']);
  });

  it('preinstalls first-party starter packs even when labeled marketplace', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-starter-pack-skills-'));
    tempRoots.push(root);

    const appsRoot = path.join(root, 'apps');
    const starterPack = path.join(appsRoot, 'tabtin-workflow-skills-pack');
    const marketPack = path.join(appsRoot, 'office-pack');

    mkdirSync(starterPack, { recursive: true });
    writeFileSync(
      path.join(starterPack, 'app.json'),
      JSON.stringify({
        id: 'tabtin-workflow-skills-pack',
        distribution: 'marketplace',
        catalog: { isDefaultEnabled: false },
      }),
      'utf8',
    );
    writeSkill(
      path.join(starterPack, 'skills', 'grill-before-build'),
      `
name: Grill Before Build
description: Ask before building.
version: 1.0.0
`,
    );

    mkdirSync(marketPack, { recursive: true });
    writeFileSync(
      path.join(marketPack, 'app.json'),
      JSON.stringify({ id: 'office-pack', distribution: 'marketplace' }),
      'utf8',
    );
    writeSkill(
      path.join(marketPack, 'skills', 'meeting-notes-to-actions'),
      `
name: Meeting Notes
description: Convert meetings into notes and actions.
version: 1.0.0
`,
    );

    const sources = await collectAppSources(appsRoot);

    expect(sources.map(source => source.appId)).toEqual(['tabtin-workflow-skills-pack']);
    expect(sources.map(source => source.slug)).toEqual(['grill-before-build']);
  });

  it('collects standalone package skills as first-party app skills', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tabtin-package-skills-'));
    tempRoots.push(root);

    const skillsRoot = path.join(root, 'skills');
    writeSkill(
      path.join(skillsRoot, 'tabtracker'),
      `
name: tabtracker
description: Manage scheduled trackers.
version: 0.2.0
`,
    );
    writeSkill(
      path.join(skillsRoot, 'bundled', 'platform', 'device', 'operations'),
      `
name: device-operations
description: Device operations.
version: 0.1.0
`,
    );

    const dataRoot = path.join(root, 'data-root');
    const targetRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const sources = await collectPackageSkillSources(skillsRoot);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      slug: 'tabtracker',
      installSlug: 'tabtracker-tabtracker',
      source: 'app',
      appId: 'tabtracker',
    });

    const result = await preinstallDefaultSkills(targetRoot, sources);
    expect(result).toMatchObject({ installed: 1, skipped: 0, errors: [] });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    const skills = registry.listForSpace('sp-1');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      canonicalKey: 'app:tabtracker/tabtracker',
      source: 'app',
      appId: 'tabtracker',
      slug: 'tabtracker',
    });
  });

  it('indexes colliding user imports by directory slug, not frontmatter name', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'tabtin-skill-collision-'));
    tempRoots.push(dataRoot);

    const skillsRoot = resolveOrganizationSkillsDir(dataRoot, USER_ID, ORGANIZATION_ID);
    const sharedFrontmatter = `
name: algorithmic-art
description: Creating algorithmic art with p5.js
`;
    writeSkill(path.join(skillsRoot, 'algorithmic-art'), sharedFrontmatter);
    writeSkill(path.join(skillsRoot, 'algorithmic-art-2'), sharedFrontmatter);

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(),
      env: { dataRoot, userId: USER_ID },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await registry.ready();

    const skills = registry.listForSpace('sp-1');
    expect(skills.map((s) => s.canonicalKey).sort()).toEqual([
      'user:algorithmic-art',
      'user:algorithmic-art-2',
    ]);
    expect(registry.getByKey('user:algorithmic-art-2')?.slug)
      .toBe('algorithmic-art-2');
  });
});
