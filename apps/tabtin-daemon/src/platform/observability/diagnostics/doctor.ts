import fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { DaemonConfig } from '../../../base/types/daemon-config.js';

interface DoctorConfigPort {
  exists(): boolean;
  getConfigPath(): string;
  getConfigDir(): string;
  getLogPath(): string;
  getPidPath(): string;
  load(): DaemonConfig;
}
import { StateWriter, type DaemonState } from './state-writer.js';

interface CheckResult {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL';
  detail: string;
}

const REQUIRED_NODE_MAJOR = 18;

export async function runDoctor(configManager: DoctorConfigPort): Promise<void> {
  console.log('\nTabTin Daemon Doctor\n');
  const results: CheckResult[] = [];

  results.push(checkConfig(configManager));
  results.push(await checkBackendApi(configManager));
  results.push(await checkWebSocket(configManager));
  results.push(checkToken(configManager));
  results.push(checkNodeVersion());
  results.push(checkDaemonProcess(configManager));
  results.push(checkRipgrep());
  results.push(checkRecentErrors(configManager));

  const maxNameLen = Math.max(...results.map(r => r.name.length));
  for (const r of results) {
    const icon = r.status === 'OK' ? '  ✅' : r.status === 'WARN' ? '  ⚠️' : '  ❌';
    console.log(`${icon}  ${r.name.padEnd(maxNameLen + 2)}${r.status.padEnd(6)} ${r.detail}`);
  }

  const failCount = results.filter(r => r.status === 'FAIL').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  console.log('');
  if (failCount > 0) {
    console.log(`${failCount} check(s) failed. Please fix the issues above.`);
  } else if (warnCount > 0) {
    console.log(`All critical checks passed, ${warnCount} warning(s).`);
  } else {
    console.log('All checks passed!');
  }
}

