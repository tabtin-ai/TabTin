import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBundledOfficialPluginCatalog,
  getOfficialPluginRelease,
  installOfficialPluginRelease,
} from '../src/official-plugins/index.js';

async function exists(filePath: string): Promise<boolean> {
  return access(filePath, constants.F_OK).then(
    () => true,
    () => false,
  );
}

describe('official plugin release catalog and install seam', () => {
  it('looks up a bundled official release with upstream identity and acceptance metadata', () => {
    const catalog = createBundledOfficialPluginCatalog();
    const release = getOfficialPluginRelease(
      catalog,
      'tabtin-minimal-codex-plugin@0.1.0+official.1',
    );

    expect(release.source.kind).toBe('bundled');
    expect(release.plugin.id).toBe('tabtin-minimal-codex-plugin');
    expect(release.upstream).toMatchObject({
      packageName: 'minimal-codex-plugin',
      version: '0.1.0',
      commit: 'fixture-minimal-0.1.0',
    });
    expect(release.adapter.acceptance).toMatchObject({
      status: 'accepted',
      checklistId: 'official-plugin-minimal-release-v1',
    });
  });

  it('applies adapter metadata and writes install record without executing declared hooks', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'tabtin-official-plugin-'));
    try {
      const catalog = createBundledOfficialPluginCatalog();
      const record = await installOfficialPluginRelease({
        catalog,
        releaseId: 'tabtin-minimal-codex-plugin@0.1.0+official.1',
        installRoot,
        now: () => new Date('2026-06-23T00:00:00.000Z'),
      });

      expect(record).toMatchObject({
        schemaVersion: 1,
        pluginId: 'tabtin-minimal-codex-plugin',
        installedAt: '2026-06-23T00:00:00.000Z',
        upstream: {
          packageName: 'minimal-codex-plugin',
          version: '0.1.0',
          commit: 'fixture-minimal-0.1.0',
        },
        officialRelease: {
          id: 'tabtin-minimal-codex-plugin@0.1.0+official.1',
          version: '0.1.0+official.1',
          catalogVersion: '2026-06-23.preview',
        },
        adapter: {
          id: 'tabtin-minimal-codex-plugin-adapter',
          version: '0.1.0',
        },
      });

      expect(record.capabilityManifest.skills).toEqual([
        './skills/',
        'skills/minimal/SKILL.md',
      ]);
      expect(record.capabilityManifest.mcpServers).toHaveProperty('upstreamEcho');
      expect(record.capabilityManifest.mcpServers).toHaveProperty('minimalEcho');
      expect(record.capabilityManifest.scripts).toHaveProperty('verify');
      expect(record.capabilityManifest.scripts).toHaveProperty('smoke');
      expect(record.capabilityManifest.localServices).toHaveLength(1);
      expect(record.capabilityManifest.warnings.join('\n')).toContain('Fixture release');
      expect(record.capabilityManifest.hooks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'upstream-post-install',
            event: 'postInstall',
            displayOnly: true,
          }),
          expect.objectContaining({
            name: 'fixture-post-install',
            event: 'postInstall',
            displayOnly: true,
          }),
        ]),
      );

      const persisted = JSON.parse(
        await readFile(join(record.packagePath, 'tabtin-official-plugin-install.json'), 'utf8'),
      );
      expect(persisted.officialRelease.id).toBe(record.officialRelease.id);
      expect(await exists(join(record.packagePath, 'UPSTREAM_HOOK_SHOULD_NOT_EXIST'))).toBe(false);
      expect(await exists(join(record.packagePath, 'SHOULD_NOT_EXIST'))).toBe(false);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
});
