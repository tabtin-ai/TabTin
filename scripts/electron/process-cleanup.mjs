#!/usr/bin/env node
/**
 * Clean up stale TabTin Electron dev processes.
 *
 * This is intentionally dev-only. Packaged TabTin uses a different app path and
 * should never be touched by this helper.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..', '..');
const defaultWorkspaceDir = path.dirname(defaultRootDir);

const sleep = (ms) => {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

function readProcesses() {
  if (process.platform === 'win32') {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return parseWindowsProcessList(output);
  }

  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], {
    encoding: 'utf8',
  });

  return parseProcessList(output);
}

export function parseWindowsProcessList(output, currentPid = process.pid) {
  const trimmed = output.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .filter((entry) => entry?.CommandLine)
    .map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      stat: '',
      command: String(entry.CommandLine),
    }))
    .filter((proc) => proc.pid > 0 && proc.pid !== currentPid);
}

export function parseProcessList(output) {
  return output
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      command: match[4],
    }))
    .filter((proc) => proc.pid > 0 && proc.pid !== process.pid);
}

function isTabTinDevElectronProcess(proc, context) {
  const command = proc.command.replace(/\\/g, '/').toLowerCase();
  const rootDir = context.rootDir.replace(/\\/g, '/').toLowerCase();
  const workspaceDir = context.workspaceDir.replace(/\\/g, '/').toLowerCase();
  if (context.currentOnly) {
    const belongsToCurrentRepo = command.includes(`${rootDir}/`);
    const isDevProcess =
      command.includes('/node_modules/.pnpm/electron@') ||
      command.includes('/electron-vite/') ||
      command.includes('/scripts/electron/dev.mjs');
    return belongsToCurrentRepo && isDevProcess;
  }

  if (!command.includes('/node_modules/.pnpm/electron@')) {
    return command.includes('/application support/tabtin dev');
  }

  const isCurrentRepoElectron = command.includes(`${rootDir}/node_modules/.pnpm/electron@`);
  const isSiblingTabTinElectron = command.includes(`${workspaceDir}/tabtin`);
  const usesDevProfile = command.includes('/application support/tabtin dev');
  return isCurrentRepoElectron || usesDevProfile || isSiblingTabTinElectron;
}

function isElectronMainProcess(proc) {
  return proc.command.includes('/Electron.app/Contents/MacOS/Electron');
}

function isStale(proc) {
  return proc.stat.includes('T') || (proc.ppid === 1 && isElectronMainProcess(proc));
}

function includeDescendants(processes, rootPids) {
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!selected.has(proc.pid) && selected.has(proc.ppid)) {
        selected.add(proc.pid);
        changed = true;
      }
    }
  }
  return selected;
}

export function selectElectronDevCleanupTargets(processes, options = {}) {
  const context = {
    rootDir: options.rootDir ?? defaultRootDir,
    workspaceDir: options.workspaceDir ?? defaultWorkspaceDir,
    currentOnly: options.currentOnly ?? false,
  };
  const killAll = options.killAll ?? false;
  const excludedPids = options.excludedPids ?? new Set();
  const roots = processes
    .filter((proc) => !excludedPids.has(proc.pid))
    .filter((proc) => isTabTinDevElectronProcess(proc, context))
    .filter((proc) => killAll || isStale(proc));
  const selectedPids = includeDescendants(processes, roots.map((proc) => proc.pid));
  return processes.filter((proc) => selectedPids.has(proc.pid));
}

function ancestorPids(processes, pid = process.ppid) {
  const parents = new Map(processes.map((proc) => [proc.pid, proc.ppid]));
  const result = new Set();
  while (pid > 0 && !result.has(pid)) {
    result.add(pid);
    pid = parents.get(pid);
  }
  return result;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have already exited.
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const killAll = args.has('--all');
  const currentOnly = args.has('--current-only');
  const dryRun = args.has('--dry-run');
  const quiet = args.has('--quiet');
  const processes = readProcesses();
  const targets = selectElectronDevCleanupTargets(processes, {
    killAll,
    currentOnly,
    excludedPids: ancestorPids(processes),
  });

  if (targets.length === 0) {
    if (!quiet) {
      console.log('[electron-cleanup] no stale TabTin Electron dev processes found');
    }
    return 0;
  }

  if (!quiet) {
    const mode = killAll ? 'all' : 'stale';
    const scope = currentOnly ? 'current repo ' : '';
    console.log(`[electron-cleanup] cleaning ${targets.length} ${scope}${mode} TabTin Electron dev process(es)`);
    for (const proc of targets) {
      console.log(`  pid=${proc.pid} ppid=${proc.ppid} stat=${proc.stat} ${proc.command}`);
    }
  }

  if (dryRun) {
    return 0;
  }

  for (const proc of targets) {
    killPid(proc.pid, 'SIGTERM');
  }
  sleep(800);
  for (const proc of targets) {
    if (isAlive(proc.pid)) {
      killPid(proc.pid, 'SIGKILL');
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
