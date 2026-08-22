// eslint-disable-next-line @typescript-eslint/no-require-imports -- banner provides `require` via createRequire
(globalThis as any).require ??= (typeof require !== 'undefined' ? require : undefined);

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { ConfigManager } from '../platform/system/config/config-manager.js';
import type { DaemonConfig, LastExitInfo } from '../base/types/daemon-config.js';
import { TabTinDaemon } from '../bootstrap/daemon.js';
import { ServiceInstaller } from '../platform/system/process/service-installer.js';
import { TokenAuth } from '../transport/gateway/auth.js';
import { StateWriter } from '../platform/observability/diagnostics/state-writer.js';
import { runDoctor } from '../platform/observability/diagnostics/doctor.js';
import { viewLogs, parseDuration } from '../platform/observability/diagnostics/log-viewer.js';
import { fixProcessPath } from '../platform/system/process/fix-process-path.js';
import { createDaemonStorageApplication } from '../application/storage/daemon-storage.js';
import { NodeStorageFileSystem } from '../platform/storage/node-storage-file-system.js';

const storageApplication = createDaemonStorageApplication(new NodeStorageFileSystem());

// Allowlist of DaemonConfig keys that `config --set` is permitted to write.
// Excludes credential (managed via `init`) and derived read-only fields.
const CONFIG_SETTABLE_KEYS: ReadonlySet<keyof DaemonConfig> = new Set([
  'log_level',
  'log_file',
  'heartbeat_interval_ms',
  'proxy',
  'workspace_root',
  'device_name',
  'sentry_dsn',
  'daemon_control_enabled',
  'daemon_control_api_base_url',
]);

const program = new Command();

program
  .name('tabtin-daemon')
  .description('TabTin Agent Daemon — headless execution runtime for remote servers')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize daemon with an install token')
  .option('--token <token>', 'Install token from TabTin')
  .option('--token-stdin', 'Read token from stdin (avoids exposing token in ps)')
  .option('--server <url>', 'Override server URL')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--force', 'Overwrite existing configuration')
  .action(handleInit);

async function handleInit(opts: {
  configDir?: string; force?: boolean; token?: string; tokenStdin?: boolean; server?: string;
}): Promise<void> {
    const configManager = new ConfigManager(opts.configDir);
    if (configManager.exists() && !opts.force) {
      console.log('Daemon already initialized. Use --force to reinitialize.');
      return;
    }

    const token = await readInitToken(opts);
    if (!token) {
      console.error('Token is required. Use --token <token> or --token-stdin.');
      process.exit(1);
    }

    try {
      // LH2-D2：--force 切账号（owner 变化）时清理旧 owner 的 sync 目录，
      // 避免历史 transcript 永久留存在磁盘上（既占空间，又会持续在 daemon
      // 启动时触发 owner mismatch telemetry 噪音）。
      // daemon 当前是 explicit 单 organization / 单 owner 模型（Device.organization ForeignKey 1:1）：
      // 切 owner 必须 `init --force` 重新激活，多 organization 用户应装多个 daemon。
      // **只清旧 owner 桶，不清整个 syncRoot**——保守起见避免误伤未来可能落到 syncRoot
      // 下的非 owner 子目录（telemetry / 临时 buffer 等）。
      const oldOwner = readOldOwner(opts.force === true, configManager);
      if (opts.force) {
        configManager.deleteFingerprint();
      }
      const auth = new TokenAuth(configManager);
      const config = await auth.activateToken(token, opts.server);
      // Clear any auth-fatal cooldown marker from a previous run
      const initExitMarker = join(configManager.getConfigDir(), 'last-exit.json');
      try { if (fs.existsSync(initExitMarker)) fs.unlinkSync(initExitMarker); } catch { /* best effort */ }

      // LH2-D2：写完新 config 后再清旧 owner 目录——避免清理失败把整个 init
      // 流程拒了。需要"新 owner 与旧 owner 不同"才清，避免 force 重入同一
      // owner 时反而清掉用户自己的待同步数据。
      await clearPreviousOwnerSync(oldOwner, config.user_id, config.organization_id);

      console.log(`Daemon initialized successfully.`);
      console.log(`  Device: ${config.device_name}`);
      console.log(`  ID:     ${config.device_id}`);
      console.log(`  Server: ${config.server_url}`);
      console.log(`\n下一步：`);
      console.log(`  1. tabtin-daemon start            启动 Daemon`);
      console.log(`  2. tabtin-daemon service install   安装为系统服务（推荐）`);
      console.log(`  3. tabtin-daemon doctor            验证环境配置`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate.?limit/i.test(msg)) {
        console.error('Init failed: 请求过于频繁，请等待 60 秒后重试。');
      } else if (/403|expired|invalid.*token/i.test(msg)) {
        console.error('Init failed: Install token 已过期或已使用，请在管理后台重新生成。');
      } else if (/409|fingerprint.?conflict/i.test(msg)) {
        console.error('Init failed: 设备指纹冲突，请使用 --force 重新初始化。');
      } else {
        console.error('Init failed:', msg);
      }
      process.exit(1);
    }
}

async function readInitToken(opts: { token?: string; tokenStdin?: boolean }): Promise<string> {
  if (!opts.tokenStdin) return opts.token ?? '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString().trim();
}

function readOldOwner(force: boolean, configManager: ConfigManager): { userId: string; organizationId: string } | null {
  if (!force || !configManager.exists()) return null;
  try {
    const config = configManager.load();
    return config.user_id && config.organization_id
      ? { userId: config.user_id, organizationId: config.organization_id }
      : null;
  } catch { return null; }
}

