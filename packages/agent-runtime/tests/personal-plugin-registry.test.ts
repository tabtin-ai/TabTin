import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveOrganizationPluginDir,
  resolveOrganizationPluginRegistryFile,
} from '@tabtin/terminal-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  approvePersonalPluginGithubInstall,
  approvePersonalPluginGithubUpdate,
  checkPersonalPluginGithubUpdate,
  installPersonalPluginFromCodexDirectory,
  listPersonalPluginEnablement,
  listInstalledPersonalPlugins,
  parseCodexPluginCapabilityManifest,
  previewPersonalPluginGithubInstall,
  setPersonalPluginEnabled,
  type PersonalPluginGitHubDownloadAdapter,
} from '../src/plugins/index.js';
import {
  loadEnabledPersonalPluginSkillSnapshot,
  searchRuntimeSkills,
} from '../src/skills/index.js';
import { renderSkillsBlock } from '../src/skills/skill-renderer.js';

const tempRoots: string[] = [];
const BUNDLED_SUPERPOWERS_FIXTURE = path.resolve(
  __dirname,
  '../fixtures/personal-plugins/superpowers',
);
const SUPERPOWERS_SKILL_IDS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans',
  'writing-skills',
];

// （硬切）：Personal Plugin 存储唯一布局是
// `{dataRoot}/users/{userId}/organizations/{orgId}/plugins/`，测试统一走
// dataRoot + userId，不再构造 legacy `platformDataRoot` + spaceId 目录。
const USER_ID = 'user-1';
const ORGANIZATION_ID = 'org-1';

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf-8');
}

function writeSkill(packageRoot: string, slug: string, description: string): void {
  writeText(
    path.join(packageRoot, 'skills', slug, 'SKILL.md'),
    `---
name: ${slug}
description: ${description}
version: 1.0.0
---

# ${slug}
`,
  );
}

function createSuperpowersLikePackage(root: string): string {
  const pkg = path.join(root, 'superpowers-like');
  writeJson(path.join(pkg, '.codex-plugin', 'plugin.json'), {
    id: 'superpowers-like',
    name: 'Superpowers Like',
    description: 'A skill bundle with multiple agent powers.',
    version: '2026.06.22',
  });
  writeSkill(pkg, 'brainstorm', 'Generate options before acting.');
  writeSkill(pkg, 'write-plan', 'Turn ideas into an implementation plan.');
  writeText(path.join(pkg, 'assets', 'logo.svg'), '<svg />');
  return pkg;
}

function createCowartLikePackage(root: string): string {
  const pkg = path.join(root, 'cowart-like');
  writeJson(path.join(pkg, '.codex-plugin', 'plugin.json'), {
    id: 'cowart',
    name: 'Cowart',
    version: '0.4.1',
    localServices: [{ id: 'preview-server', command: 'pnpm preview' }],
    apps: [{ id: 'tabdoc' }],
  });
  writeSkill(pkg, 'cowart-open-canvas', 'Open the local tldraw canvas service.');
  writeSkill(pkg, 'cowart-image-gen', 'Generate images for the canvas.');
  writeSkill(pkg, 'cowart-image-edit', 'Edit existing canvas images.');
  writeJson(path.join(pkg, '.mcp.json'), {
    mcpServers: {
      filesystem: { command: 'node', args: ['server.js'] },
      browser: { command: 'npx', args: ['@modelcontextprotocol/server-puppeteer'] },
    },
  });
  writeJson(path.join(pkg, 'hooks.json'), {
    hooks: [
      { event: 'BeforeToolUse', command: 'node scripts/hook-would-run.js' },
      { event: 'Stop', command: 'node scripts/summarize.js' },
    ],
  });
  writeText(path.join(pkg, 'scripts', 'check-permission.js'), 'process.exit(0);\n');
  writeText(path.join(pkg, 'scripts', 'hook-would-run.js'), 'throw new Error("must not run");\n');
  writeText(path.join(pkg, 'scripts', 'summarize.js'), 'process.exit(0);\n');
  writeText(path.join(pkg, 'assets', 'style.css'), 'body { color: black; }\n');
  return pkg;
}

