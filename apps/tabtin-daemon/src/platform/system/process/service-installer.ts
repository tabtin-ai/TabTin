import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ConfigManager } from '../config/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ServiceInstaller {
  private readonly configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  install(): void {
    if (process.platform === 'darwin') {
      this.installLaunchd();
    } else if (process.platform === 'linux') {
      this.installSystemd();
    } else {
      throw new Error(`Unsupported platform for service installation: ${process.platform}`);
    }
  }

  uninstall(): void {
    if (process.platform === 'darwin') {
      this.uninstallLaunchd();
    } else if (process.platform === 'linux') {
      this.uninstallSystemd();
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }

  private installSystemd(): void {
    const templatePath = path.join(__dirname, '..', 'templates', 'tabtin-daemon.service');
    let template: string;
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf-8');
    } else {
      template = this.getSystemdTemplate();
    }

    const nodePath = process.execPath;
    const daemonPath = this.findDaemonBin();
    const configDir = this.configManager.getConfigDir();
    const user = os.userInfo().username;
    const homeDir = os.homedir();

    // systemd 默认 PATH 极简（systemd 5.x 给 service 的 default 是
    // `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`），
    // 缺 ~/.cargo/bin / ~/.nvm / ~/.pyenv 等用户安装目录。安装服务时把
    // 用户当前 shell 的 PATH 快照写进 unit，daemon 启动时就有合理基线；
    // 运行时 fix-process-path 进一步兜底（覆盖用户后续修改 shell 配置的情况）。
    //
    // 注意：sudo systemctl 时 process.env.PATH 是 root 的——所以读 /etc/passwd
    // 的用户 shell 跑一遍 login shell 拿真实用户 PATH 更准确。但实务上 daemon
    // service install 通常由用户自己用 sudo 跑，此时 SUDO_USER + 之前设置的
    // PATH 多半够用。简化处理：拼用户当前 PATH + 默认安全前缀（homebrew arm64）。
    const homebrewPath = process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin';
    const envPath = process.env.PATH
      ? `${homebrewPath}:${process.env.PATH}`
      : `${homebrewPath}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

    const content = template
      .replace(/\{\{NODE_PATH\}\}/g, nodePath)
      .replace(/\{\{DAEMON_PATH\}\}/g, daemonPath)
      .replace(/\{\{CONFIG_DIR\}\}/g, configDir)
      .replace(/\{\{USER\}\}/g, user)
      .replace(/\{\{GROUP\}\}/g, user)
      .replace(/\{\{HOME_DIR\}\}/g, homeDir)
      .replace(/\{\{ENV_PATH\}\}/g, envPath);

    const servicePath = '/etc/systemd/system/tabtin-daemon.service';
    fs.writeFileSync(servicePath, content);
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['enable', 'tabtin-daemon']);
    console.log(`Systemd service installed at ${servicePath}`);
    console.log('Start with: sudo systemctl start tabtin-daemon');
  }

  private uninstallSystemd(): void {
    const servicePath = '/etc/systemd/system/tabtin-daemon.service';
    try {
      execFileSync('systemctl', ['stop', 'tabtin-daemon'], { stdio: 'pipe' });
    } catch { /* may not be running */ }
    try {
      execFileSync('systemctl', ['disable', 'tabtin-daemon'], { stdio: 'pipe' });
    } catch { /* may not be enabled */ }
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }
    execFileSync('systemctl', ['daemon-reload']);
  }

  private installLaunchd(): void {
    const nodePath = process.execPath;
    const daemonPath = this.findDaemonBin();
    const configDir = this.configManager.getConfigDir();
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');

    if (!fs.existsSync(plistDir)) {
      fs.mkdirSync(plistDir, { recursive: true });
    }

    const templatePath = path.join(__dirname, '..', 'templates', 'com.tabtin.daemon.plist');
    let template: string;
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf-8');
    } else {
      template = this.getLaunchdTemplate();
    }

    const defaultPath = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const homebrewPath = process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin';
    const envPath = process.env.PATH
      ? `${homebrewPath}:${process.env.PATH}`
      : `${homebrewPath}:${defaultPath}`;

    const content = template
      .replace(/\{\{NODE_PATH\}\}/g, nodePath)
      .replace(/\{\{DAEMON_PATH\}\}/g, daemonPath)
      .replace(/\{\{CONFIG_DIR\}\}/g, configDir)
      .replace(/\{\{PATH\}\}/g, envPath);

    const plistPath = path.join(plistDir, 'com.tabtin.daemon.plist');
    fs.writeFileSync(plistPath, content);
    console.log(`LaunchAgent installed at ${plistPath}`);
    console.log('Load with: launchctl load ' + plistPath);
  }

  private uninstallLaunchd(): void {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tabtin.daemon.plist');
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
    } catch { /* may not be loaded */ }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
  }

  private findDaemonBin(): string {
    try {
      return execFileSync('which', ['tabtin-daemon'], { stdio: 'pipe' }).toString().trim();
    } catch {
      return path.join(__dirname, '..', 'index.js');
    }
  }

  private getSystemdTemplate(): string {
    return `[Unit]
Description=TabTin Agent Daemon
After=network-online.target
Wants=network-online.target
StartLimitBurst=3
StartLimitIntervalSec=300

[Service]
Type=simple
User={{USER}}
ExecStart={{NODE_PATH}} {{DAEMON_PATH}} start --config-dir {{CONFIG_DIR}}
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
Environment=NODE_ENV=production
Environment=HOME={{HOME_DIR}}
Environment=PATH={{ENV_PATH}}
# LAUNCHED_BY_SYSTEMD 让 daemon 进程知道自己是 systemd 启动的（与
# LAUNCHED_BY_LAUNCHD 对称），便于诊断 / fix-process-path 走对路径
Environment=LAUNCHED_BY_SYSTEMD=1

[Install]
WantedBy=multi-user.target
`;
  }

  private getLaunchdTemplate(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tabtin.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{DAEMON_PATH}}</string>
        <string>start</string>
        <string>--config-dir</string>
        <string>{{CONFIG_DIR}}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>{{CONFIG_DIR}}/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{{CONFIG_DIR}}/daemon-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>LAUNCHED_BY_LAUNCHD</key>
        <string>1</string>
        <key>PATH</key>
        <string>{{PATH}}</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>`;
  }
}