async function clearPreviousOwnerSync(
  owner: { userId: string; organizationId: string } | null,
  userId?: string,
  organizationId?: string,
): Promise<void> {
  if (!owner || (owner.userId === userId && owner.organizationId === organizationId)) return;
  try {
    const { getDaemonHomePath } = await import('@tabtin/shared/storage-paths');
    const { clearSyncAccountDir } = await import('@tabtin/agent-runtime');
    if (await clearSyncAccountDir(getDaemonHomePath('agent-sync'), owner)) {
      console.log(`  Cleared old account sync dir: ${owner.userId}/${owner.organizationId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Warning: failed to clear old account sync dir (${owner.userId}/${owner.organizationId}): ${message}`);
  }
}

program
  .command('start')
  .description('Start the daemon process')
  .option('--config-dir <path>', 'Custom config directory')
  .action(handleStart);

async function handleStart(opts: { configDir?: string }): Promise<void> {
    // 修复 daemon 进程 PATH —— 解决 systemd / launchd 启动时 PATH 极简
    // 导致 grep_search (rg) / run_terminal_command (用户安装的 pnpm/python3/
    // cargo/...) 找不到二进制的问题。详见 system/fix-process-path.ts 注释。
    //
    // 失败永不阻塞 daemon 启动 —— 函数内部已 try/catch，最坏保留原 PATH。
    try {
      const result = fixProcessPath();
      if (result.source !== 'unchanged') {
        console.log(`[daemon] PATH 修复: ${result.source} —— ${result.message}`);
      }
    } catch (err) {
      console.warn('[daemon] fix-process-path 抛错（已忽略，保留原 PATH）:', err instanceof Error ? err.message : err);
    }

    const EXIT_CODE_AUTH_FATAL = 78;
    const configManager = new ConfigManager(opts.configDir);
    if (!configManager.exists()) {
      console.error("Daemon not initialized. Run 'tabtin-daemon init --token <token>' first.");
      process.exit(1);
    }

    enforceStartCooldown(configManager, EXIT_CODE_AUTH_FATAL);

    const pidPath = configManager.getPidPath();
    if (fs.existsSync(pidPath)) {
      const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(existingPid, 0);
        console.error(`Daemon already running (PID ${existingPid}). Use 'tabtin-daemon stop' first.`);
        process.exit(1);
      } catch {
        fs.unlinkSync(pidPath);
      }
    }

    try {
      const daemon = new TabTinDaemon(configManager);
      await daemon.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Another daemon')) {
        const stale = isPidStale(configManager);
        if (stale) {
          console.log('Previous daemon was killed unexpectedly. Cleaning up stale lock...');
          forceCleanupLock(configManager);
          try {
            const daemon = new TabTinDaemon(configManager);
            await daemon.start();
            return;
          } catch (retryErr) {
            console.error('Retry failed:', retryErr instanceof Error ? retryErr.message : retryErr);
            process.exit(1);
          }
        }
      }
      console.error('Failed to start daemon:', msg);
      console.error("运行 'tabtin-daemon doctor' 诊断问题。");
      process.exit(1);
    }
}

function enforceStartCooldown(configManager: ConfigManager, fatalExitCode: number): void {
  const lastExitPath = join(configManager.getConfigDir(), 'last-exit.json');
  if (!fs.existsSync(lastExitPath)) return;
  try {
    const lastExit = JSON.parse(fs.readFileSync(lastExitPath, 'utf-8')) as Partial<LastExitInfo>;
    const isAuthFatal = ['auth_fatal', 'device_removed'].includes(lastExit.reason ?? '');
    const cooldownMs = 10 * 60 * 1000;
    const elapsed = Date.now() - (lastExit.timestamp ?? 0);
    if (isAuthFatal && elapsed < cooldownMs) {
      const hint = lastExit.reason === 'device_removed'
        ? "设备已被管理员移除。请联系管理员重新创建设备并获取安装 token，然后执行 'tabtin-daemon init --token <new-token> --force'。"
        : "Token 已过期或失效。请在管理后台获取新 token，执行 'tabtin-daemon init --token <new-token> --force' 重新初始化。";
      console.error(`[Daemon] 因认证失败退出（${lastExit.message || ''}）。\n${hint}\n或等待 ${Math.ceil((cooldownMs - elapsed) / 60000)} 分钟后重试。`);
      process.exit(fatalExitCode);
    }
    fs.unlinkSync(lastExitPath);
  } catch {
    try { fs.unlinkSync(lastExitPath); } catch { /* best effort */ }
  }
}

