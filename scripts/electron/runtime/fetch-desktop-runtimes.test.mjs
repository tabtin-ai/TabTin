import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourcesPath = join(
  scriptDirectory,
  'desktop-runtime-official-sources.json',
);
const officeConfigPath = join(
  scriptDirectory,
  '..',
  '..',
  '..',
  'packages',
  'office-preview-runtime',
  'runtime.config.json',
);
const fetchScript = join(scriptDirectory, 'fetch-desktop-runtimes.sh');

const ALLOWED_URL_PREFIXES = [
  'https://download.documentfoundation.org/',
  'https://github.com/oschwartz10612/poppler-windows/',
];

function collectUrls(value, found = []) {
  if (typeof value === 'string' && value.startsWith('http')) {
    found.push(value);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectUrls(child, found);
  }
  return found;
}

test('official runtime sources do not use Aliyun OSS', () => {
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  const urls = collectUrls(sources);
  assert.ok(urls.length >= 4, 'expected pinned official download URLs');
  for (const url of urls) {
    assert.equal(
      ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix)),
      true,
      `unexpected host: ${url}`,
    );
    assert.doesNotMatch(url, /aliyuncs|oss-cn|oss-ap/i);
  }
});

test('China runtime archives have pinned URLs, sizes, and checksums', () => {
  const config = JSON.parse(readFileSync(officeConfigPath, 'utf8'));
  const expected = {
    'darwin-arm64': 287927070,
    'darwin-x64': 299065607,
    'win32-x64': 512457014,
  };

  for (const [platform, size] of Object.entries(expected)) {
    const runtime = config.platforms[platform];
    assert.match(
      runtime.url,
      /^https:\/\/tabtin-cn-dev\.oss-cn-shanghai\.aliyuncs\.com\//,
    );
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    assert.equal(runtime.size, size);
  }
});

