import { spawn, spawnSync } from 'node:child_process';

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

export function stopPort(
  port,
  platform = process.platform,
  spawnCommand = spawnSync,
) {
  if (platform === 'win32') {
    const script = [
      `$port=${port};`,
      'Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue',
      '| Select-Object -ExpandProperty OwningProcess -Unique',
      '| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
    ].join(' ');
    spawnCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        stdio: 'ignore',
      },
    );
    return;
  }

  const result = spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  const pids = String(result.stdout ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The process may already have exited.
    }
  }
  if (pids.length > 0) sleep(300);
}

export function resolveViteDevCommand(filter, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--filter', filter, 'dev'],
    };
  }
  return { command: 'pnpm', args: ['--filter', filter, 'dev'] };
}

export function runViteDev({ filter, port, label }) {
  stopPort(port);
  console.log(`[dev] 启动 ${label}: http://127.0.0.1:${port}`);

  const { command, args } = resolveViteDevCommand(filter);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error(`[dev] ${label} 启动失败: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
