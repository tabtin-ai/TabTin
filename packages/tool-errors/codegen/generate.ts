#!/usr/bin/env tsx
/**
 * @tabtin/tool-errors codegen
 *
 * Layered YAML → generated TS:
 *   1. src/_generated/kinds.generated.ts
 *   2. src/_generated/catalog-defaults.generated.ts
 *   3. src/_generated/i18n-keys.generated.ts
 *   4. src/_generated/bridges.generated.ts
 *
 * File-pipeline kinds are read from packages/file-pipeline-errors/codegen/
 * error-codes.yaml at codegen time (no runtime dependency) so catalog /
 * i18n key inventory stay complete while agent-runtime keeps re-export merge.
 *
 *   pnpm --filter @tabtin/tool-errors codegen
 *   pnpm --filter @tabtin/tool-errors codegen:verify
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '../..');
const GENERATED_DIR = resolve(PKG_ROOT, 'src/_generated');

const KIND_YAML_FILES = [
  resolve(__dirname, 'kinds/runtime.yaml'),
  resolve(__dirname, 'kinds/tool-layer.yaml'),
] as const;

const BRIDGES_YAML = resolve(__dirname, 'bridges.yaml');
const FILE_PIPELINE_YAML = resolve(
  REPO_ROOT,
  'packages/file-pipeline-errors/codegen/error-codes.yaml',
);

interface CatalogFlags {
  soft: boolean;
  translatable: boolean;
  countsAsAnomaly: boolean;
  userInitiated: boolean;
}

interface KindEntry {
  enum: string;
  kind: string;
  i18n_key: string;
  description: string;
  catalog: CatalogFlags;
  /** When false, excluded from TOOL_LAYER_ERROR_KINDS. Default true for tool-layer. */
  include_in_tool_error_kinds?: boolean;
  layer: 'runtime' | 'tool-layer' | 'file-pipeline';
}

interface BridgeEntry {
  from: string;
  source: string;
  to: string;
  note?: string;
}

interface KindYamlDoc {
  kinds: Array<Omit<KindEntry, 'layer'> & { include_in_tool_error_kinds?: boolean }>;
}

interface BridgesYamlDoc {
  bridges: BridgeEntry[];
}

interface FilePipelineYamlDoc {
  codes: Array<{
    enum: string;
    kind: string;
    i18n_key: string;
    description?: string;
  }>;
}

const FILE_PIPELINE_CATALOG_DEFAULT: CatalogFlags = {
  soft: false,
  translatable: true,
  countsAsAnomaly: true,
  userInitiated: false,
};

/** Kinds already declared in runtime/tool-layer layers (shared with file-pipeline). */
const FILE_PIPELINE_SHARED_KINDS = new Set([
  'permission_denied',
  'aborted',
  'network_failed',
  'invalid_param_format',
  'upstream_error',
]);

function loadKindLayers(): KindEntry[] {
  const out: KindEntry[] = [];
  const seenEnum = new Set<string>();
  const seenKind = new Set<string>();

  for (const path of KIND_YAML_FILES) {
    const layer: KindEntry['layer'] = path.includes('runtime.yaml')
      ? 'runtime'
      : 'tool-layer';
    const doc = parseYaml(readFileSync(path, 'utf-8')) as KindYamlDoc;
    if (!doc?.kinds || !Array.isArray(doc.kinds)) {
      throw new Error(`${path}: missing top-level kinds array`);
    }
    for (const raw of doc.kinds) {
      validateKind(raw, path);
      if (seenEnum.has(raw.enum)) throw new Error(`Duplicate enum: ${raw.enum}`);
      if (seenKind.has(raw.kind)) throw new Error(`Duplicate kind: ${raw.kind}`);
      seenEnum.add(raw.enum);
      seenKind.add(raw.kind);
      const include =
        raw.include_in_tool_error_kinds ?? layer === 'tool-layer';
      out.push({
        ...raw,
        include_in_tool_error_kinds: include,
        layer,
      });
    }
  }

  // File-pipeline specific kinds (codegen-time read; runtime stays on SSoT package).
  const fpDoc = parseYaml(readFileSync(FILE_PIPELINE_YAML, 'utf-8')) as FilePipelineYamlDoc;
  if (!fpDoc?.codes || !Array.isArray(fpDoc.codes)) {
    throw new Error(`${FILE_PIPELINE_YAML}: missing codes array`);
  }
  for (const code of fpDoc.codes) {
    if (FILE_PIPELINE_SHARED_KINDS.has(code.kind)) continue;
    if (seenKind.has(code.kind)) {
      throw new Error(
        `file-pipeline kind ${code.kind} collides with tool-errors declaration`,
      );
    }
    seenKind.add(code.kind);
    seenEnum.add(code.enum);
    out.push({
      enum: code.enum,
      kind: code.kind,
      i18n_key: code.i18n_key,
      description: code.description ?? code.kind,
      catalog: { ...FILE_PIPELINE_CATALOG_DEFAULT },
      include_in_tool_error_kinds: false,
      layer: 'file-pipeline',
    });
  }

  return out;
}

