import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveBackendCommand } from './dev.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('backend entry resolves native Windows and POSIX restart commands', () => {
  const windows = resolveBackendCommand('win32', 'C:\\TabTin');
  assert.equal(windows.args.at(-1), 'scripts\\backend\\restart.bat');

  for (const platform of ['darwin', 'linux']) {
    const command = resolveBackendCommand(platform, rootDir);
    assert.equal(command.command, 'bash');
    assert.equal(
      command.args[0],
      path.join(rootDir, 'scripts', 'backend', 'restart.sh'),
    );
  }
});

test('backend public entry command targets exist', () => {
  assert.ok(
    existsSync(path.join(rootDir, 'scripts', 'backend', 'restart.bat')),
  );
  assert.ok(existsSync(path.join(rootDir, 'scripts', 'backend', 'restart.sh')));
});

test('pnpm dev uses the unified multi-client entry', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  );
  assert.equal(packageJson.scripts.dev, 'node scripts/dev.mjs');
  assert.equal(
    packageJson.scripts['dev:backend'],
    'node scripts/dev.mjs backend',
  );
  assert.equal(
    packageJson.scripts['dev:electron'],
    'node scripts/dev.mjs electron',
  );
});

test('backend batch call graph does not reference missing sibling scripts', () => {
  const backendDir = path.join(rootDir, 'scripts', 'backend');
  const entryFiles = ['restart.bat', 'start.bat', 'stop.bat'];

  for (const entryFile of entryFiles) {
    const source = readFileSync(path.join(backendDir, entryFile), 'utf8');
    const targets = [...source.matchAll(/%~dp0([\w.-]+\.bat)/gi)].map(
      (match) => match[1],
    );
    for (const target of targets) {
      assert.ok(
        existsSync(path.join(backendDir, target)),
        `${entryFile} references missing ${target}`,
      );
    }
  }
});

test('Centrifugo bootstrap reuses legacy binaries and bounds network waits', () => {
  const backendDir = path.join(rootDir, 'scripts', 'backend');
  const posix = readFileSync(
    path.join(backendDir, 'start-centrifugo.sh'),
    'utf8',
  );
  const windows = readFileSync(
    path.join(backendDir, 'centrifugo-start.bat'),
    'utf8',
  );

  assert.match(posix, /scripts\/bin\/centrifugo/);
  assert.match(posix, /--connect-timeout/);
  assert.match(posix, /--max-time/);
  assert.match(windows, /scripts\\bin\\centrifugo\.exe/i);
  assert.match(windows, /-TimeoutSec 120/);
});
