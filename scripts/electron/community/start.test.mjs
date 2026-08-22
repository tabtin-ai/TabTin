import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { prepareElectronWorkspace } from './start.mjs';

const PREPARE_DEV_RUNTIME_SEGMENTS = [
  'apps',
  'tabtin-electron',
  'scripts',
  'prepare-dev-runtime.mjs',
];

test('community workspace prep shares pnpm predev runtime, including filegen', async () => {
  const calls = [];
  await prepareElectronWorkspace({
    rootDir: '/repo',
    platform: 'darwin',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.posix.join('/repo', ...PREPARE_DEV_RUNTIME_SEGMENTS),
  ]);
  assert.equal(calls[0].options.cwd, '/repo');
});

test('windows community workspace prep uses win32 script path', async () => {
  const calls = [];
  await prepareElectronWorkspace({
    rootDir: 'C:\\repo',
    platform: 'win32',
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls[0].args, [
    path.win32.join('C:\\repo', ...PREPARE_DEV_RUNTIME_SEGMENTS),
  ]);
});
