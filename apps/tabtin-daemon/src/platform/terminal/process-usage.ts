import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessUsageEntry } from '@tabtin/pty-core';

const execFileAsync = promisify(execFile);
const PROCESS_LIST_TIMEOUT_MS = 5000;

const normalizeFinite = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, v) : 0;

function parsePsLine(line: string): ProcessUsageEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/, 5);
  if (parts.length < 5) return null;

  const pid = Number.parseInt(parts[0] ?? '', 10);
  const ppid = Number.parseInt(parts[1] ?? '', 10);
  const cpu = Number.parseFloat(parts[2] ?? '');
  const rssKb = Number.parseInt(parts[3] ?? '', 10);
  const command = parts[4] ?? '';

  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(ppid) || ppid < 0) return null;

  return {
    pid,
    ppid,
    cpu: normalizeFinite(cpu),
    memory: normalizeFinite(rssKb) * 1024,
    command,
  };
}

async function collectUnixProcessTable(): Promise<Map<number, ProcessUsageEntry>> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='],
    { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );

  const processMap = new Map<number, ProcessUsageEntry>();
  for (const line of stdout.split('\n')) {
    const entry = parsePsLine(line);
    if (entry) processMap.set(entry.pid, entry);
  }
  return processMap;
}

export async function collectProcessUsageTable(): Promise<Map<number, ProcessUsageEntry>> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return new Map();
  }
  try {
    return await collectUnixProcessTable();
  } catch {
    return new Map();
  }
}