function validateKind(
  e: Omit<KindEntry, 'layer'>,
  path: string,
): void {
  if (!e.enum || !/^[A-Z][A-Z0-9_]*$/.test(e.enum)) {
    throw new Error(`${path}: invalid enum ${JSON.stringify(e.enum)}`);
  }
  if (!e.kind || !/^[a-z][a-z0-9_]*$/.test(e.kind)) {
    throw new Error(`${path}: invalid kind ${JSON.stringify(e.kind)}`);
  }
  if (!e.i18n_key || !/^[a-z][a-z0-9_]*$/.test(e.i18n_key)) {
    throw new Error(`${path}: invalid i18n_key ${JSON.stringify(e.i18n_key)}`);
  }
  const c = e.catalog;
  if (
    !c ||
    typeof c.soft !== 'boolean' ||
    typeof c.translatable !== 'boolean' ||
    typeof c.countsAsAnomaly !== 'boolean' ||
    typeof c.userInitiated !== 'boolean'
  ) {
    throw new Error(`${path}: kind ${e.enum} missing catalog flags`);
  }
}

function loadBridges(): BridgeEntry[] {
  const doc = parseYaml(readFileSync(BRIDGES_YAML, 'utf-8')) as BridgesYamlDoc;
  if (!doc?.bridges || !Array.isArray(doc.bridges)) {
    throw new Error(`${BRIDGES_YAML}: missing bridges array`);
  }
  const seen = new Set<string>();
  for (const b of doc.bridges) {
    if (!b.from || !b.to || !b.source) {
      throw new Error(`Invalid bridge entry: ${JSON.stringify(b)}`);
    }
    if (seen.has(b.from)) throw new Error(`Duplicate bridge from: ${b.from}`);
    seen.add(b.from);
  }
  return doc.bridges;
}

function generateKindsTs(entries: KindEntry[]): string {
  const toolLayer = entries.filter((e) => e.include_in_tool_error_kinds);
  const constLines = toolLayer
    .map((e) => `export const ${e.enum} = '${e.kind}' as const;`)
    .join('\n');
  const kindList = toolLayer.map((e) => `  ${e.enum},`).join('\n');
  const typeLines = toolLayer.map((e) => `  | typeof ${e.enum}`).join('\n');

  return `/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/kinds/*.yaml
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * Tool-layer error_kind constants + TOOL_LAYER_ERROR_KINDS.
 * File-pipeline kinds are NOT listed here — agent-runtime re-exports
 * @tabtin/file-pipeline-errors and merges into TOOL_ERROR_KINDS.
 */

${constLines}

export type ToolLayerErrorKind =
${typeLines};

export const TOOL_LAYER_ERROR_KINDS: readonly ToolLayerErrorKind[] = [
${kindList}
] as const;
`;
}

function generateCatalogTs(entries: KindEntry[]): string {
  const body = entries
    .map((e) => {
      const c = e.catalog;
      return `  ${e.kind}: {
    soft: ${c.soft},
    translatable: ${c.translatable},
    countsAsAnomaly: ${c.countsAsAnomaly},
    userInitiated: ${c.userInitiated},
  },`;
    })
    .join('\n');

  return `/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/kinds/*.yaml
 *        + file-pipeline-errors/codegen/error-codes.yaml (specific kinds)
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * Electron merges these defaults with hand-written UX overrides.
 * No hint copy / Factory / retry policy here.
 */

export interface ToolErrorCatalogEntry {
  soft: boolean;
  translatable: boolean;
  countsAsAnomaly: boolean;
  userInitiated: boolean;
}

export const TOOL_ERROR_CATALOG_DEFAULTS: Readonly<
  Record<string, ToolErrorCatalogEntry>
> = {
${body}
};
`;
}

function generateI18nKeysTs(entries: KindEntry[]): string {
  // Unique i18n keys for translatable kinds (aborted_by_user → aborted).
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.catalog.translatable) continue;
    if (seen.has(e.i18n_key)) continue;
    seen.add(e.i18n_key);
    keys.push(e.i18n_key);
  }
  const lines = keys.map((k) => `  '${k}',`).join('\n');

  return `/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/kinds/*.yaml
 *        + file-pipeline-errors specific kinds
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * Inventory of chat.toolError.* keys expected for translatable kinds.
 * Does not generate locale string values.
 */

export const TOOL_ERROR_I18N_KEYS: readonly string[] = [
${lines}
] as const;
`;
}

