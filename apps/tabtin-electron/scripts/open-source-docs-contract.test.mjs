import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const docsDirectory = new URL('../docs/', import.meta.url);
const repositoryRoot = new URL('../../../', import.meta.url);
const guideNames = [
  'open-source-development.md',
  'open-source-development.zh-CN.md',
];
const oneCommand = 'node scripts/dev.mjs community';

function read(name) {
  return readFileSync(new URL(name, docsDirectory), 'utf8');
}

function extractShellCommands(markdown) {
  return [
    ...markdown.matchAll(/```(?:bash|powershell)\r?\n([\s\S]*?)```/g),
  ].map((match) => match[1].trim());
}

test('English and Chinese guides expose the same executable commands', () => {
  const english = extractShellCommands(read('open-source-development.md'));
  const chinese = extractShellCommands(
    read('open-source-development.zh-CN.md'),
  );

  assert.ok(english.length >= 5);
  assert.deepEqual(english, chinese);
});

test('both guides document the Electron-only scope and security boundaries', () => {
  for (const name of guideNames) {
    const content = read(name);
    for (const required of [
      'bootstrap:electron',
      'bootstrap:electron:cn',
      'audit:opensource',
      'TABTIN_COMMUNITY_API_BASE_URL',
      'SOURCEMAP_UPLOAD_KEY',
      'SENTRY_AUTH_TOKEN',
      'Django',
      'Daemon',
    ]) {
      assert.match(
        content,
        new RegExp(required),
        `${name} must mention ${required}`,
      );
    }
  }
});

test('both guides lead with the one-command community path', () => {
  for (const name of guideNames) {
    const content = read(name);

    assert.match(content, /node scripts\/dev\.mjs community/);
    assert.match(content, /--region cn/);
    assert.match(content, /--skip-backend/);
    assert.ok(
      content.indexOf(oneCommand) <
        content.indexOf('pnpm bootstrap:electron:doctor'),
      `${name} must put the unified entry before manual doctor/install commands`,
    );
  }
});

test('both guides document every public top-level startup option', () => {
  const expectations = {
    'open-source-development.md': [
      [
        'node scripts/dev.mjs community --region global',
        /official source/i,
      ],
      ['node scripts/dev.mjs community --doctor', /only.*checks/i],
      [
        'node scripts/dev.mjs community --dry-run',
        /without starting.*plan/i,
      ],
    ],
    'open-source-development.zh-CN.md': [
      ['node scripts/dev.mjs community --region global', /官方源/],
      ['node scripts/dev.mjs community --doctor', /只.*检查/],
      ['node scripts/dev.mjs community --dry-run', /不.*启动.*计划/],
    ],
  };

  for (const [name, options] of Object.entries(expectations)) {
    const content = read(name);
    for (const [command, meaning] of options) {
      assert.match(
        content,
        new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(content, meaning, `${name} must explain ${command}`);
    }
  }
});

test('both guides make the Windows shell contract explicit', () => {
  for (const name of guideNames) {
    const content = read(name);

    for (const shell of ['PowerShell', 'CMD', 'Git Bash']) {
      assert.match(content, new RegExp(shell), `${name} must mention ${shell}`);
    }
    assert.match(content, /Bash.*WSL|WSL.*Bash/);
  }
});

test('the root README links to the unified community entry and detailed guide', () => {
  const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');

  assert.match(readme, /node scripts\/dev\.mjs community/);
  assert.match(
    readme,
    /apps\/tabtin-electron\/docs\/open-source-development\.md/,
  );
});
