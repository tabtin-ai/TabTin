import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeDevTarget,
  resolveDevPlan,
  resolveTargetCommand,
} from '../dev.mjs';
import { resolveViteDevCommand, stopPort } from './vite-dev.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('default dev plan starts backend before all browser and desktop clients', () => {
  assert.deepEqual(resolveDevPlan(), [
    'backend',
    'admindash',
    'electron',
    'tabtin-web',
  ]);
});

test('dev aliases normalize to product directory names', () => {
  assert.equal(normalizeDevTarget('server'), 'backend');
  assert.equal(normalizeDevTarget('admin'), 'admindash');
  assert.equal(normalizeDevTarget('desktop'), 'electron');
  assert.equal(normalizeDevTarget('web'), 'tabtin-web');
});

test('Electron uses its package lifecycle and local binaries', () => {
  const posix = resolveTargetCommand('electron', ['--no-hmr'], 'darwin');
  assert.deepEqual(posix, {
    command: 'pnpm',
    args: [
      '--filter',
      'tabtin-electron',
      'dev',
      '--',
      '--no-hmr',
    ],
  });

  const windows = resolveTargetCommand('electron', [], 'win32');
  assert.match(windows.command, /cmd(?:\.exe)?$/i);
  assert.deepEqual(windows.args.slice(-4), [
    'pnpm.cmd',
    '--filter',
    'tabtin-electron',
    'dev',
  ]);
});

test('Vite clients use native pnpm launch commands on POSIX and Windows', () => {
  assert.deepEqual(resolveViteDevCommand('admindash', 'linux'), {
    command: 'pnpm',
    args: ['--filter', 'admindash', 'dev'],
  });
  const windows = resolveViteDevCommand('tabtin-web', 'win32');
  assert.match(windows.command, /cmd(?:\.exe)?$/i);
  assert.deepEqual(windows.args.slice(-4), [
    'pnpm.cmd',
    '--filter',
    'tabtin-web',
    'dev',
  ]);
});

test('Windows Vite port cleanup emits a valid PowerShell statement boundary', () => {
  const calls = [];
  stopPort(5174, 'win32', (command, args) => calls.push({ command, args }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /^\$port=5174;/);
});

test('scripts root contains only unified public entries', () => {
  const files = readdirSync(path.join(rootDir, 'scripts'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(files, ['dev.mjs', 'package.mjs']);
});