function createCowartScriptServicePackage(root: string): string {
  const pkg = path.join(root, 'cowart-script-service');
  writeJson(path.join(pkg, '.codex-plugin', 'plugin.json'), {
    id: 'cowart',
    name: 'cowart',
    version: '0.1.3',
    description: 'A local infinite canvas for Codex.',
    interface: {
      displayName: 'Cowart',
      capabilities: ['Interactive canvas', 'Local web service', 'Project-local persistence'],
    },
  });
  writeSkill(pkg, 'cowart-open-canvas', 'Open the local tldraw canvas service.');
  writeJson(path.join(pkg, '.mcp.json'), {
    mcpServers: {
      cowart_mcp: {
        command: 'bash',
        args: ['./scripts/start-mcp.sh'],
        cwd: '.',
      },
    },
  });
  writeText(path.join(pkg, 'scripts', 'start-canvas.sh'), '#!/usr/bin/env bash\nnpm run dev -- --host 127.0.0.1 --port "${COWART_PORT:-43217}"\n');
  writeText(path.join(pkg, 'scripts', 'start-mcp.sh'), '#!/usr/bin/env bash\nnode dist/mcp-server.js\n');
  writeText(path.join(pkg, 'assets', 'app-icon.png'), 'fake-png\n');
  return pkg;
}

