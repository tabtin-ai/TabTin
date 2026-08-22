import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnAgentShellProcess, ExecutionRootUnreachableError, SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER } from '../src';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe.skipIf(process.platform === 'win32')('spawnAgentShellProcess', () => {
  it('runs a one-shot shell process, merges stderr into stdout, and captures cwd with spaces', async () => {
    const startDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin agent start '));
    const nextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin agent cwd '));
    const terminalChunks: string[] = [];

    const handle = spawnAgentShellProcess({
      cwd: startDir,
      command: `printf 'out\\n'; printf 'err\\n' >&2; cd ${shellQuote(nextDir)}`,
      onOutput: (data) => terminalChunks.push(data),
    });
    const result = await handle.result;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('out\n');
    expect(result.output).toContain('err\n');
    expect(result.outputFilePath).toBeTruthy();
    expect(fs.readFileSync(result.outputFilePath!, 'utf8')).toContain('err\n');
    expect(result.cwd).toBe(fs.realpathSync(nextDir));
    expect(terminalChunks.join('')).toContain('out\r\n');
    fs.unlinkSync(result.outputFilePath!);
  });

  it('keeps the complete raw output file when inline output is truncated', async () => {
    const handle = spawnAgentShellProcess({
      command: `printf '0123456789abcdefghijklmnopqrstuvwxyz\\n'`,
      maxResultBytes: 10,
    });
    const result = await handle.result;

    expect(result.truncated).toBe(true);
    expect(result.output).toContain('...[output truncated by TabTin process runner]');
    expect(result.outputFilePath).toBeTruthy();
    expect(fs.readFileSync(result.outputFilePath!, 'utf8')).toBe('0123456789abcdefghijklmnopqrstuvwxyz\n');
    expect(result.outputFileSize).toBe(Buffer.byteLength('0123456789abcdefghijklmnopqrstuvwxyz\n', 'utf8'));
    fs.unlinkSync(result.outputFilePath!);
  });

  it('ignores unsupported SHELL values and falls back to a POSIX shell', async () => {
    const previousShell = process.env.SHELL;
    process.env.SHELL = '/bin/fish';
    try {
      const handle = spawnAgentShellProcess({
        command: `printf 'fallback-ok'`,
      });
      const result = await handle.result;

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('fallback-ok');
      if (result.outputFilePath) fs.unlinkSync(result.outputFilePath);
    } finally {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
  });

  it('terminates the process tree on foreground timeout', async () => {
    const handle = spawnAgentShellProcess({
      command: 'sleep 5',
      timeoutMs: 50,
      enforceTimeout: true,
    });
    const result = await handle.result;

    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(4_000);
  });

  // RT-2：执行根（Agent working_dir / cwd）不可达时，spawn 前同步抛
  // ExecutionRootUnreachableError，而不是把无效 cwd 喂给 child_process.spawn
  // 触发误导性的 `spawn /bin/zsh ENOENT`（详见 docs/overview/ai-issues-overview.md）。
  it('throws ExecutionRootUnreachableError (code, cwd) synchronously when cwd does not exist', () => {
    const missing = path.join(os.tmpdir(), `tabtin-rt2-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let caught: unknown;
    try {
      spawnAgentShellProcess({ command: 'df -h', cwd: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutionRootUnreachableError);
    expect((caught as ExecutionRootUnreachableError).code).toBe('EXECUTION_ROOT_UNREACHABLE');
    expect((caught as ExecutionRootUnreachableError).cwd).toBe(missing);
    expect((caught as ExecutionRootUnreachableError).reason).toBe('missing');
    expect((caught as Error).message).toMatch(/Execution root does not exist/);
  });

  it('throws ExecutionRootUnreachableError when cwd points at a file, not a directory', () => {
    const filePath = path.join(os.tmpdir(), `tabtin-rt2-file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filePath, 'x');
    try {
      let caught: unknown;
      try {
        spawnAgentShellProcess({ command: 'true', cwd: filePath });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ExecutionRootUnreachableError);
      expect((caught as ExecutionRootUnreachableError).reason).toBe('not_a_directory');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('still runs when cwd is omitted (falls back to process.cwd(), no false positive)', async () => {
    const handle = spawnAgentShellProcess({ command: `printf 'root-ok'` });
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('root-ok');
    if (result.outputFilePath) fs.unlinkSync(result.outputFilePath);
  });

  it('preserves Skill credential env keys via internal preserve marker', async () => {
    const secret = 'sk-long-enough-key';
    const handle = spawnAgentShellProcess({
      command: 'printf "%s" "$OPENAI_API_KEY"',
      env: {
        OPENAI_API_KEY: secret,
        [SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]: 'OPENAI_API_KEY',
      },
    });
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(secret);
    if (result.outputFilePath) fs.unlinkSync(result.outputFilePath);
  });
});