function checkConfig(cm: DoctorConfigPort): CheckResult {
  if (!cm.exists()) {
    return { name: 'Config', status: 'FAIL', detail: `Not found at ${cm.getConfigPath()}` };
  }
  try {
    const config = cm.load();
    const required = ['server_url', 'ws_url', 'device_id', 'credential', 'organization_id'] as const;
    const missing = required.filter(k => !(config as any)[k]);
    if (missing.length > 0) {
      return { name: 'Config', status: 'FAIL', detail: `Missing fields: ${missing.join(', ')}` };
    }
    return { name: 'Config', status: 'OK', detail: cm.getConfigPath() };
  } catch (err) {
    return { name: 'Config', status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkBackendApi(cm: DoctorConfigPort): Promise<CheckResult> {
  if (!cm.exists()) return { name: 'Backend API', status: 'FAIL', detail: 'no config' };
  const config = cm.load();
  const url = `${config.server_url}/health`;
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const ms = Date.now() - start;
    if (resp.ok) {
      return { name: 'Backend API', status: 'OK', detail: `${config.server_url} (${ms}ms)` };
    }
    return { name: 'Backend API', status: 'WARN', detail: `HTTP ${resp.status} (${ms}ms)` };
  } catch (err) {
    return { name: 'Backend API', status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkWebSocket(cm: DoctorConfigPort): Promise<CheckResult> {
  if (!cm.exists()) return { name: 'WebSocket', status: 'FAIL', detail: 'no config' };
  const config = cm.load();
  const wsUrl = config.ws_url;
  const start = Date.now();
  try {
    const httpUrl = wsUrl.replace(/^ws/, 'http');
    const resp = await fetch(httpUrl, { signal: AbortSignal.timeout(10_000) });
    const ms = Date.now() - start;
    return { name: 'WebSocket', status: 'OK', detail: `${wsUrl} (${ms}ms)` };
  } catch (err) {
    const ms = Date.now() - start;
    if (ms < 10_000) {
      return { name: 'WebSocket', status: 'WARN', detail: `Connection refused/reset — is WS server running?` };
    }
    return { name: 'WebSocket', status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkToken(cm: DoctorConfigPort): CheckResult {
  if (!cm.exists()) return { name: 'Token', status: 'FAIL', detail: 'no config' };
  const config = cm.load();
  const token = config.credential;
  if (!token) return { name: 'Token', status: 'FAIL', detail: 'no credential stored' };
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { name: 'Token', status: 'WARN', detail: 'not a JWT format' };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const exp = payload.exp;
    if (!exp) return { name: 'Token', status: 'WARN', detail: 'no expiry claim in token' };
    const expiresAt = new Date(exp * 1000);
    if (expiresAt < new Date()) {
      return { name: 'Token', status: 'FAIL', detail: `expired ${expiresAt.toISOString()}` };
    }
    return { name: 'Token', status: 'OK', detail: `expires ${expiresAt.toISOString().slice(0, 10)}` };
  } catch {
    return { name: 'Token', status: 'WARN', detail: 'unable to decode token' };
  }
}

function checkNodeVersion(): CheckResult {
  const ver = process.version;
  const major = parseInt(ver.slice(1), 10);
  if (major >= REQUIRED_NODE_MAJOR) {
    return { name: 'Node.js', status: 'OK', detail: ver };
  }
  return { name: 'Node.js', status: 'FAIL', detail: `${ver} (require >= ${REQUIRED_NODE_MAJOR})` };
}

function checkDaemonProcess(cm: DoctorConfigPort): CheckResult {
  const state: DaemonState | null = StateWriter.readState(cm);
  if (!state) {
    const pidPath = cm.getPidPath();
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        return { name: 'Daemon process', status: 'OK', detail: `PID ${pid} (no state file)` };
      } catch {
        return { name: 'Daemon process', status: 'WARN', detail: 'stale PID file (process not running)' };
      }
    }
    return { name: 'Daemon process', status: 'WARN', detail: 'not running' };
  }
  try {
    process.kill(state.pid, 0);
  } catch {
    return { name: 'Daemon process', status: 'WARN', detail: 'state.json exists but process not running' };
  }
  const uptime = formatDuration(state.uptime_seconds);
  return { name: 'Daemon process', status: 'OK', detail: `PID ${state.pid}, uptime ${uptime}` };
}

function checkRipgrep(): CheckResult {
  try {
    const output = execSync('rg --version', { stdio: 'pipe', timeout: 5000 }).toString().trim();
    const firstLine = output.split('\n')[0] ?? output;
    return { name: 'ripgrep', status: 'OK', detail: firstLine };
  } catch {
    return { name: 'ripgrep', status: 'WARN', detail: 'not found (file search will use fallback)' };
  }
}

function checkRecentErrors(cm: DoctorConfigPort): CheckResult {
  const logPath = cm.getLogPath();
  if (!fs.existsSync(logPath)) {
    return { name: 'Recent errors', status: 'OK', detail: 'no log file' };
  }
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const lastN = lines.slice(-200);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let errorCount = 0;
    let warnCount = 0;
    for (const line of lastN) {
      const tsMatch = line.match(/^\[([^\]]+)\]/);
      if (!tsMatch) continue;
      const ts = new Date(tsMatch[1]).getTime();
      if (isNaN(ts) || ts < oneHourAgo) continue;
      if (line.includes('[ERROR]')) errorCount++;
      else if (line.includes('[WARN]')) warnCount++;
    }
    if (errorCount > 0) {
      return { name: 'Recent errors', status: 'WARN', detail: `${errorCount} error(s), ${warnCount} warning(s) in last hour` };
    }
    if (warnCount > 0) {
      return { name: 'Recent errors', status: 'OK', detail: `${warnCount} warning(s) in last hour` };
    }
    return { name: 'Recent errors', status: 'OK', detail: 'no errors in last hour' };
  } catch {
    return { name: 'Recent errors', status: 'WARN', detail: 'unable to read log file' };
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
