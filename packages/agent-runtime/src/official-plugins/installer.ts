import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getOfficialPluginRelease } from './catalog.js';
import type {
  InstalledOfficialPluginRecord,
  OfficialPluginCapabilityManifest,
  OfficialPluginCatalog,
  OfficialPluginHookDeclaration,
  OfficialPluginRelease,
} from './types.js';

export interface InstallOfficialPluginReleaseOptions {
  catalog: OfficialPluginCatalog;
  releaseId: string;
  installRoot: string;
  now?: () => Date;
}

interface UpstreamPluginManifest {
  name?: unknown;
  version?: unknown;
  skills?: unknown;
  mcp?: unknown;
  mcpServers?: unknown;
  scripts?: unknown;
  hooks?: unknown;
  assets?: unknown;
  repository?: unknown;
}

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizeHookDeclaration(value: unknown, index: number): OfficialPluginHookDeclaration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const event = typeof raw.event === 'string' ? raw.event : typeof raw.type === 'string' ? raw.type : undefined;
  if (!event) return null;
  return {
    name: typeof raw.name === 'string' ? raw.name : `${event}-${index + 1}`,
    event,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: stringArray(raw.args),
    displayOnly: true,
  };
}

function normalizeHooks(value: unknown): OfficialPluginHookDeclaration[] {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => normalizeHookDeclaration(entry, index))
      .filter((entry): entry is OfficialPluginHookDeclaration => Boolean(entry));
  }
  const hooks = objectRecord(value);
  return Object.entries(hooks)
    .map(([event, declaration], index) => {
      if (typeof declaration === 'string') {
        return { name: `${event}-${index + 1}`, event, command: declaration, args: [], displayOnly: true as const };
      }
      const normalized = normalizeHookDeclaration({ event, ...(objectRecord(declaration)) }, index);
      return normalized;
    })
    .filter((entry): entry is OfficialPluginHookDeclaration => Boolean(entry));
}

function mergeHooks(
  upstream: OfficialPluginHookDeclaration[],
  adapter: OfficialPluginHookDeclaration[] | undefined,
): OfficialPluginHookDeclaration[] {
  return [...upstream, ...(adapter ?? []).map((hook) => ({ ...hook, displayOnly: true as const }))];
}

function mergeStringSets(first: string[], second: string[] | undefined): string[] {
  return [...new Set([...first, ...(second ?? [])])];
}

async function readUpstreamManifest(sourcePath: string): Promise<UpstreamPluginManifest> {
  const manifestPath = path.join(sourcePath, '.codex-plugin', 'plugin.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as UpstreamPluginManifest;
}

function buildCapabilityManifest(
  release: OfficialPluginRelease,
  upstreamManifest: UpstreamPluginManifest,
): OfficialPluginCapabilityManifest {
  const overrides = release.adapter.capabilityOverrides;
  const mcpServers = {
    ...objectRecord(upstreamManifest.mcpServers),
    ...objectRecord(upstreamManifest.mcp),
    ...(overrides?.mcpServers ?? {}),
  };
  const warnings = [
    ...(overrides?.warnings ?? []),
    ...(release.adapter.preparedRuntime?.warnings ?? []),
  ];

  return {
    manifestVersion: 1,
    skills: mergeStringSets(stringArray(upstreamManifest.skills), overrides?.skills),
    mcpServers,
    scripts: {
      ...objectRecord(upstreamManifest.scripts),
      ...(overrides?.scripts ?? {}),
    },
    hooks: mergeHooks(normalizeHooks(upstreamManifest.hooks), overrides?.hooks),
    assets: mergeStringSets(stringArray(upstreamManifest.assets), overrides?.assets),
    localServices: release.adapter.localServices ?? [],
    warnings,
    acceptance: release.adapter.acceptance,
    preparedRuntime: release.adapter.preparedRuntime,
  };
}

export async function installOfficialPluginRelease(
  options: InstallOfficialPluginReleaseOptions,
): Promise<InstalledOfficialPluginRecord> {
  const release = getOfficialPluginRelease(options.catalog, options.releaseId);
  if (release.source.kind !== 'bundled') {
    throw new Error(`Unsupported official plugin source kind in bundled installer: ${release.source.kind}`);
  }
  if (!release.source.path) {
    throw new Error(`Official plugin release ${release.id} has no bundled source path`);
  }

  const upstreamManifest = await readUpstreamManifest(release.source.path);
  const installedAt = (options.now ?? (() => new Date()))().toISOString();
  const packagePath = path.join(options.installRoot, safeSlug(release.id));
  await mkdir(options.installRoot, { recursive: true });
  await cp(release.source.path, packagePath, { recursive: true, force: true });

  const record: InstalledOfficialPluginRecord = {
    schemaVersion: 1,
    pluginId: release.plugin.id,
    installedAt,
    installSource: release.source.kind,
    packagePath,
    upstream: {
      ...release.upstream,
      packageName: typeof upstreamManifest.name === 'string' ? upstreamManifest.name : release.upstream.packageName,
      version: typeof upstreamManifest.version === 'string' ? upstreamManifest.version : release.upstream.version,
      repository: typeof upstreamManifest.repository === 'string'
        ? upstreamManifest.repository
        : release.upstream.repository,
      sourcePath: release.source.path,
    },
    officialRelease: {
      id: release.id,
      version: release.officialVersion,
      channel: release.channel,
      catalogVersion: options.catalog.catalogVersion,
    },
    adapter: {
      id: release.adapter.id,
      version: release.adapter.version,
    },
    capabilityManifest: buildCapabilityManifest(release, upstreamManifest),
  };

  await writeFile(
    path.join(packagePath, 'tabtin-official-plugin-install.json'),
    JSON.stringify(record, null, 2),
    'utf8',
  );

  return record;
}