program
  .command('stop')
  .description('Stop the running daemon')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--drain', 'Gracefully drain active tasks before stopping')
  .option('--timeout <minutes>', 'Max wait time in minutes (with --drain)', '10')
  .action(async (opts) => {
    const configManager = new ConfigManager(opts.configDir);
    if (opts.drain) {
      await drainDaemon(configManager, parseInt(opts.timeout, 10) || 10);
      return;
    }
    const pidPath = configManager.getPidPath();
    if (!fs.existsSync(pidPath)) {
      console.log('No running daemon found.');
      return;
    }
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to daemon (PID ${pid}).`);
    } catch {
      console.log('Daemon process not found. Cleaning up PID file.');
      fs.unlinkSync(pidPath);
    }
  });

program
  .command('status')
  .description('Show daemon status')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--format <format>', 'Output format: text | json', 'text')
  .action(handleStatus);

function handleStatus(opts: { configDir?: string; format?: string }): void {
    const configManager = new ConfigManager(opts.configDir);
    const jsonOutput = opts.format === 'json';

    if (!configManager.exists()) {
      if (jsonOutput) {
        console.log(JSON.stringify({ status: 'not_initialized' }, null, 2));
      } else {
        console.log('Status: not initialized');
      }
      return;
    }

    const config = configManager.load();
    const pidPath = configManager.getPidPath();
    let running = false;
    let pid: number | null = null;
    if (fs.existsSync(pidPath)) {
      pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        pid = null;
      }
    }

    const state = StateWriter.readState(configManager);
    const pad = (label: string) => (label + ':').padEnd(15);

    if (running) {
      printRunningStatus(state, pid, jsonOutput, pad);
    } else {
      printStoppedStatus(configManager, jsonOutput, pad);
    }

    console.log(`${pad('Device')}${config.device_name}`);
    console.log(`${pad('Device ID')}${config.device_id}`);
    console.log(`${pad('Server')}${config.server_url}`);
    console.log(`${pad('Config')}${configManager.getConfigPath()}`);
}

function printRunningStatus(state: ReturnType<typeof StateWriter.readState>, pid: number | null, jsonOutput: boolean, pad: (label: string) => string): void {
  if (jsonOutput) { console.log(JSON.stringify(state ?? { status: 'running', pid }, null, 2)); return; }
  if (!state) { console.log(`${pad('Status')}running`); if (pid) console.log(`${pad('PID')}${pid}`); return; }
  const isDraining = Boolean(state.drain_started_at);
  const parts = [`${state.active_actions} task(s) remaining`];
  if (isDraining && state.drain_timeout_ms) {
    const remaining = Math.max(0, state.drain_timeout_ms - (Date.now() - new Date(state.drain_started_at!).getTime()));
    parts.push(`timeout in ${formatDuration(remaining)}`);
  }
  console.log(`${pad('Status')}${isDraining ? `draining (${parts.join(', ')})` : 'running'}`);
  console.log(`${pad('PID')}${state.pid}`); console.log(`${pad('Version')}${state.version}`);
  console.log(`${pad('Uptime')}${formatUptime(state.uptime_seconds)}`); console.log(`${pad('WS')}${state.ws_status}`);
  const heartbeat = state.last_heartbeat_success_at ?? state.last_heartbeat_at;
  console.log(`${pad('Heartbeat')}${heartbeat ? `${heartbeat} (${formatRelativeTime(heartbeat)})` : 'n/a'}`);
  console.log(`${pad('Token')}${state.token_expires_at ? formatTokenExpiry(state.token_expires_at) : 'n/a'}`);
  console.log(`${pad('Active Tasks')}${state.active_actions}`); console.log(`${pad('Offline Queue')}${state.offline_buffer_pending ?? 0} messages`);
  console.log(`${pad('Reconnects')}${state.ws_reconnect_count ?? 0}`);
}

function printStoppedStatus(configManager: ConfigManager, jsonOutput: boolean, pad: (label: string) => string): void {
  let lastExit: Partial<LastExitInfo> | null = null;
  try { const path = join(configManager.getConfigDir(), 'last-exit.json'); if (fs.existsSync(path)) lastExit = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch { /* ignore */ }
  if (jsonOutput) { console.log(JSON.stringify(lastExit ? { status: 'stopped', last_exit: lastExit } : { status: 'stopped' }, null, 2)); return; }
  console.log(`${pad('Status')}stopped${lastExit?.exit_code !== undefined ? ` (exit ${lastExit.exit_code})` : ''}`);
  if (lastExit?.message) console.log(`${pad('Last Exit')}${lastExit.message}`);
  const action = lastExit ? getActionHint(lastExit) : null;
  if (action) console.log(`${pad('Action')}${action}`);
}

program
  .command('config')
  .description('Show or update configuration')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--set <key=value>', 'Set a config value')
  .action((opts) => {
    const configManager = new ConfigManager(opts.configDir);
    if (!configManager.exists()) {
      console.error('Daemon not initialized.');
      process.exit(1);
    }
    const config = configManager.load();
    if (opts.set) {
      const eqIdx = opts.set.indexOf('=');
      if (eqIdx === -1) {
        console.error('Usage: --set key=value');
        process.exit(1);
      }
      const key = opts.set.slice(0, eqIdx);
      const value = opts.set.slice(eqIdx + 1);

      if (!CONFIG_SETTABLE_KEYS.has(key as keyof DaemonConfig)) {
        console.error(
          `Error: '${key}' is not a settable config key.\n` +
          `Allowed keys: ${[...CONFIG_SETTABLE_KEYS].join(', ')}`,
        );
        process.exit(1);
      }

      if (key === 'daemon_control_enabled') {
        if (value !== 'true' && value !== 'false') {
          console.error(`Error: '${key}' must be true or false.`);
          process.exit(1);
        }
        config.daemon_control_enabled = value === 'true';
      } else {
        (config as unknown as Record<string, unknown>)[key] = value;
      }
      configManager.save(config);
      console.log(`Set ${key} = ${value}`);
    } else {
      const sanitized = { ...config, credential: '***' };
      console.log(JSON.stringify(sanitized, null, 2));
    }
  });

program
  .command('service')
  .description('Manage system service (install/uninstall)')
  .argument('<action>', 'install or uninstall')
  .option('--config-dir <path>', 'Custom config directory')
  .action((action: string, opts) => {
    const configManager = new ConfigManager(opts.configDir);
    const installer = new ServiceInstaller(configManager);
    if (action === 'install') {
      installer.install();
      console.log('Service installed.');
    } else if (action === 'uninstall') {
      installer.uninstall();
      console.log('Service uninstalled.');
    } else {
      console.error(`Unknown action: ${action}. Use 'install' or 'uninstall'.`);
      process.exit(1);
    }
  });

program
  .command('install-plugin')
  .description('Install an optional plugin (e.g., browser, crawl)')
  .argument('<plugin>', 'Plugin name')
  .option('--config-dir <path>', 'Custom config directory')
  .action((plugin: string, opts) => {
    const configManager = new ConfigManager(opts.configDir);
    if (!configManager.exists()) {
      console.error('Daemon not initialized.');
      process.exit(1);
    }
    console.log(`Installing plugin: ${plugin}...`);
    try {
      execSync(`npm install -g @tabtin/daemon-plugin-${plugin}`, { stdio: 'inherit' });
      const config = configManager.load();
      if (!config.plugins.includes(plugin)) {
        config.plugins.push(plugin);
        configManager.save(config);
      }
      console.log(`Plugin '${plugin}' installed successfully.`);
    } catch {
      console.error(`Failed to install plugin '${plugin}'.`);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('查看 Daemon 运行日志')
  .option('--follow', '实时追踪日志')
  .option('--lines <n>', '显示最近 N 行', '50')
  .option('--level <level>', '按日志级别过滤 (error|warn|info|debug)')
  .option('--since <duration>', '时间范围 (1h|30m|2d)')
  .option('--format <format>', '输出格式 (text|json)', 'text')
  .option('--config-dir <path>', '自定义配置目录')
  .action((opts) => {
    const configManager = new ConfigManager(opts.configDir);
    let logPath: string;
    if (configManager.exists()) {
      const config = configManager.load();
      logPath = config.log_file ?? configManager.getLogPath();
    } else {
      logPath = configManager.getLogPath();
    }

    const lineCount = parseInt(opts.lines, 10);
    if (isNaN(lineCount) || lineCount <= 0) {
      console.error(`Invalid --lines value: '${opts.lines}'. Must be a positive integer.`);
      process.exit(1);
    }

    const validLevels = ['error', 'warn', 'info', 'debug'] as const;
    if (opts.level && !validLevels.includes(opts.level)) {
      console.error(`Invalid --level value: '${opts.level}'. Must be one of: ${validLevels.join(', ')}`);
      process.exit(1);
    }

    const validFormats = ['text', 'json'] as const;
    if (!validFormats.includes(opts.format)) {
      console.error(`Invalid --format value: '${opts.format}'. Must be one of: ${validFormats.join(', ')}`);
      process.exit(1);
    }

    if (opts.since) {
      try {
        parseDuration(opts.since);
      } catch (e) {
        console.error(e instanceof Error ? e.message : `Invalid --since value: '${opts.since}'`);
        process.exit(1);
      }
    }

    viewLogs({
      logPath,
      lines: lineCount,
      level: opts.level,
      since: opts.since,
      format: opts.format,
      follow: opts.follow ?? false,
    });
  });

program
  .command('doctor')
  .description('Diagnose daemon configuration and connectivity')
  .option('--config-dir <path>', 'Custom config directory')
  .action(async (opts) => {
    const configManager = new ConfigManager(opts.configDir);
    await runDoctor(configManager);
  });

program
  .command('update')
  .description('检查并更新 tabtin-daemon 到最新版本')
  .option('--check', '只检查是否有新版本，不执行更新')
  .option('-f, --format <format>', '输出格式: text | json', 'text')
  .addHelpText('after', `
示例：
  tabtin-daemon update              # 检查并自动更新
  tabtin-daemon update --check      # 只检查版本，不更新
  tabtin-daemon update --format json`)
  .action(handleUpdate);

async function handleUpdate(opts: { check?: boolean; format?: string }): Promise<void> {
    const PACKAGE_NAME = '@tabtin/daemon';
    const jsonOutput = opts.format === 'json';
    const currentVersion = getDaemonCurrentVersion();

    // 获取最新版本
    let latestVersion: string;
    try {
      latestVersion = fetchLatestVersion(PACKAGE_NAME);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reportUpdateLookupError(PACKAGE_NAME, currentVersion, message, jsonOutput);
      process.exit(1);
    }

    const needsUpdate = compareVersions(currentVersion, latestVersion) > 0;

    // --check 模式：只输出版本信息
    if (opts.check) {
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              current_version: currentVersion,
              latest_version: latestVersion,
              update_available: needsUpdate,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        console.log(`\ntabtin-daemon update — 版本检查\n`);
        console.log(`  当前版本：${currentVersion}`);
        console.log(`  最新版本：${latestVersion}`);
        if (needsUpdate) {
          console.log(`\n  ★ 有新版本可用！运行 tabtin-daemon update 来升级。\n`);
        } else {
          console.log(`\n  ✓ 已是最新版本。\n`);
        }
      }
      return;
    }

    // 无需更新
    if (!needsUpdate) {
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              current_version: currentVersion,
              latest_version: latestVersion,
              update_available: false,
              message: '已是最新版本',
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        console.log(`\n✓ 已是最新版本（${currentVersion}）。\n`);
      }
      return;
    }

    // 执行更新
    if (!jsonOutput) {
      console.log(`\ntabtin-daemon update — 升级 Daemon\n`);
      console.log(`  当前版本：${currentVersion}`);
      console.log(`  目标版本：${latestVersion}`);
      console.log(`\n  正在安装 ${PACKAGE_NAME}@latest ...\n`);
    }

    try {
      execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
        stdio: jsonOutput ? ['pipe', 'pipe', 'pipe'] : 'inherit',
        timeout: 120_000,
      });

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              previous_version: currentVersion,
              current_version: latestVersion,
              update_available: false,
              message: `已成功升级到 ${latestVersion}`,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        console.log(`\n✓ 升级成功！tabtin-daemon 已更新到 ${latestVersion}。\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: `更新失败，请尝试手动执行：npm install -g ${PACKAGE_NAME}@latest`,
              detail: message,
              current_version: currentVersion,
              target_version: latestVersion,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`\n✗ 更新失败。\n`);
        process.stderr.write(`  请尝试手动执行：npm install -g ${PACKAGE_NAME}@latest\n`);
        process.stderr.write(`  错误：${message}\n\n`);
      }
      process.exit(1);
    }
}

