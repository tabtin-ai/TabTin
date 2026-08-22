import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { OfficialPluginCatalog, OfficialPluginRelease } from './types.js';

export interface BundledOfficialPluginCatalogOptions {
  bundledRoot?: string;
}

function resolveDefaultBundledRoot(): string {
  const fixtureUrl = new URL('./fixtures', import.meta.url);
  if (fixtureUrl.protocol === 'file:') {
    return fileURLToPath(fixtureUrl);
  }

  const candidates = [
    path.resolve(process.cwd(), 'src/official-plugins/fixtures'),
    path.resolve(process.cwd(), '../../packages/agent-runtime/src/official-plugins/fixtures'),
    path.resolve(process.cwd(), 'packages/agent-runtime/src/official-plugins/fixtures'),
  ];
  const candidate = candidates.find((entry) => existsSync(entry));
  if (!candidate) {
    throw new Error('Unable to resolve bundled official plugin fixture root');
  }
  return candidate;
}

export function createBundledOfficialPluginCatalog(
  options: BundledOfficialPluginCatalogOptions = {},
): OfficialPluginCatalog {
  const bundledRoot = options.bundledRoot ?? resolveDefaultBundledRoot();
  const minimalRelease: OfficialPluginRelease = {
    id: 'tabtin-minimal-codex-plugin@0.1.0+official.1',
    plugin: {
      id: 'tabtin-minimal-codex-plugin',
      displayName: 'TabTin Minimal Codex Plugin',
      description: 'Minimal bundled official plugin release used to validate the install path.',
    },
    officialVersion: '0.1.0+official.1',
    channel: 'preview',
    source: {
      kind: 'bundled',
      path: path.join(bundledRoot, 'minimal-codex-plugin'),
    },
    upstream: {
      packageName: 'minimal-codex-plugin',
      version: '0.1.0',
      repository: 'https://github.com/larchiveai/tabtin-official-plugin-fixtures',
      commit: 'fixture-minimal-0.1.0',
    },
    adapter: {
      id: 'tabtin-minimal-codex-plugin-adapter',
      version: '0.1.0',
      capabilityOverrides: {
        skills: ['skills/minimal/SKILL.md'],
        mcpServers: {
          minimalEcho: {
            command: 'node',
            args: ['server.js'],
          },
        },
        scripts: {
          smoke: 'node scripts/smoke.js',
        },
        hooks: [
          {
            name: 'fixture-post-install',
            event: 'postInstall',
            command: 'touch',
            args: ['SHOULD_NOT_EXIST'],
            displayOnly: true,
          },
        ],
        assets: ['assets/logo.txt'],
        warnings: ['Fixture release: validates shape only, not a user-facing workflow.'],
      },
      localServices: [
        {
          id: 'minimal-echo',
          command: 'node',
          args: ['server.js'],
        },
      ],
      preparedRuntime: {
        environment: {
          TABTIN_OFFICIAL_PLUGIN_ID: 'tabtin-minimal-codex-plugin',
        },
        warnings: ['Prepared runtime is metadata-only in this release slice.'],
      },
      acceptance: {
        status: 'accepted',
        checklistId: 'official-plugin-minimal-release-v1',
        verifiedAt: '2026-06-23',
        notes: 'Covers catalog lookup, adapter application, install record shape, and hook non-execution.',
      },
    },
  };

  return {
    catalogVersion: '2026-06-23.preview',
    releases: [minimalRelease],
  };
}

export function listOfficialPluginReleases(
  catalog: OfficialPluginCatalog,
): OfficialPluginRelease[] {
  return [...catalog.releases];
}

export function getOfficialPluginRelease(
  catalog: OfficialPluginCatalog,
  releaseId: string,
): OfficialPluginRelease {
  const release = catalog.releases.find((entry) => entry.id === releaseId);
  if (!release) {
    throw new Error(`Official plugin release not found: ${releaseId}`);
  }
  return release;
}
