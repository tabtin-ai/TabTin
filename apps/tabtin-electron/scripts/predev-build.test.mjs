import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as predevBuild from './predev-build.mjs';

test('uses Corepack for workspace builds when pnpm is not on Windows PATH', () => {
  assert.equal(typeof predevBuild.resolvePnpmInvocation, 'function');

  const invocation = predevBuild.resolvePnpmInvocation({
    platform: 'win32',
    comSpec: 'C:\\Windows\\System32\\cmd.exe',
    commandExists: (command) => command === 'corepack',
  });

  assert.deepEqual(invocation, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'corepack', 'pnpm'],
    usesCorepack: true,
  });
});

test('adds a temporary pnpm.cmd shim for nested Windows lifecycle scripts', () => {
  assert.equal(typeof predevBuild.createPnpmBuildEnvironment, 'function');

  const originalEnv = { Path: 'C:\\Windows\\System32' };
  const runtime = predevBuild.createPnpmBuildEnvironment({
    invocation: { usesCorepack: true },
    platform: 'win32',
    env: originalEnv,
    temporaryRoot: os.tmpdir(),
  });

  const [shimDir] = runtime.env.Path.split(path.delimiter);
  const shimPath = path.join(shimDir, 'pnpm.cmd');
  assert.equal(fs.existsSync(shimPath), true);
  assert.match(fs.readFileSync(shimPath, 'utf8'), /corepack pnpm %\*/);
  assert.deepEqual(originalEnv, { Path: 'C:\\Windows\\System32' });

  runtime.cleanup();
  assert.equal(fs.existsSync(shimDir), false);
});

test('parseSeedPkg defaults to tabtin-electron and reads --seed', () => {
  assert.equal(predevBuild.parseSeedPkg([]), 'tabtin-electron');
  assert.equal(predevBuild.parseSeedPkg(['--force']), 'tabtin-electron');
  assert.equal(predevBuild.parseSeedPkg(['--seed', 'collab-live', '--check']), 'collab-live');
  assert.throws(
    () => predevBuild.parseSeedPkg(['--seed']),
    /--seed 需要包名/,
  );
  assert.throws(
    () => predevBuild.parseSeedPkg(['--seed', '--force']),
    /--seed 需要包名/,
  );
});

test('collab-live seed builds declared workspace deps, not itself or Go CLI', () => {
  const ctx = predevBuild.buildContext({ seedPkg: 'collab-live' });
  for (const name of ['@tabtin/config', '@tabtin/doc-editor', '@tabtin/table-engine']) {
    assert.equal(ctx.closure.has(name), true, name);
  }
  assert.equal(ctx.closure.has('collab-live'), false);
  assert.equal(ctx.closure.has('tabtin-electron'), false);
  assert.equal(ctx.seedPkg, 'collab-live');
  assert.equal(ctx.includeGoCli, false);
});

test('default seed still prepares the Electron workspace including Go CLI', () => {
  const ctx = predevBuild.buildContext({ args: [] });
  assert.equal(ctx.seedPkg, 'tabtin-electron');
  assert.equal(ctx.includeGoCli, true);
  assert.ok(ctx.closure.size > 0);
});