function fakeGitHubAdapter(sourceDir: string, commit = '1234567890abcdef1234567890abcdef12345678'): PersonalPluginGitHubDownloadAdapter {
  return {
    async checkout(request) {
      const checkoutDir = path.join(request.targetDir, 'repo');
      cpSync(sourceDir, checkoutDir, { recursive: true });
      return {
        checkoutDir,
        resolvedCommit: commit,
        resolvedRef: request.ref ?? 'main',
      };
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Personal Plugin registry and Codex-compatible importer', () => {
  it('parses a Superpowers-like skill bundle without optional files', async () => {
    const root = tempRoot('tabtin-plugin-superpowers-');
    const sourceDir = createSuperpowersLikePackage(root);

    const manifest = await parseCodexPluginCapabilityManifest({
      sourceDir,
      commit: 'abc123',
    });

    expect(manifest).toMatchObject({
      plugin: {
        id: 'superpowers-like',
        name: 'Superpowers Like',
        version: '2026.06.22',
      },
      source: {
        kind: 'codex-compatible-directory',
        commit: 'abc123',
        versionPin: '2026.06.22',
      },
      skills: [
        { id: 'brainstorm', path: 'skills/brainstorm' },
        { id: 'write-plan', path: 'skills/write-plan' },
      ],
      declaredHooks: [],
      scripts: [],
      assets: ['logo.svg'],
      warnings: [],
    });
    expect(manifest.mcp).toBeUndefined();
  });

  it('parses a Cowart-like mixed package and records declared hooks only', async () => {
    const root = tempRoot('tabtin-plugin-cowart-');
    const sourceDir = createCowartLikePackage(root);

    const manifest = await parseCodexPluginCapabilityManifest({
      sourceDir,
      sourceUri: 'git+https://example.test/cowart-like.git',
      versionPin: 'v0.4.1',
      commit: 'def456',
    });

    expect(manifest).toMatchObject({
      plugin: { id: 'cowart', version: '0.4.1' },
      source: {
        uri: 'git+https://example.test/cowart-like.git',
        versionPin: 'v0.4.1',
        commit: 'def456',
      },
      skills: [
        { id: 'cowart-image-edit' },
        { id: 'cowart-image-gen' },
        { id: 'cowart-open-canvas' },
      ],
      mcp: { path: '.mcp.json', serverCount: 2 },
      declaredHooks: [
        {
          event: 'BeforeToolUse',
          command: 'node scripts/hook-would-run.js',
          sourcePath: 'hooks.json',
        },
        {
          event: 'Stop',
          command: 'node scripts/summarize.js',
          sourcePath: 'hooks.json',
        },
      ],
      scripts: ['check-permission.js', 'hook-would-run.js', 'summarize.js'],
      assets: ['style.css'],
      localServices: [{ id: 'preview-server', command: 'pnpm preview' }],
      apps: [{ id: 'tabdoc' }],
    });

    // Slice 1 deliberately exposes declarations only; there is no executable hook API.
    expect(Object.keys(manifest.declaredHooks[0])).toEqual([
      'id',
      'sourcePath',
      'event',
      'command',
      'raw',
    ]);
  });

  it('infers a Cowart canvas local service from the Codex start-canvas script', async () => {
    const root = tempRoot('tabtin-plugin-cowart-script-service-');
    const sourceDir = createCowartScriptServicePackage(root);

    const manifest = await parseCodexPluginCapabilityManifest({
      sourceDir,
      sourceUri: 'https://github.com/zhongerxin/cowart.git',
      commit: '158904616fdf805895119ac39d10f69b953777fc',
    });

    expect(manifest).toMatchObject({
      plugin: { id: 'cowart', version: '0.1.3' },
      scripts: ['start-canvas.sh', 'start-mcp.sh'],
      localServices: [
        {
          id: 'canvas',
          command: 'bash ./scripts/start-canvas.sh',
          url: 'http://127.0.0.1:43217/',
        },
      ],
    });
  });

  it('installs a Personal Plugin under organization dataRoot and writes registry', async () => {
    const root = tempRoot('tabtin-plugin-org-install-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createCowartLikePackage(root);

    const installed = await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      versionPin: 'v0.4.1',
      commit: 'def456',
    });

    const expectedInstallDir = resolveOrganizationPluginDir(
      dataRoot,
      USER_ID,
      ORGANIZATION_ID,
      'cowart',
    );
    expect(installed).toMatchObject({
      pluginId: 'cowart',
      installPath: expectedInstallDir,
      versionPin: 'v0.4.1',
      commit: 'def456',
      capabilityManifest: {
        declaredHooks: [
          expect.objectContaining({ event: 'BeforeToolUse' }),
          expect.objectContaining({ event: 'Stop' }),
        ],
      },
    });
    expect(existsSync(path.join(expectedInstallDir, 'hooks.json'))).toBe(true);
    expect(existsSync(path.join(expectedInstallDir, '.tabtin-plugin-meta.json'))).toBe(true);

    const registryFile = resolveOrganizationPluginRegistryFile(dataRoot, USER_ID, ORGANIZATION_ID);
    const registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(registry).toMatchObject({
      schemaVersion: 1,
      plugins: [
        {
          pluginId: 'cowart',
          installPath: expectedInstallDir,
          capabilityManifest: {
            mcp: { serverCount: 2 },
            declaredHooks: [
              expect.objectContaining({ command: 'node scripts/hook-would-run.js' }),
              expect.objectContaining({ command: 'node scripts/summarize.js' }),
            ],
          },
        },
      ],
    });

    await expect(
      listInstalledPersonalPlugins({ dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).resolves.toHaveLength(1);

    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'cowart',
      enabled: true,
    });
    const snapshot = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'sp-ignored',
    });
    expect(snapshot.enabledPluginIds).toContain('cowart');
  });

  it('installs a Superpowers-like Skill bundle with source, version pin and capability manifest', async () => {
    const root = tempRoot('tabtin-plugin-superpowers-install-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    const installed = await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sourceUri: 'official://tabtin/superpowers',
      versionPin: '2026.06.22',
    });

    expect(installed).toMatchObject({
      pluginId: 'superpowers-like',
      source: {
        uri: 'official://tabtin/superpowers',
        versionPin: '2026.06.22',
      },
      versionPin: '2026.06.22',
      capabilityManifest: {
        plugin: {
          id: 'superpowers-like',
          name: 'Superpowers Like',
          version: '2026.06.22',
        },
        skills: [
          { id: 'brainstorm', path: 'skills/brainstorm' },
          { id: 'write-plan', path: 'skills/write-plan' },
        ],
        declaredHooks: [],
      },
    });

    const registry = await listInstalledPersonalPlugins({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(registry).toHaveLength(1);
    expect(registry[0]?.pluginId).toBe('superpowers-like');
  });

  it('installs the bundled official Superpowers release with the complete upstream skill set', async () => {
    const root = tempRoot('tabtin-plugin-official-superpowers-');
    const dataRoot = path.join(root, 'data');

    const installed = await installPersonalPluginFromCodexDirectory({
      sourceDir: BUNDLED_SUPERPOWERS_FIXTURE,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sourceUri: 'official://tabtin/superpowers',
      versionPin: '2026.06.23',
      upstream: {
        packageName: 'superpowers',
        version: '5.1.3',
        repository: 'https://github.com/obra/superpowers',
        commit: 'superpowers-5.1.3',
      },
      officialRelease: {
        id: 'tabtin-official:superpowers:2026.06.23',
        version: '2026.06.23',
        channel: 'stable',
      },
      adapter: {
        id: 'tabtin-superpowers-adapter',
        version: '0.1.0',
      },
    });

    expect(installed).toMatchObject({
      pluginId: 'superpowers',
      source: {
        uri: 'official://tabtin/superpowers',
        versionPin: '2026.06.23',
      },
      upstream: {
        packageName: 'superpowers',
        version: '5.1.3',
        repository: 'https://github.com/obra/superpowers',
        commit: 'superpowers-5.1.3',
      },
      officialRelease: {
        id: 'tabtin-official:superpowers:2026.06.23',
        version: '2026.06.23',
        channel: 'stable',
      },
      adapter: {
        id: 'tabtin-superpowers-adapter',
        version: '0.1.0',
      },
      capabilityManifest: {
        plugin: {
          id: 'superpowers',
          name: 'superpowers',
          version: '5.1.3',
        },
        assets: expect.arrayContaining(['superpowers-small.svg']),
        declaredHooks: [],
      },
    });
    expect(installed.capabilityManifest.skills.map((skill) => skill.id)).toEqual(SUPERPOWERS_SKILL_IDS);
    expect(installed.capabilityManifest.mcp).toBeUndefined();
    expect(installed.capabilityManifest.scripts).toEqual([]);

    expect(existsSync(path.join(
      installed.installPath,
      'skills/using-superpowers/references/codex-tools.md',
    ))).toBe(true);
    expect(existsSync(path.join(
      installed.installPath,
      'skills/brainstorming/scripts/start-server.sh',
    ))).toBe(true);

    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'superpowers',
      enabled: true,
    });

    const snapshot = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'agent-space-1',
    });
    expect(snapshot.enabledPluginIds).toEqual(['superpowers']);
    expect(snapshot.skills.map((skill) => skill.slug)).toEqual(SUPERPOWERS_SKILL_IDS);
    expect(snapshot.skills.map((skill) => skill.canonicalKey)).toContain('user:test-driven-development');
    expect(snapshot.skills.map((skill) => skill.canonicalKey)).toContain('user:systematic-debugging');
    expect(snapshot.skills.map((skill) => skill.canonicalKey)).toContain('user:requesting-code-review');
    expect(snapshot.skills.map((skill) => skill.canonicalKey)).toContain('user:receiving-code-review');
    const enabledMap = Object.fromEntries(
      snapshot.skills.map((skill) => [skill.canonicalKey, true] as const),
    );
    expect(renderSkillsBlock(snapshot.skills, {
      spaceId: 'agent-space-1',
      organizationId: ORGANIZATION_ID,
      enabledMap,
    })).toContain('user:writing-plans');

    expect(searchRuntimeSkills(snapshot.skills, 'plans').map((skill) => skill.slug)).toContain('writing-plans');
    expect(searchRuntimeSkills(snapshot.skills, 'test').map((skill) => skill.slug)).toContain('test-driven-development');
    expect(searchRuntimeSkills(snapshot.skills, 'debugging').map((skill) => skill.slug)).toContain('systematic-debugging');
    expect(searchRuntimeSkills(snapshot.skills, 'review').map((skill) => skill.slug)).toEqual(expect.arrayContaining([
      'receiving-code-review',
      'requesting-code-review',
    ]));
  });

  it('reinstalling the same Personal Plugin replaces the registry record without duplication', async () => {
    const root = tempRoot('tabtin-plugin-idempotent-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      versionPin: '2026.06.22',
    });
    await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      versionPin: '2026.06.22',
    });

    const registry = await listInstalledPersonalPlugins({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(registry).toHaveLength(1);
    expect(existsSync(path.join(registry[0]!.installPath, '.tabtin-plugin-meta.json'))).toBe(true);
  });

  it('rejects unsafe organization and userId segments before resolving plugin storage paths', async () => {
    const root = tempRoot('tabtin-plugin-unsafe-segment-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    await expect(
      installPersonalPluginFromCodexDirectory({
        sourceDir,
        dataRoot,
        userId: USER_ID,
        organizationId: '../org-1',
      }),
    ).rejects.toThrow(/Invalid organizationId/);

    await expect(
      listInstalledPersonalPlugins({
        dataRoot,
        userId: '../user-1',
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow(/Invalid userId/);
  });

  it('rejects missing userId (no legacy fallback) when resolving plugin storage paths', async () => {
    const root = tempRoot('tabtin-plugin-missing-userid-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    await expect(
      installPersonalPluginFromCodexDirectory({
        sourceDir,
        dataRoot,
        // @ts-expect-error （硬切）：userId 现为必填，故意省略验证运行时抛错。
        userId: undefined,
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow(/Invalid userId/);
  });

  it('rewrites registry installPath that escapes the installed root to the canonical plugin dir', async () => {
    const root = tempRoot('tabtin-plugin-polluted-registry-');
    const dataRoot = path.join(root, 'data');
    const registryFile = resolveOrganizationPluginRegistryFile(dataRoot, USER_ID, ORGANIZATION_ID);
    writeJson(registryFile, {
      schemaVersion: 1,
      plugins: [
        {
          pluginId: 'cowart',
          source: { kind: 'github', uri: 'https://github.com/acme/cowart.git' },
          // 模拟  迁移后残留的旧绝对路径 / 越界路径
          installPath: path.join(root, 'outside-installed-root'),
          installedAt: '2026-06-22T00:00:00.000Z',
          capabilityManifest: {
            plugin: { id: 'cowart' },
            source: { kind: 'github', uri: 'https://github.com/acme/cowart.git' },
            skills: [],
            declaredHooks: [],
            scripts: [],
            assets: [],
            apps: [],
            localServices: [],
            files: {},
            warnings: [],
          },
        },
      ],
    });

    const listed = await listInstalledPersonalPlugins({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.installPath).toBe(
      resolveOrganizationPluginDir(dataRoot, USER_ID, ORGANIZATION_ID, 'cowart'),
    );
  });

  it('tracks Personal Plugin enablement independently from installation', async () => {
    const root = tempRoot('tabtin-plugin-enable-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      versionPin: '2026.06.22',
    });

    await expect(
      listPersonalPluginEnablement({
        dataRoot,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      }),
    ).resolves.toMatchObject([{ pluginId: 'superpowers-like', enabled: false }]);

    const disabledSnapshot = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'agent-space-1',
    });
    expect(disabledSnapshot.skills).toEqual([]);
    expect(
      renderSkillsBlock(disabledSnapshot.skills, {
        spaceId: 'agent-space-1',
        organizationId: ORGANIZATION_ID,
      }),
    ).toBeNull();

    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'superpowers-like',
      enabled: true,
    });

    const enabledSnapshot = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'agent-space-1',
    });
    expect(enabledSnapshot.enabledPluginIds).toEqual(['superpowers-like']);
    expect(enabledSnapshot.skills.map((skill) => skill.canonicalKey).sort()).toEqual([
      'user:brainstorm',
      'user:write-plan',
    ]);
    expect(enabledSnapshot.skills.every((skill) => skill.personalPluginRuntime === undefined)).toBe(true);
    const enabledMap = Object.fromEntries(
      enabledSnapshot.skills.map((skill) => [skill.canonicalKey, true] as const),
    );
    expect(
      renderSkillsBlock(enabledSnapshot.skills, {
        spaceId: 'agent-space-1',
        organizationId: ORGANIZATION_ID,
        enabledMap,
      }),
    ).toContain('user:brainstorm');

    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'superpowers-like',
      enabled: false,
    });
    const disabledAgain = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'agent-space-1',
    });
    expect(disabledAgain.skills).toEqual([]);
  });

  it('marks Cowart local-service skills with Personal Plugin runtime metadata', async () => {
    const root = tempRoot('tabtin-plugin-cowart-runtime-skill-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createCowartScriptServicePackage(root);
    writeSkill(sourceDir, 'cowart-analyze-note', 'Analyze notes with Cowart context.');

    await installPersonalPluginFromCodexDirectory({
      sourceDir,
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'cowart',
      enabled: true,
    });

    const snapshot = await loadEnabledPersonalPluginSkillSnapshot({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      spaceId: 'agent-space-1',
    });

    expect(snapshot.skills.map((skill) => skill.canonicalKey).sort()).toEqual([
      'user:cowart-analyze-note',
      'user:cowart-open-canvas',
    ]);
    const openCanvas = snapshot.skills.find((skill) => skill.canonicalKey === 'user:cowart-open-canvas');
    const analyzeNote = snapshot.skills.find((skill) => skill.canonicalKey === 'user:cowart-analyze-note');
    expect(openCanvas).toMatchObject({
      canonicalKey: 'user:cowart-open-canvas',
      personalPluginId: 'cowart',
      personalPluginRuntime: {
        serviceId: 'canvas',
        title: 'cowart',
        requireMcp: true,
      },
    });
    expect(analyzeNote?.personalPluginRuntime).toBeUndefined();
  });

  it('previews and approves a Cowart-like GitHub install without running hooks', async () => {
    const root = tempRoot('tabtin-plugin-github-cowart-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createCowartLikePackage(root);
    const commit = 'abcdef1234567890abcdef1234567890abcdef12';
    const repoUrl = 'https://github.com/acme/cowart.git';

    const preview = await previewPersonalPluginGithubInstall({
      repoUrl,
      ref: 'v0.4.1',
      context: { dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID },
      tempRoot: path.join(root, 'tmp'),
      downloadAdapter: fakeGitHubAdapter(sourceDir, commit),
    });

    expect(preview.manifest).toMatchObject({
      plugin: { id: 'cowart', version: '0.4.1' },
      source: {
        kind: 'github',
        uri: repoUrl,
        repoUrl,
        ref: 'v0.4.1',
        versionPin: 'v0.4.1',
        commit,
      },
      skills: [
        { id: 'cowart-image-edit' },
        { id: 'cowart-image-gen' },
        { id: 'cowart-open-canvas' },
      ],
      mcp: { serverCount: 2 },
      declaredHooks: [
        expect.objectContaining({
          command: 'node scripts/hook-would-run.js',
          sourcePath: 'hooks.json',
        }),
        expect.objectContaining({
          command: 'node scripts/summarize.js',
          sourcePath: 'hooks.json',
        }),
      ],
      scripts: ['check-permission.js', 'hook-would-run.js', 'summarize.js'],
      assets: ['style.css'],
    });
    expect(preview.permissionSummary).toMatchObject({
      source: {
        repoUrl,
        requestedRef: 'v0.4.1',
        resolvedRef: 'v0.4.1',
        commit,
      },
      installWrites: {
        managedPluginDirectory: true,
        personalPluginRegistry: true,
      },
      capabilities: {
        skills: ['cowart-image-edit', 'cowart-image-gen', 'cowart-open-canvas'],
        mcpServers: 2,
        declaredHooks: {
          count: 2,
          executedDuringInstall: false,
          commands: ['node scripts/hook-would-run.js', 'node scripts/summarize.js'],
        },
      },
    });
    await expect(
      listInstalledPersonalPlugins({ dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).resolves.toEqual([]);

    const installed = await approvePersonalPluginGithubInstall(preview);
    const expectedInstallDir = resolveOrganizationPluginDir(dataRoot, USER_ID, ORGANIZATION_ID, 'cowart');
    expect(installed).toMatchObject({
      pluginId: 'cowart',
      installPath: expectedInstallDir,
      source: {
        kind: 'github',
        uri: repoUrl,
        repoUrl,
        ref: 'v0.4.1',
        versionPin: 'v0.4.1',
        commit,
      },
      commit,
    });
    expect(existsSync(path.join(expectedInstallDir, 'hooks.json'))).toBe(true);
    expect(existsSync(path.join(expectedInstallDir, 'hook-ran'))).toBe(false);
    expect(existsSync(preview.tempDir)).toBe(false);
  });

  it('checks GitHub updates without auto-applying and only updates after explicit approval', async () => {
    const root = tempRoot('tabtin-plugin-github-update-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createCowartLikePackage(root);
    const repoUrl = 'https://github.com/acme/cowart.git';
    const context = { dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID };
    const originalCommit = '1111111111111111111111111111111111111111';
    const nextCommit = '2222222222222222222222222222222222222222';

    const preview = await previewPersonalPluginGithubInstall({
      repoUrl,
      ref: 'main',
      context,
      tempRoot: path.join(root, 'tmp-original'),
      downloadAdapter: fakeGitHubAdapter(sourceDir, originalCommit),
    });
    const installed = await approvePersonalPluginGithubInstall(preview);

    writeJson(path.join(sourceDir, '.codex-plugin', 'plugin.json'), {
      id: 'cowart',
      name: 'Cowart',
      version: '0.4.2',
      localServices: [{ id: 'preview-server', command: 'pnpm preview' }],
      apps: [{ id: 'tabdoc' }],
    });
    const check = await checkPersonalPluginGithubUpdate({
      installedPlugin: installed,
      context,
      tempRoot: path.join(root, 'tmp-check'),
      downloadAdapter: fakeGitHubAdapter(sourceDir, nextCommit),
    });

    expect(check).toMatchObject({
      status: 'update-available',
      pluginId: 'cowart',
      current: { repoUrl, ref: 'main', commit: originalCommit, versionPin: 'main' },
      candidate: {
        repoUrl,
        requestedRef: 'main',
        commit: nextCommit,
        versionPin: 'main',
        manifest: { plugin: { version: '0.4.2' } },
      },
    });
    await expect(
      listInstalledPersonalPlugins({ dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).resolves.toMatchObject([{ pluginId: 'cowart', commit: originalCommit }]);
    expect(existsSync(path.join(root, 'tmp-check'))).toBe(true);

    const updated = await approvePersonalPluginGithubUpdate({
      installedPlugin: installed,
      context,
      tempRoot: path.join(root, 'tmp-approve'),
      downloadAdapter: fakeGitHubAdapter(sourceDir, nextCommit),
    });

    expect(updated).toMatchObject({
      pluginId: 'cowart',
      commit: nextCommit,
      capabilityManifest: { plugin: { version: '0.4.2' } },
    });
    expect(existsSync(path.join(updated.installPath, 'hooks.json'))).toBe(true);
    expect(existsSync(path.join(updated.installPath, 'hook-ran'))).toBe(false);
    await expect(
      listInstalledPersonalPlugins({ dataRoot, userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).resolves.toMatchObject([{ pluginId: 'cowart', commit: nextCommit }]);
  });

  it('surfaces a diagnostic error when GitHub source has no plugin.json', async () => {
    const root = tempRoot('tabtin-plugin-github-no-plugin-json-');
    const sourceDir = path.join(root, 'not-a-plugin');
    writeSkill(sourceDir, 'cowart-open-canvas', 'Missing plugin metadata.');

    await expect(
      previewPersonalPluginGithubInstall({
        repoUrl: 'https://github.com/acme/not-a-plugin',
        context: { dataRoot: path.join(root, 'data'), userId: USER_ID, organizationId: ORGANIZATION_ID },
        tempRoot: path.join(root, 'tmp'),
        downloadAdapter: fakeGitHubAdapter(sourceDir),
      }),
    ).rejects.toThrow('missing .codex-plugin/plugin.json');
  });

  it('wraps clone failures with GitHub source context', async () => {
    const root = tempRoot('tabtin-plugin-github-clone-fail-');

    await expect(
      previewPersonalPluginGithubInstall({
        repoUrl: 'https://github.com/acme/missing-plugin',
        context: { dataRoot: path.join(root, 'data'), userId: USER_ID, organizationId: ORGANIZATION_ID },
        tempRoot: path.join(root, 'tmp'),
        downloadAdapter: {
          async checkout() {
            throw new Error('repository not found');
          },
        },
      }),
    ).rejects.toThrow('GitHub plugin clone failed');
  });

  it('rejects adapter package paths outside the checkout root', async () => {
    const root = tempRoot('tabtin-plugin-github-unsafe-source-');
    const sourceDir = createCowartLikePackage(root);

    await expect(
      previewPersonalPluginGithubInstall({
        repoUrl: 'https://github.com/acme/cowart',
        context: { dataRoot: path.join(root, 'data'), userId: USER_ID, organizationId: ORGANIZATION_ID },
        tempRoot: path.join(root, 'tmp'),
        downloadAdapter: {
          async checkout(request) {
            const checkoutDir = path.join(request.targetDir, 'repo');
            mkdirSync(checkoutDir, { recursive: true });
            return {
              checkoutDir,
              sourceDir,
              resolvedCommit: '1234567890abcdef1234567890abcdef12345678',
            };
          },
        },
      }),
    ).rejects.toThrow('outside checkout safe root');
  });

  it('rejects path traversal plugin ids before copying files', async () => {
    const root = tempRoot('tabtin-plugin-bad-id-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = path.join(root, 'bad-package');
    writeJson(path.join(sourceDir, '.codex-plugin', 'plugin.json'), {
      id: '../escape',
      version: '1.0.0',
    });
    writeSkill(sourceDir, 'ok', 'Should never be copied.');

    await expect(
      installPersonalPluginFromCodexDirectory({
        sourceDir,
        dataRoot,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow('Invalid personal plugin id');
  });

  it('rejects explicit install targets outside the organization plugin root', async () => {
    const root = tempRoot('tabtin-plugin-unsafe-target-');
    const dataRoot = path.join(root, 'data');
    const sourceDir = createSuperpowersLikePackage(root);

    await expect(
      installPersonalPluginFromCodexDirectory({
        sourceDir,
        dataRoot,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        installDir: path.join(root, 'outside-plugin-root'),
      }),
    ).rejects.toThrow('outside safe root');
  });
});