function generateBridgesTs(bridges: BridgeEntry[]): string {
  const mapLines = bridges
    .map((b) => `  '${b.from}': '${b.to}',`)
    .join('\n');
  const fromLines = bridges.map((b) => `  | '${b.from}'`).join('\n');
  const toLines = [...new Set(bridges.map((b) => b.to))]
    .map((t) => `  | '${t}'`)
    .join('\n');

  return `/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/bridges.yaml
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * browser-core / action-tools string codes → runtime error_kind.
 * Does not mutate producers; network_error and network_failed stay distinct.
 */

export type BridgedBrowserErrorCode =
${fromLines};

export type BridgedRuntimeErrorKind =
${toLines};

export const BROWSER_TO_RUNTIME_ERROR_KIND: Readonly<
  Record<BridgedBrowserErrorCode, BridgedRuntimeErrorKind>
> = {
${mapLines}
};

export function bridgeBrowserErrorCodeToRuntimeKind(
  code: string,
): BridgedRuntimeErrorKind | undefined {
  if (Object.prototype.hasOwnProperty.call(BROWSER_TO_RUNTIME_ERROR_KIND, code)) {
    return BROWSER_TO_RUNTIME_ERROR_KIND[code as BridgedBrowserErrorCode];
  }
  return undefined;
}
`;
}

interface FileTask {
  label: string;
  path: string;
  expected: string;
}

function buildTasks(entries: KindEntry[], bridges: BridgeEntry[]): FileTask[] {
  return [
    {
      label: 'kinds.generated.ts',
      path: resolve(GENERATED_DIR, 'kinds.generated.ts'),
      expected: generateKindsTs(entries),
    },
    {
      label: 'catalog-defaults.generated.ts',
      path: resolve(GENERATED_DIR, 'catalog-defaults.generated.ts'),
      expected: generateCatalogTs(entries),
    },
    {
      label: 'i18n-keys.generated.ts',
      path: resolve(GENERATED_DIR, 'i18n-keys.generated.ts'),
      expected: generateI18nKeysTs(entries),
    },
    {
      label: 'bridges.generated.ts',
      path: resolve(GENERATED_DIR, 'bridges.generated.ts'),
      expected: generateBridgesTs(bridges),
    },
  ];
}

function writeAll(tasks: FileTask[]): void {
  for (const t of tasks) {
    const dir = dirname(t.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(t.path, t.expected, 'utf-8');
    console.log(`[codegen] WROTE ${t.label}`);
  }
}

function verifyAll(tasks: FileTask[]): boolean {
  let ok = true;
  for (const t of tasks) {
    if (!existsSync(t.path)) {
      console.error(`[codegen:verify] MISSING ${t.label}`);
      ok = false;
      continue;
    }
    const actual = readFileSync(t.path, 'utf-8');
    if (actual === t.expected) {
      console.log(`[codegen:verify] OK ${t.label}`);
      continue;
    }
    ok = false;
    console.error(`[codegen:verify] DIFF ${t.label}`);
    printDiff(actual, t.expected);
  }
  return ok;
}

function printDiff(actual: string, expected: string): void {
  const aLines = actual.split('\n');
  const eLines = expected.split('\n');
  const max = Math.max(aLines.length, eLines.length);
  let first = -1;
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== eLines[i]) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    console.error('  (byte mismatch without line diff)');
    return;
  }
  const start = Math.max(0, first - 2);
  const end = Math.min(max, first + 6);
  console.error(`  First diff at line ${first + 1}:`);
  for (let i = start; i < end; i++) {
    console.error(`    actual   [${i + 1}] ${aLines[i] ?? '<EOF>'}`);
    console.error(`    expected [${i + 1}] ${eLines[i] ?? '<EOF>'}`);
  }
}

function main(): void {
  const mode = process.argv[2] === '--verify' ? 'verify' : 'write';
  const entries = loadKindLayers();
  const bridges = loadBridges();
  const tasks = buildTasks(entries, bridges);

  if (mode === 'write') {
    writeAll(tasks);
    console.log(
      `\n[codegen] Done — ${tasks.length} files from ${entries.length} kinds + ${bridges.length} bridges.`,
    );
    return;
  }

  if (!verifyAll(tasks)) {
    console.error(
      `\n[codegen:verify] FAIL — run \`pnpm --filter @tabtin/tool-errors codegen\`.`,
    );
    process.exit(1);
  }
  console.log(
    `\n[codegen:verify] Clean — ${tasks.length} files match SSoT (${entries.length} kinds).`,
  );
}

main();