function reportUpdateLookupError(packageName: string, currentVersion: string, message: string, jsonOutput: boolean): void {
  const notFound = ['E404', 'Not found', 'not in this registry'].some((part) => message.includes(part));
  const userMessage = notFound ? `${packageName} 尚未发布到 npm registry（仅限内部分发渠道）` : '无法访问 npm registry，请检查网络连接';
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ success: false, error: userMessage, detail: message, current_version: currentVersion }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`\n✗ ${userMessage}\n`);
  if (!notFound) process.stderr.write(`  错误：${message}\n`);
  process.stderr.write('\n');
}

program
  .command('drain')
  .description('Gracefully drain active tasks and stop daemon')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--timeout <minutes>', 'Max wait time in minutes', '10')
  .action(async (opts) => {
    const configManager = new ConfigManager(opts.configDir);
    await drainDaemon(configManager, parseInt(opts.timeout, 10) || 10);
  });

// ── W2.3：tabtin-daemon storage * 子命令 ──────────────────────────
//
// 设计：commander 子命令均运行在**本进程**——不通过 socket 转给 running daemon。
//   - 优点：smoke test / CI / ops 调试无需 daemon 在跑，输出稳定
//   - 优点：与正在跑的 daemon **共享** registry 的代码路径（同一注册函数）
//   - 注意：`clear/export/vacuum` 在本地跑会直接操作磁盘——此处仅作为
//     运维工具入口；UI 路径走 `cli-server-core HTTP` 调 daemon 内的注册中心
//
// 严格遵循 RFC §四 4.4 命令名 + 参数。
const storage = program
  .command('storage')
  .description('Inspect / clean Daemon-managed local storage (RFC §四 4.4)');

