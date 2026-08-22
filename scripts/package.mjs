#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPackagePlan } from './shared/package-command.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const aliases = new Map([
  ['server', 'backend'],
  ['admin', 'admindash'],
  ['desktop', 'electron'],
  ['web', 'tabtin-web'],
]);
const targets = new Set([
  'backend',
  'admindash',
  'electron',
  'tabtin-web',
  'ios',
  'android',
]);

export function normalizePackageTarget(value) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return aliases.get(normalized) ?? normalized;
}

export async function resolvePackagePlan(
  value,
  args = [],
  platform = process.platform,
) {
  const target = normalizePackageTarget(value);
  if (!targets.has(target)) {
    throw new Error(
      `请指定打包目标: ${[...targets].join(', ')}。例如 pnpm package:electron。`,
    );
  }
  const module = await import(`./${target}/package.mjs`);
  return module.resolvePackagePlan({ rootDir, platform, args });
}

async function main() {
  const [target, ...rawArgs] = process.argv.slice(2);
  const dryRun = rawArgs.includes('--dry-run');
  const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--');
  const plan = await resolvePackagePlan(target, args);
  process.exitCode = runPackagePlan(plan, { dryRun });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
