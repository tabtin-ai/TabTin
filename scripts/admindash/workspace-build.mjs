#!/usr/bin/env node
/**
 * Build AdminDash workspace dependencies while holding the shared dev-build lock.
 * pnpm dev starts all clients together, and Electron/tabtin-web build overlapping
 * packages during predev. Serializing the builds prevents dist directories from
 * being cleaned while another client is reading them.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquire, release } from '../electron/workspace-lock.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

let exitCode = 1;
acquire();
try {
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm',
    windows
      ? ['/d', '/s', '/c', 'pnpm.cmd', '--filter', 'admindash^...', 'build']
      : ['--filter', 'admindash^...', 'build'],
    {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  exitCode = result.status ?? (result.signal ? 1 : 0);
} finally {
  release();
}

process.exit(exitCode);
