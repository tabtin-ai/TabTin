import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Logger } from '../../observability/logging/logger.js';

const IS_WIN = process.platform === 'win32';
const WHICH_CMD = IS_WIN ? 'where' : 'which';

const CHROME_PATHS: Record<string, string[]> = {
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export interface EnvironmentInfo {
  os: string;
  arch: string;
  hostname: string;
  release: string;
  platform: string;
  node_version: string;
  python_version: string | null;
  cuda_version: string | null;
  git_version: string | null;
  docker_available: boolean;
  rg_available: boolean;
}

export class CapabilityDetector {
  private ptyAvailable: boolean | null = null;
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Detect capabilities that Daemon can actually handle via action handlers.
   *
   * Each capability here MUST have corresponding registered action handlers
   * in DaemonActionBridge.registerCoreExecutors(). Mapping reference:
   *
   *   terminal_execute → execute_in_terminal
   *   terminal_read    → read_terminal_output, list_terminal_sessions
   *   terminal_write   → write_to_terminal
   *   file             → read_file, write_file, edit_file, delete_file
   *   code_search      → glob_search, grep_search
   *   browser          → execute_act, execute_extract, execute_observe,
   *                       request_snapshot, eval, capture_screenshot,
   *                       generate_pdf, page_to_markdown, etc.
   *                       (via tabweb-headless domain + DaemonBrowserService)
   *                       注：`/extract` 路由直接走 DaemonBrowserService.getPageContent，
   *                       不通过 ActionExecutor 间接（参见
   *                       packages/action-tools/src/headless.ts 头注释）。
   *
   * Capabilities intentionally NOT reported:
   *   git          — no git_status/git_diff action handlers; git info flows
   *                  through separate WS events (git.status channel)
   *   gui          — headless, no GUI automation
   *   mcp          — Daemon MCP server exists but mcp_list_servers/mcp_call_tool
   *                  action handlers are not registered
   *   video_render — no browser-based HTML video rendering engine
   *
   *   video_render_mg / video_export — reported when FFmpeg is available;
   *                     Remotion uses FFmpeg for frame-to-video encoding.
   *                     Remotion itself is obtained at runtime via npm install
   *                     (no static detection needed).
   */
  async detect(): Promise<string[]> {
    const caps: string[] = ['terminal_execute', 'file'];

    if (await this.isPtyAvailable()) {
      caps.push('terminal_read', 'terminal_write');
    }

    if (this.commandExists('rg')) {
      caps.push('code_search');
    }

    if (this.isBrowserAvailable()) {
      caps.push('browser', 'browser_screenshot');
      // Daemon 无桌面环境，不具备 desktop_screenshot 能力
    }

    if (await this.isFFmpegAvailable()) {
      caps.push('video_render_mg', 'video_export');
    }

    return caps;
  }

  isBrowserAvailable(): boolean {
    if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return true;
    const candidates = CHROME_PATHS[process.platform] ?? [];
    return candidates.some((p) => existsSync(p));
  }

  resetPtyCache(): void {
    this.ptyAvailable = null;
  }

  async isPtyAvailable(): Promise<boolean> {
    if (this.ptyAvailable !== null) return this.ptyAvailable;
    try {
      const PTY_LOAD_TIMEOUT_MS = 5_000;
      await Promise.race([
        import('node-pty'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('node-pty import timed out')), PTY_LOAD_TIMEOUT_MS),
        ),
      ]);
      this.ptyAvailable = true;
    } catch (err) {
      this.ptyAvailable = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timed out')) {
        const line = `[CapabilityDetector] node-pty load timed out after 5s, PTY disabled`;
        if (this.logger) this.logger.warn(line);
        else console.warn(line);
      }
    }
    return this.ptyAvailable;
  }

  async detectEnvironment(): Promise<EnvironmentInfo> {
    return {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      release: os.release(),
      platform: os.platform(),
      node_version: process.version,
      python_version: this.getCommandOutput('python3', ['--version']) ?? this.getCommandOutput('python', ['--version']),
      cuda_version: this.getCommandOutput('nvcc', ['--version'])?.match(/release ([\d.]+)/)?.[1] ?? null,
      git_version: this.getCommandOutput('git', ['--version'])?.match(/git version ([\d.]+)/)?.[1] ?? null,
      docker_available: this.commandExists('docker'),
      rg_available: this.commandExists('rg'),
    };
  }

  private async isFFmpegAvailable(): Promise<boolean> {
    const { findFFmpegAsync } = await import('@tabtin/media-capabilities');
    return Boolean(await findFFmpegAsync());
  }

  private commandExists(cmd: string): boolean {
    try {
      execFileSync(WHICH_CMD, [cmd], { stdio: 'pipe', timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private getCommandOutput(cmd: string, args: string[]): string | null {
    try {
      return execFileSync(cmd, args, { stdio: 'pipe', timeout: 5_000 }).toString().trim();
    } catch {
      return null;
    }
  }
}
