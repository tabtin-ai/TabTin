import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  formatBackendFailure,
  resolveBackendCommand,
  startCommunityBackend,
} from './backend.mjs';

const COLLAB_LOG = path.join(
  'apps',
  'tabtin_django',
  'logs',
  'collab-live.log',
);

test('resolves the Unix backend start script', () => {
  const command = resolveBackendCommand('darwin', '/repo');
  assert.equal(command.command, 'bash');
  assert.ok(command.args[0].endsWith('/scripts/backend/start.sh'));
});

test('formatBackendFailure lists failed services, first error, log path and tail', () => {
  const rootDir = '/repo';
  const logPath = path.join(rootDir, COLLAB_LOG);
  const message = formatBackendFailure({
    rootDir,
    report: {
      healthy: false,
      checks: [
        {
          id: 'django',
          ok: true,
          endpoint: 'http://127.0.0.1:6060/health',
          detail: 'healthy response',
        },
        {
          id: 'collab',
          ok: false,
          endpoint: 'http://127.0.0.1:4100/health',
          detail: 'fetch failed',
        },
        {
          id: 'centrifugo',
          ok: true,
          endpoint: '127.0.0.1:8100',
          detail: 'TCP connection succeeded',
        },
      ],
    },
    existsSyncImpl: (filePath) => filePath === logPath,
    readFileSyncImpl: (filePath) => {
      assert.equal(filePath, logPath);
      return [
        'boot',
        "Error: Cannot find module '@tabtin/doc-editor'",
        'still crashing',
        'last line',
      ].join('\n');
    },
  });

  assert.match(message, /失败服务：Collab \(http:\/\/127\.0\.0\.1:4100\/health — fetch failed\)/);
  assert.doesNotMatch(message, /失败服务：.*Django/);
  assert.match(
    message,
    /首个错误：Collab: Error: Cannot find module '@tabtin\/doc-editor'/,
  );
  assert.ok(message.includes(`Collab 日志：${logPath}`));
  assert.match(message, /最后 12 行：\nboot\nError: Cannot find module '@tabtin\/doc-editor'\nstill crashing\nlast line/);
});

test('formatBackendFailure notes a missing log file', () => {
  const message = formatBackendFailure({
    rootDir: '/repo',
    report: {
      healthy: false,
      checks: [
        {
          id: 'django',
          ok: false,
          endpoint: 'http://127.0.0.1:6060/health',
          detail: 'fetch failed',
        },
      ],
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => {
      throw new Error('should not read');
    },
  });

  assert.match(message, /Django 日志：.*django-dev\.log（文件不存在）/);
  assert.doesNotMatch(message, /首个错误/);
});

test('startCommunityBackend keeps a non-zero exit code and attaches diagnostics', async () => {
  const rootDir = '/repo';
  const logPath = path.join(rootDir, COLLAB_LOG);

  await assert.rejects(
    () =>
      startCommunityBackend({
        platform: 'darwin',
        rootDir,
        spawnSyncImpl: () => ({ status: 7 }),
        probeBackend: async () => ({
          healthy: false,
          checks: [
            {
              id: 'collab',
              ok: false,
              endpoint: 'http://127.0.0.1:4100/health',
              detail: 'Expected an HTTP 2xx response containing ok',
            },
          ],
        }),
        existsSyncImpl: (filePath) => filePath === logPath,
        readFileSyncImpl: () =>
          "Error: Cannot find module '@tabtin/config'\nexit",
      }),
    (error) => {
      assert.match(error.message, /退出码 7/);
      assert.match(error.message, /失败服务：Collab/);
      assert.match(
        error.message,
        /首个错误：Collab: Error: Cannot find module '@tabtin\/config'/,
      );
      assert.match(error.message, /collab-live\.log/);
      assert.match(
        error.message,
        /最后 12 行：\nError: Cannot find module '@tabtin\/config'\nexit/,
      );
      return true;
    },
  );
});

test('startCommunityBackend forces the community edition for the backend', async () => {
  let spawnOptions;
  await startCommunityBackend({
    platform: 'darwin',
    rootDir: '/repo',
    spawnSyncImpl: (_command, _args, options) => {
      spawnOptions = options;
      return { status: 0 };
    },
  });

  assert.equal(spawnOptions.env.TABTIN_EDITION, 'community');
});

test('startCommunityBackend still reports spawn errors without log archaeology', async () => {
  await assert.rejects(
    () =>
      startCommunityBackend({
        platform: 'darwin',
        rootDir: '/repo',
        spawnSyncImpl: () => ({ error: new Error('ENOENT') }),
        probeBackend: async () => {
          throw new Error('should not probe');
        },
      }),
    /后端启动失败: ENOENT/,
  );
});
