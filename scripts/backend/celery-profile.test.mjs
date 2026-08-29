import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const platformSh = path.join(backendDir, '_celery-platform.sh');
const startSh = path.join(backendDir, 'celery-start.sh');
const startBat = path.join(backendDir, 'celery-start.bat');
const WORKERS = [
  'critical',
  'default',
  'realtime',
  'data-ai',
  'heavy',
  'ai-background',
  'tracker',
  'search',
];
const COMMUNITY_WORKERS = ['critical', 'default', 'realtime'];

function listStartedWorkers(profile) {
  const env = { ...process.env };
  if (profile === undefined) {
    delete env.CELERY_PROFILE;
  } else {
    env.CELERY_PROFILE = profile;
  }
  const script = [
    `source '${platformSh}'`,
    'for name in critical default realtime data-ai heavy ai-background tracker search; do',
    '  if _celery_should_start_worker "$name"; then echo "$name"; fi',
    'done',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('community celery profile starts critical, default, and realtime', () => {
  for (const profile of [undefined, '', 'community', 'lite']) {
    assert.deepEqual(
      listStartedWorkers(profile),
      COMMUNITY_WORKERS,
      `CELERY_PROFILE=${profile ?? '(unset)'}`,
    );
  }
});

test('full celery profile starts every worker', () => {
  assert.deepEqual(listStartedWorkers('full'), WORKERS);
  assert.deepEqual(listStartedWorkers('FULL'), WORKERS);
});

test('celery-start.sh gates optional workers and always starts beat', () => {
  const source = readFileSync(startSh, 'utf8');
  for (const name of WORKERS) {
    assert.match(
      source,
      new RegExp(`_celery_should_start_worker ${name}`),
      `celery-start.sh must consult profile before ${name}`,
    );
  }
  assert.match(source, /celery -A tabtin beat/);
});

test('celery-start.bat keeps the community default and full opt-in', () => {
  const source = readFileSync(startBat, 'utf8');
  assert.match(source, /if \/I not "%CELERY_PROFILE%"=="full" goto beat/);
  assert.match(source, /call :worker critical "critical"/);
  assert.match(source, /call :worker default "default,low_priority"/);
  assert.match(source, /call :worker realtime "realtime_delivery"/);
  assert.match(source, /call :worker data-ai /);
  assert.match(source, /call :worker search "search_indexing"/);
  assert.match(source, /celery','-A','tabtin','beat'/);
});
