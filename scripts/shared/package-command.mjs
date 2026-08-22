import { spawnSync } from 'node:child_process';

export function pnpmPlan(args, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    };
  }
  return { command: 'pnpm', args };
}

export function runPackagePlan(plan, { dryRun = false } = {}) {
  console.log(`[package] ${plan.command} ${plan.args.join(' ')}`);
  if (dryRun) return 0;

  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? (result.signal ? 1 : 0);
}
