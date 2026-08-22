import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveFrontendCommand } from './restart.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('frontend entry resolves native Windows and POSIX restart commands', () => {
  const windows = resolveFrontendCommand('win32', 'C:\\TabTin');
  assert.equal(windows.args.at(-1), 'scripts\\electron\\restart.bat');

  for (const platform of ['darwin', 'linux']) {
    const command = resolveFrontendCommand(platform, rootDir);
    assert.equal(command.command, 'bash');
    assert.equal(
      command.args[0],
      path.join(rootDir, 'scripts', 'electron', 'restart.sh'),
    );
  }
});

test('frontend public entry command targets exist', () => {
  assert.ok(
    existsSync(path.join(rootDir, 'scripts', 'electron', 'restart.bat')),
  );
  assert.ok(
    existsSync(path.join(rootDir, 'scripts', 'electron', 'restart.sh')),
  );
});

test('frontend batch call graph does not reference missing sibling scripts', () => {
  const frontendDir = path.join(rootDir, 'scripts', 'electron');
  const entryFiles = ['restart.bat', 'start.bat', 'stop.bat'];

  for (const entryFile of entryFiles) {
    const source = readFileSync(path.join(frontendDir, entryFile), 'utf8');
    const targets = [...source.matchAll(/%~dp0([\w.-]+\.bat)/gi)].map(
      (match) => match[1],
    );
    for (const target of targets) {
      assert.ok(
        existsSync(path.join(frontendDir, target)),
        `${entryFile} references missing ${target}`,
      );
    }
  }
});