/**
 * R2 Round 2 must-fix：避免 daemon 在跑时 vacuum / clear 与
 * FilePersistentQueue 写盘 race（atomic rename 可能丢新追加内容）。
 *
 * 在 CLI 子命令出口前调一次：daemon 在跑时拒绝执行可能 race 的写操作。
 * read-only 操作（list / size / list-items）放行——它们对一致性要求不高。
 */
function refuseIfDaemonRunning(configManager: ConfigManager, opName: string): void {
  const pidPath = configManager.getPidPath();
  if (!fs.existsSync(pidPath)) return;
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  if (isNaN(pid)) return;
  if (!isProcessRunning(pid)) return;
  console.error(
    `Refusing ${opName}: daemon is running (PID ${pid}). ` +
    `Stop it first with 'tabtin-daemon stop' or 'tabtin-daemon stop --drain' ` +
    `to avoid racing with FilePersistentQueue writes.`,
  );
  process.exit(1);
}

/**
 * R1 #6 修复：用 unregister handles 实现幂等，避免在生产代码里调 `__resetForTesting()`。
 * CLI 是独立短命进程，每次启动注册一次，进程退出自然回收 — 无需主动 reset。
 *
 * 重复注册由 unregister handles 守护：同一进程内第二次调用先 unregister 旧的、再 register。
 */
let _cliBucketUnregisterHandles: Array<() => void> | null = null;

function loadStorageRuntime(configDir?: string) {
  const configManager = new ConfigManager(configDir);
  return import('../platform/storage/storage-bucket-registration.js').then(async (mod) => {
    const sm = await import('@tabtin/storage-manager');
    // 幂等：先 unregister 历史 handles（在多次 import 同一模块的特殊场景下生效）
    if (_cliBucketUnregisterHandles) {
      for (const off of _cliBucketUnregisterHandles) {
        try { off(); } catch { /* ignore */ }
      }
      _cliBucketUnregisterHandles = null;
    }
    _cliBucketUnregisterHandles = mod.registerDaemonStorageBuckets({
      daemonHomeDir: configManager.getConfigDir(),
    });
    return { sm, configManager };
  });
}

storage
  .command('list')
  .description('List all registered storage bucket descriptors as JSON')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--category <cat>', 'Filter by category: cache | semi-cache | data')
  .option('--group <group>', 'Filter by group')
  .option('--include-hidden', 'Include hidden buckets', false)
  .action(async (opts) => {
    const { sm } = await loadStorageRuntime(opts.configDir);
    const buckets = sm.listBuckets({
      category: opts.category,
      group: opts.group,
      includeHidden: !!opts.includeHidden,
    });
    const descriptors = buckets.map((b: any) => sm.bucketToDescriptor(b, 'daemon'));
    process.stdout.write(JSON.stringify({ count: descriptors.length, buckets: descriptors }, null, 2) + '\n');
  });

