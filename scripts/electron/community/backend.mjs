import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const DJANGO_HEALTH_URL = 'http://127.0.0.1:6060/health';
const COLLAB_HEALTH_URL = 'http://127.0.0.1:4100/health';
const CENTRIFUGO_HOST = '127.0.0.1';
const CENTRIFUGO_PORT = 8100;
const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_LOG_TAIL_LINES = 12;
const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
const ERROR_LINE_PATTERN =
  /error|exception|traceback|cannot find module|enoent|fatal|improperlyconfigured|failed to|启动失败/i;

export const BACKEND_SERVICE_LABELS = {
  django: 'Django',
  collab: 'Collab',
  centrifugo: 'Centrifugo',
};

export const BACKEND_SERVICE_LOGS = {
  django: path.join('apps', 'tabtin_django', 'logs', 'django-dev.log'),
  collab: path.join('apps', 'tabtin_django', 'logs', 'collab-live.log'),
  centrifugo: path.join('apps', 'tabtin_django', 'logs', 'centrifugo.log'),
};

export function resolveBackendCommand(platform, rootDir) {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'scripts\\backend\\start.bat'],
    };
  }

  return {
    command: 'bash',
    args: [path.posix.resolve(rootDir, 'scripts', 'backend', 'start.sh')],
  };
}