test('China region installs a verified prebuilt archive without the official source', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tabtin-office-runtime-region-'));
  try {
    const payloadRoot = join(tempRoot, 'payload');
    const runtimeRoot = join(tempRoot, 'runtime');
    const cacheDir = join(tempRoot, 'cache');
    const archivePath = join(tempRoot, 'office-preview-runtime.tar.gz');
    mkdirSync(join(payloadRoot, 'bin'), { recursive: true });
    writeFileSync(join(payloadRoot, 'bin', 'soffice'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    writeFileSync(join(payloadRoot, 'bin', 'pdftoppm'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    const tar = spawnSync(
      'tar',
      ['-czf', archivePath, '-C', payloadRoot, '.'],
      { encoding: 'utf8' },
    );
    assert.equal(tar.status, 0, tar.stderr);

    const archive = readFileSync(archivePath);
    const configPath = join(tempRoot, 'runtime.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        platforms: {
          'darwin-arm64': {
            url: new URL(`file://${archivePath}`).toString(),
            sha256: crypto.createHash('sha256').update(archive).digest('hex'),
            size: archive.length,
          },
        },
      }),
    );

    const result = spawnSync(
      'bash',
      [
        fetchScript,
        '--only',
        'office',
        '--platform',
        'darwin-arm64',
        '--region',
        'cn',
        '--strict',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TABTIN_DESKTOP_RUNTIME_CACHE_DIR: cacheDir,
          TABTIN_OFFICE_RUNTIME_CONFIG: configPath,
          TABTIN_OFFICE_RUNTIME_ROOT: runtimeRoot,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /国内地址优先预构建 OSS 归档/);
    assert.match(result.stdout, /SHA-256 校验/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('fetch-desktop-runtimes.sh prints usage', () => {
  const result = spawnSync('bash', [fetchScript, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /python-build-standalone/);
  assert.match(result.stdout, /LibreOffice/);
  assert.match(result.stdout, /--strict/);
  assert.match(result.stdout, /--platform/);
});

function runOfficeFetchWithFailingCurl(extraArgs = []) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cacheDir = join(tmpdir(), `tabtin-runtime-cache-${stamp}`);
  const binDir = join(tmpdir(), `tabtin-runtime-bin-${stamp}`);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'curl'),
    '#!/bin/bash\necho "simulated download failure: $*" >&2\nexit 22\n',
    { mode: 0o755 },
  );
  return spawnSync('bash', [fetchScript, '--only', 'office', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TABTIN_DESKTOP_RUNTIME_CACHE_DIR: cacheDir,
    },
  });
}

test('TABTIN_SKIP_DESKTOP_RUNTIME_FETCH skips work', () => {
  const result = spawnSync('bash', [fetchScript, '--only', 'office'], {
    encoding: 'utf8',
    env: { ...process.env, TABTIN_SKIP_DESKTOP_RUNTIME_FETCH: '1' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /TABTIN_SKIP_DESKTOP_RUNTIME_FETCH/);
});

test('office download failure warns and does not block', () => {
  const result = runOfficeFetchWithFailingCurl();
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /下载失败|simulated download failure/);
  assert.match(output, /不阻断启动\/打包/);
});

test('--strict office download failure exits 1', () => {
  const result = runOfficeFetchWithFailingCurl(['--strict']);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /--strict/);
});

test('global region tries official LibreOffice before the China archive', () => {
  const result = runOfficeFetchWithFailingCurl(['--region', 'global']);
  const output = `${result.stdout}\n${result.stderr}`;
  const officialIndex = output.indexOf('download.documentfoundation.org');
  const chinaIndex = output.indexOf(
    'tabtin-cn-dev.oss-cn-shanghai.aliyuncs.com',
  );
  assert.ok(officialIndex >= 0, output);
  assert.ok(chinaIndex > officialIndex, output);
});

test('--platform selects architecture-specific office source', () => {
  const result = spawnSync(
    'bash',
    [fetchScript, '--only', 'office', '--platform', 'linux-x64'],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /目标平台\/架构: linux-x64/);
  assert.match(output, /linux-x64/);
});

test('bat and sh fetch entrypoints do not call each other', () => {
  const bat = readFileSync(
    join(scriptDirectory, 'fetch-desktop-runtimes.bat'),
    'utf8',
  );
  const ps1 = readFileSync(
    join(scriptDirectory, 'fetch-desktop-runtimes.ps1'),
    'utf8',
  );
  const sh = readFileSync(fetchScript, 'utf8');
  const ensureBat = readFileSync(
    join(scriptDirectory, '_ensure-desktop-runtimes.bat'),
    'utf8',
  );
  const ensureSh = readFileSync(
    join(scriptDirectory, '_ensure-desktop-runtimes.sh'),
    'utf8',
  );
  assert.match(bat, /fetch-desktop-runtimes\.ps1/);
  assert.doesNotMatch(bat, /fetch-desktop-runtimes\.sh/);
  assert.doesNotMatch(ps1, /fetch-desktop-runtimes\.sh/);
  assert.doesNotMatch(
    sh,
    /fetch-desktop-runtimes\.bat|fetch-desktop-runtimes\.ps1/,
  );
  for (const source of [ps1, sh]) {
    assert.match(source, /resolve-office-runtime-region/);
    assert.match(source, /TABTIN_RUNTIME_REGION/);
    assert.match(source, /sha256|SHA256/i);
  }
  assert.match(ensureBat, /fetch-desktop-runtimes\.bat/);
  assert.doesNotMatch(ensureBat, /\.sh\b/);
  assert.match(ensureSh, /fetch-desktop-runtimes\.sh/);
  assert.doesNotMatch(ensureSh, /\.bat\b/);
});

test('startup runtime helpers skip the optional office download by default', () => {
  const ensureBat = readFileSync(
    join(scriptDirectory, '_ensure-desktop-runtimes.bat'),
    'utf8',
  );
  const ensureSh = readFileSync(
    join(scriptDirectory, '_ensure-desktop-runtimes.sh'),
    'utf8',
  );

  for (const source of [ensureBat, ensureSh]) {
    assert.match(source, /TABTIN_FETCH_OFFICE_RUNTIME_ON_START/);
    assert.match(source, /--only python/);
  }
});

test('start and electron launchers reuse _ensure-desktop-runtimes', () => {
  const repoRoot = join(scriptDirectory, '..', '..', '..');
  const launchers = [
    'start.sh',
    'start.bat',
    'scripts/backend/start.sh',
    'scripts/backend/start.bat',
    'scripts/electron/start.sh',
    'scripts/electron/start.bat',
    'scripts/electron/restart.sh',
    'scripts/electron/restart.bat',
  ];
  for (const relativePath of launchers) {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8');
    assert.match(
      source,
      /_ensure-desktop-runtimes/,
      `${relativePath} must call the shared runtime fetch helper`,
    );
  }
});