storage
  .command('size')
  .description('Show size of one or all buckets')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--bucket <id>', 'Bucket id; omit to list all')
  .action(async (opts) => {
    const { sm } = await loadStorageRuntime(opts.configDir);
    if (opts.bucket) {
      const size = await sm.getBucketSize(opts.bucket);
      process.stdout.write(JSON.stringify({ id: opts.bucket, ...size, measuredAt: Date.now() }, null, 2) + '\n');
      return;
    }
    const all = sm.listBuckets({ includeHidden: true });
    const sizes: any[] = [];
    let totalBytes = 0;
    for (const b of all) {
      try {
        const sz = await b.sizeFn();
        sizes.push({ id: b.id, bytes: sz.bytes, itemCount: sz.itemCount });
        totalBytes += sz.bytes;
      } catch (err) {
        sizes.push({ id: b.id, bytes: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    process.stdout.write(JSON.stringify({ totalBytes, sizes }, null, 2) + '\n');
  });

storage
  .command('list-items')
  .description('List items inside a bucket')
  .requiredOption('--bucket <id>', 'Bucket id')
  .option('--config-dir <path>', 'Custom config directory')
  .action(async (opts) => {
    const { sm } = await loadStorageRuntime(opts.configDir);
    try {
      const items = await sm.listBucketItems(opts.bucket);
      process.stdout.write(JSON.stringify({ id: opts.bucket, items }, null, 2) + '\n');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

storage
  .command('clear')
  .description('Clear a single bucket or all buckets in a category')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--bucket <id>', 'Bucket id (single-bucket mode)')
  .option('--category <cat>', 'cache | semi-cache | data (admin mode)')
  .option('--dry-run', 'Estimate without deleting', false)
  .action(async (opts) => {
    const { sm, configManager } = await loadStorageRuntime(opts.configDir);
    // R2 Round 2 must-fix：daemon 在跑时拒绝清理（避免 race），dryRun 例外
    if (!opts.dryRun) {
      refuseIfDaemonRunning(configManager, 'storage clear');
    }
    if (opts.bucket && opts.category) {
      console.error('--bucket 与 --category 不能同时使用');
      process.exit(1);
    }
    const dryRun = !!opts.dryRun;
    if (opts.bucket) {
      try {
        const r = await sm.clearBucket(opts.bucket, { dryRun });
        process.stdout.write(JSON.stringify({ id: opts.bucket, dryRun, ...r }, null, 2) + '\n');
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    if (!opts.category) {
      console.error('需要 --bucket 或 --category 参数');
      process.exit(1);
    }
    const all = sm.listBuckets({ category: opts.category, includeHidden: true });
    const reports: any[] = [];
    for (const b of all) {
      if (!b.clearFn) {
        reports.push({ id: b.id, cleared: false, skipped: 'no-clear-fn' });
        continue;
      }
      try {
        const r = await b.clearFn({ dryRun });
        reports.push({ id: b.id, cleared: true, ...r });
      } catch (err) {
        reports.push({ id: b.id, cleared: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    process.stdout.write(JSON.stringify({ category: opts.category, dryRun, reports }, null, 2) + '\n');
  });

storage
  .command('export')
  .description('Export a bucket as JSON / Blob (only buckets implementing exportFn)')
  .requiredOption('--bucket <id>', 'Bucket id')
  .option('--config-dir <path>', 'Custom config directory')
  .action(async (opts) => {
    const { sm } = await loadStorageRuntime(opts.configDir);
    try {
      const r = await sm.exportBucket(opts.bucket);
      let dataStr = '';
      let encoding: 'utf-8' | 'base64' = 'utf-8';
      if (typeof r.data === 'string') {
        dataStr = r.data;
      } else if (r.data instanceof Uint8Array) {
        dataStr = Buffer.from(r.data).toString('base64');
        encoding = 'base64';
      } else {
        dataStr = '<unsupported-blob>';
      }
      process.stdout.write(
        JSON.stringify({ id: opts.bucket, filename: r.filename, mimeType: r.mimeType, encoding, data: dataStr }, null, 2) + '\n',
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

storage
  .command('vacuum')
  .description('Vacuum agent-sync archive (default 90-day retention)')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--agent-sync', 'Vacuum agent-sync archive (default true)', true)
  .option('--retain-days <n>', 'Keep entries newer than N days', '90')
  .option('--dry-run', 'Estimate without modifying files', false)
  .action(async (opts) => {
    const { configManager } = await loadStorageRuntime(opts.configDir);
    // R2 Round 2 must-fix：daemon 在跑时拒绝 vacuum（避免与 FilePersistentQueue.archive
    // 的 atomic rename race）；dryRun 例外（不写盘）
    if (!opts.dryRun) {
      refuseIfDaemonRunning(configManager, 'storage vacuum');
    }
    const { handleStorageRoute } = await import('../transport/cli/routes/storage/index.js');
    const fakeRes: any = {};
    let result: any = null;
    await handleStorageRoute(
      '/storage/vacuum',
      'POST',
      {
        agentSync: !!opts.agentSync,
        retainDays: Number(opts.retainDays),
        dryRun: !!opts.dryRun,
        daemon_home: configManager.getConfigDir(),
      },
      fakeRes,
      (_res, status, body) => {
        result = { status, body };
      },
      storageApplication,
    );
    if (result?.status >= 400) {
      console.error(JSON.stringify(result.body, null, 2));
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result?.body?.data ?? result, null, 2) + '\n');
  });

storage
  .command('drain')
  .description(
    '等 daemon active sessions 完成后退出（alias of `tabtin-daemon drain`）。' +
    '注意：当前 daemon 的 active_actions 追踪不覆盖 outbox / agent-sync flush 状态——' +
    '如果你需要保证 table-kernel-db 数据已同步再清理，请确认 `storage size --bucket daemon:agent-sync-pending` 为 0。',
  )
  .option('--config-dir <path>', 'Custom config directory')
  .option('--timeout <minutes>', 'Max wait time in minutes', '10')
  .action(async (opts) => {
    const configManager = new ConfigManager(opts.configDir);
    await drainDaemon(configManager, parseInt(opts.timeout, 10) || 10);
  });

storage
  .command('purge')
  .description(
    'Physically delete daemon home directory (post-uninstall use). ' +
    'Multi-step confirmation: must pass --confirm AND interactively type the ' +
    'expected device hostname when stdin is a TTY. ' +
    'Use --confirm-name <hostname> in scripts (e.g. CI / uninstall scripts).',
  )
  .requiredOption('--confirm', 'Required: confirms the irreversible deletion')
  .option('--confirm-name <hostname>', 'Skip interactive prompt by passing the daemon device name (matches config.device_name)')
  .option('--config-dir <path>', 'Custom config directory')
  .option('--include-shared', 'Also clean ~/.tabtin/ daemon-written items', false)
  .action(handleStoragePurge);

async function handleStoragePurge(opts: {
  configDir?: string; confirmName?: string; includeShared?: boolean;
}): Promise<void> {
    // commander 的 .requiredOption 已保证 opts.confirm===true，无需重复 guard。
    // 二次确认：
    //   1. 优先 --confirm-name <hostname>（脚本场景）
    //   2. 否则 stdin 是 TTY 时交互输入设备名（避免运维误执行）
    //   3. 既无 --confirm-name 又非 TTY → 拒绝（防止 nohup / cron 误触发）
    const configManager = new ConfigManager(opts.configDir);
    await confirmStoragePurge(configManager, opts.confirmName);

    const pidPath = configManager.getPidPath();
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (isProcessRunning(pid)) {
        console.error(
          `Daemon is running (PID ${pid}). Stop it first with 'tabtin-daemon stop' or 'tabtin-daemon stop --drain'.`,
        );
        process.exit(1);
      }
    }
    const { handleStorageRoute } = await import('../transport/cli/routes/storage/index.js');
    const fakeRes: any = {};
    let result: any = null;
    await handleStorageRoute(
      '/storage/purge',
      'POST',
      {
        confirm: 'yes-i-am-sure',
        deleteHomeDir: true,
        deleteSharedRoot: !!opts.includeShared,
        daemon_home: configManager.getConfigDir(),
      },
      fakeRes,
      (_res, status, body) => {
        result = { status, body };
      },
      storageApplication,
    );
    if (result?.status >= 400) {
      console.error(JSON.stringify(result.body, null, 2));
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result?.body?.data ?? result, null, 2) + '\n');
}

async function confirmStoragePurge(configManager: ConfigManager, confirmName?: string): Promise<void> {
  let expectedName: string | null = null;
  try { if (configManager.exists()) expectedName = configManager.load().device_name ?? null; } catch { /* damaged config may be purged */ }
  if (!expectedName) return;
  const provided = (confirmName ?? '').trim();
  if (provided && provided !== expectedName) {
    console.error(`--confirm-name '${provided}' 与实际 device_name '${expectedName}' 不匹配，拒绝执行。`);
    process.exit(1);
  }
  if (provided) return;
  if (!process.stdin.isTTY) {
    console.error(`Refusing to purge: device_name = '${expectedName}'。非交互场景请加 --confirm-name '${expectedName}' 通过二次确认。`);
    process.exit(1);
  }
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(
    `不可逆操作：将物理删除 ~/.tabtin-daemon/。请输入设备名 '${expectedName}' 确认: `,
    (value) => { rl.close(); resolve(value.trim()); },
  ));
  if (answer !== expectedName) {
    console.error(`Device name mismatch ('${answer}' != '${expectedName}'). Aborting.`);
    process.exit(1);
  }
}

// ─── H1-E: MTTR 人工标记（运维 / on-call 用） ──────────────────────
// 说明：该命令以**独立短命进程**运行，不会 attach 到正在跑的 daemon 进程。
// 每次调用都会新建 stdout sink 并发一条 `mttr.start` / `mttr.resolved`，
// 格式：`[telemetry] {JSON}\n`（与 daemon 日志行兼容）。
//
// 推荐用法（让事件与 daemon 日志同流）：
//   tabtin-daemon mttr-start --description '...' >> ~/.tabtin-daemon/daemon.log
// 或直接 `tee`：
//   tabtin-daemon mttr-resolved --incident $INC --duration-ms 1800000 \
//     | tee -a ~/.tabtin-daemon/daemon.log
//
// 若仅做 incident_id 生成而不入盘，直接运行不重定向即可。
program
  .command('mttr-start')
  .description('Mark the start of an incident for MTTR measurement')
  .option('--incident <id>', 'Optional incident id (auto-generated if omitted)')
  .option('--description <text>', 'Short symptom description (≤ 200 chars)')
  .option('--reporter <name>', 'Reporter handle / team')
  .option('--session <id>', 'Associated Runtime session id')
  .option('--severity <level>', 'Severity tag (p0/p1/p2)')
  .action(async (opts) => {
    const { emitMttrStart, generateIncidentId, setTelemetrySink } = await import(
      '@tabtin/agent-runtime'
    );
    const incidentId = (opts.incident as string | undefined)?.trim() || generateIncidentId();
    // 若 daemon 未运行，用 stdout 兜底，让运维仍可把输出 tee 到日志
    setTelemetrySink((record) => {
      process.stdout.write(`[telemetry] ${JSON.stringify(record)}\n`);
    });
    emitMttrStart({
      incident_id: incidentId,
      description: (opts.description as string | undefined) ?? 'unspecified',
      ...(opts.reporter ? { reporter: opts.reporter as string } : {}),
      ...(opts.session ? { session_id: opts.session as string } : {}),
      ...(opts.severity ? { severity: opts.severity as string } : {}),
    });
    process.stdout.write(`incident_id: ${incidentId}\n`);
  });

program
  .command('mttr-resolved')
  .description('Mark an incident as resolved for MTTR measurement')
  .requiredOption('--incident <id>', 'Incident id returned by mttr-start')
  .option('--resolution <text>', 'Root cause / resolution summary (≤ 400 chars)')
  .requiredOption('--duration-ms <ms>', 'Elapsed duration in milliseconds')
  .option('--resolver <name>', 'Resolver handle / team')
  .option('--session <id>', 'Associated Runtime session id')
  .option('--error-class <class>', 'Associated AgentErrorCode')
  .action(async (opts) => {
    const { emitMttrResolved, setTelemetrySink } = await import('@tabtin/agent-runtime');
    const duration = Number(opts.durationMs);
    setTelemetrySink((record) => {
      process.stdout.write(`[telemetry] ${JSON.stringify(record)}\n`);
    });
    emitMttrResolved({
      incident_id: opts.incident as string,
      resolution: (opts.resolution as string | undefined) ?? 'resolved',
      duration_ms: Number.isFinite(duration) ? Math.max(0, duration) : 0,
      ...(opts.resolver ? { resolver: opts.resolver as string } : {}),
      ...(opts.session ? { session_id: opts.session as string } : {}),
      ...(opts.errorClass ? { error_class: opts.errorClass as string } : {}),
    });
    process.stdout.write('ok\n');
  });

program.parse();

/**
 * 读取当前安装的 daemon 版本。
 * dist/index.js → ../package.json（即 package 根目录）
 */
function getDaemonCurrentVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * 执行 `npm view <pkg> version --json` 获取 registry 最新版本。
 */
function fetchLatestVersion(packageName: string): string {
  const raw = execSync(`npm view ${packageName} version --json`, {
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  // npm view 可能返回带引号的 JSON 字符串，也可能是裸字符串
  return raw.replace(/^"|"$/g, '');
}

/**
 * 语义化版本比较。
 * 返回正数 → latest 更新；0 → 相同；负数 → current 更新（预发布）
 */
function compareVersions(current: string, latest: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0);
  const [c1 = 0, c2 = 0, c3 = 0] = parse(current);
  const [l1 = 0, l2 = 0, l3 = 0] = parse(latest);
  if (l1 !== c1) return l1 - c1;
  if (l2 !== c2) return l2 - c2;
  return l3 - c3;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function isPidStale(cm: ConfigManager): boolean {
  const pidPath = cm.getPidPath();
  if (!fs.existsSync(pidPath)) return true;
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  if (isNaN(pid)) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function forceCleanupLock(cm: ConfigManager): void {
  const lockDir = cm.getConfigDir();
  const lockfilePath = `${lockDir}.lock`;
  try { fs.rmSync(lockfilePath, { recursive: true, force: true }); } catch { /* best effort */ }
  const pidPath = cm.getPidPath();
  try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch { /* best effort */ }
}

function formatRelativeTime(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokenExpiry(expiresAt: string): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return 'expired';
  const days = Math.floor(diffMs / 86400000);
  if (days > 0) return `expires in ${days} day${days > 1 ? 's' : ''}`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours > 0) return `expires in ${hours} hour${hours > 1 ? 's' : ''}`;
  const minutes = Math.floor(diffMs / 60000);
  return `expires in ${minutes} minute${minutes > 1 ? 's' : ''}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function getActionHint(exitInfo: Partial<LastExitInfo>): string | null {
  if (exitInfo.action_required === 'contact_admin') {
    return '联系管理员重新创建设备，然后 tabtin-daemon init';
  }
  if (exitInfo.action_required === 'reinit') {
    return 'tabtin-daemon init --token <new-token> --force';
  }
  if (exitInfo.reason === 'device_removed') {
    return '联系管理员重新创建设备，然后 tabtin-daemon init';
  }
  if (exitInfo.reason === 'auth_fatal') {
    return 'tabtin-daemon init --token <new-token> --force';
  }
  return null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function drainDaemon(configManager: ConfigManager, timeoutMinutes: number): Promise<void> {
  const pidPath = configManager.getPidPath();
  if (!fs.existsSync(pidPath)) {
    console.log('No running daemon found.');
    return;
  }
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  if (!isProcessRunning(pid)) {
    console.log('Daemon process not found. Cleaning up PID file.');
    try { fs.unlinkSync(pidPath); } catch { /* best effort */ }
    return;
  }

  try {
    process.kill(pid, 'SIGUSR2');
  } catch {
    console.error('Failed to send drain signal to daemon.');
    process.exit(1);
  }

  console.log('Draining... waiting for active tasks to complete');
  const deadlineMs = Date.now() + timeoutMinutes * 60 * 1000;

  while (isProcessRunning(pid)) {
    if (Date.now() > deadlineMs) {
      console.log('\nDrain timeout reached. Sending SIGTERM...');
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
      break;
    }
    const state = StateWriter.readState(configManager);
    if (state?.active_actions !== undefined) {
      process.stdout.write(`\rDraining... ${state.active_actions} active task(s) remaining`);
    }
    await sleep(1000);
  }

  console.log('\nDaemon stopped.');
}