export async function probeCommunityBackend({
  probeHttp = defaultProbeHttp,
  probeTcp = defaultProbeTcp,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const checks = await Promise.all([
    probeHttpCheck(
      'django',
      DJANGO_HEALTH_URL,
      'healthy',
      probeHttp,
      timeoutMs,
    ),
    probeHttpCheck('collab', COLLAB_HEALTH_URL, 'ok', probeHttp, timeoutMs),
    probeTcpCheck(probeTcp, timeoutMs),
  ]);

  return {
    healthy: checks.every((check) => check.ok),
    checks,
  };
}

export async function waitForCommunityBackend({
  timeoutMs = 60_000,
  retryIntervalMs = 500,
  now = Date.now,
  sleep = defaultSleep,
  probeHttp,
  probeTcp,
} = {}) {
  const deadline = now() + timeoutMs;
  let report = createDeadlineReport();

  while (true) {
    const remainingBeforeProbeMs = deadline - now();
    if (remainingBeforeProbeMs <= 0) break;

    const probeTimeoutMs = Math.min(PROBE_TIMEOUT_MS, remainingBeforeProbeMs);
    report = await probeCommunityBackend({
      probeHttp,
      probeTcp,
      timeoutMs: probeTimeoutMs,
    });
    if (report.healthy) {
      return report;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;

    await sleep(Math.min(retryIntervalMs, remainingMs));
  }

  return report;
}

export function splitLogLines(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function takeLogTail(text, maxLines = DEFAULT_LOG_TAIL_LINES) {
  return splitLogLines(text).slice(-maxLines);
}

export function findFirstErrorLine(text) {
  return (
    splitLogLines(text).find((line) => ERROR_LINE_PATTERN.test(line)) ?? ''
  );
}

export function formatBackendFailure({
  report,
  rootDir = '',
  cause,
  tailLines = DEFAULT_LOG_TAIL_LINES,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  readFileSyncImpl = fs.readFileSync,
  existsSyncImpl = fs.existsSync,
} = {}) {
  const failedChecks = (report?.checks ?? []).filter((check) => !check.ok);
  const serviceNames = failedChecks.map(
    (check) => BACKEND_SERVICE_LABELS[check.id] ?? check.id,
  );
  const header =
    cause ??
    (serviceNames.length
      ? `后端启动失败：${serviceNames.join('、')} 未通过健康检查`
      : '后端启动失败');

  const logTargets = failedChecks.some((check) => BACKEND_SERVICE_LOGS[check.id])
    ? failedChecks.filter((check) => BACKEND_SERVICE_LOGS[check.id])
    : Object.keys(BACKEND_SERVICE_LOGS).map((id) => ({ id, ok: false }));

  const sections = [header];
  if (failedChecks.length) {
    sections.push(
      `失败服务：${failedChecks
        .map((check) => {
          const label = BACKEND_SERVICE_LABELS[check.id] ?? check.id;
          const endpoint = check.endpoint || 'unknown';
          const detail = check.detail || 'unhealthy';
          return `${label} (${endpoint} — ${detail})`;
        })
        .join('；')}`,
    );
  }

  let firstError = '';
  const logBlocks = [];
  for (const check of logTargets) {
    const label = BACKEND_SERVICE_LABELS[check.id] ?? check.id;
    const logPath = path.join(rootDir, BACKEND_SERVICE_LOGS[check.id]);
    if (!existsSyncImpl(logPath)) {
      logBlocks.push(`${label} 日志：${logPath}（文件不存在）`);
      continue;
    }

    let recentText = '';
    try {
      recentText = readRecentLogText(logPath, {
        readFileSyncImpl,
        maxBytes,
      });
    } catch {
      logBlocks.push(`${label} 日志：${logPath}（无法读取）`);
      continue;
    }

    if (!firstError) {
      const hit = findFirstErrorLine(recentText);
      if (hit) firstError = `${label}: ${hit.trim()}`;
    }

    const tail = takeLogTail(recentText, tailLines);
    logBlocks.push(`${label} 日志：${logPath}`);
    logBlocks.push(`最后 ${tailLines} 行：`);
    logBlocks.push(tail.length ? tail.join('\n') : '（日志为空）');
  }

  if (firstError) sections.push(`首个错误：${firstError}`);
  sections.push(...logBlocks);
  return sections.join('\n');
}

export async function startCommunityBackend({
  platform,
  rootDir,
  spawnSyncImpl = spawnSync,
  probeBackend = probeCommunityBackend,
  readFileSyncImpl = fs.readFileSync,
  existsSyncImpl = fs.existsSync,
} = {}) {
  const { command, args } = resolveBackendCommand(platform, rootDir);
  const result = spawnSyncImpl(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      TABTIN_EDITION: 'community',
    },
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw new Error(`后端启动失败: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`后端启动被信号 ${result.signal} 终止`);
  }
  if (result.status !== 0) {
    const report = await probeBackendSafely(probeBackend);
    throw new Error(
      formatBackendFailure({
        report,
        rootDir,
        cause: `后端启动失败，退出码 ${result.status}`,
        readFileSyncImpl,
        existsSyncImpl,
      }),
    );
  }
}

async function probeBackendSafely(probeBackend) {
  try {
    return await probeBackend();
  } catch (error) {
    return {
      healthy: false,
      checks: [
        {
          id: 'probe',
          ok: false,
          endpoint: '',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function readRecentLogText(filePath, { readFileSyncImpl, maxBytes }) {
  const text = String(readFileSyncImpl(filePath, 'utf8') ?? '');
  if (text.length <= maxBytes) return text;
  const sliced = text.slice(text.length - maxBytes);
  const newline = sliced.indexOf('\n');
  return newline === -1 ? sliced : sliced.slice(newline + 1);
}

function createDeadlineReport() {
  return {
    healthy: false,
    checks: [
      {
        id: 'django',
        ok: false,
        endpoint: DJANGO_HEALTH_URL,
        detail: 'Health-check deadline reached',
      },
      {
        id: 'collab',
        ok: false,
        endpoint: COLLAB_HEALTH_URL,
        detail: 'Health-check deadline reached',
      },
      {
        id: 'centrifugo',
        ok: false,
        endpoint: `${CENTRIFUGO_HOST}:${CENTRIFUGO_PORT}`,
        detail: 'Health-check deadline reached',
      },
    ],
  };
}

async function probeHttpCheck(
  id,
  endpoint,
  expectedText,
  probeHttp,
  timeoutMs,
) {
  try {
    const result = await probeHttp(endpoint, timeoutMs);
    const ok = result.ok && result.text.includes(expectedText);

    return {
      id,
      ok,
      endpoint,
      detail: ok
        ? 'healthy response'
        : `Expected an HTTP 2xx response containing ${expectedText}`,
    };
  } catch (error) {
    return { id, ok: false, endpoint, detail: error.message };
  }
}

async function probeTcpCheck(probeTcp, timeoutMs) {
  const endpoint = `${CENTRIFUGO_HOST}:${CENTRIFUGO_PORT}`;

  try {
    const ok = await probeTcp(CENTRIFUGO_HOST, CENTRIFUGO_PORT, timeoutMs);
    return {
      id: 'centrifugo',
      ok,
      endpoint,
      detail: ok ? 'TCP connection succeeded' : 'TCP connection failed',
    };
  } catch (error) {
    return { id: 'centrifugo', ok: false, endpoint, detail: error.message };
  }
}

async function defaultProbeHttp(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { ok: response.ok, text: await response.text() };
}

function defaultProbeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
