export type TerminalCoreLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<TerminalCoreLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.threadIdRequired': 'sandbox 模式需要 threadId',
    'errors.commandRequired': '需要提供命令',
    'errors.commandDenied': '命令不允许执行',
    'errors.denylist.rm': '禁止使用 rm 命令',
    'errors.denylist.mv': '禁止使用 mv 命令',
    'errors.denylist.chmod': '禁止使用 chmod 命令',
    'errors.denylist.chown': '禁止使用 chown 命令',
    'errors.denylist.sudo': '禁止使用 sudo 命令',
    'errors.denylist.gitDestructive': '禁止执行具有破坏性的 git 命令',
    'errors.denylist.npmInstall': '禁止执行 npm install/add/update/publish',
    'errors.denylist.pnpmInstall': '禁止执行 pnpm install/add/update/publish',
    'errors.denylist.yarnInstall': '禁止执行 yarn install/add/upgrade/publish',
    'errors.denylist.pipeToShell': '禁止通过管道执行 shell（可能导致远程代码执行）',
    'errors.denylist.curlPipeExec': '禁止通过 curl/wget 管道执行脚本',
    'errors.denylist.pythonInline': '禁止使用 python -c 执行内联代码（请改用脚本文件）',
    'errors.denylist.nodeInline': '禁止使用 node -e/--eval 执行内联代码（请改用脚本文件）',
    'errors.denylist.pythonServer': '禁止使用 python 启动 HTTP/SMTP 服务器',
    'errors.denylist.eval': '禁止使用 eval 命令',
    'errors.denylist.source': '禁止使用 source/. 命令',
    'errors.denylist.su': '禁止使用 su 切换用户',
    'errors.denylist.dd': '禁止使用 dd 命令（低级磁盘操作）',
    'errors.denylist.mkfs': '禁止使用 mkfs 格式化磁盘',
    'errors.denylist.rebootShutdown': '禁止执行 reboot/shutdown 命令',
    'errors.denylist.crontabWrite': '禁止修改 crontab',
    'errors.denylist.systemctlDestructive': '禁止执行具有破坏性的 systemctl 操作',
    'errors.denylist.iptables': '禁止修改防火墙规则',
    'errors.denylist.dockerDestructive': '禁止执行具有破坏性的 docker 操作',
    'errors.denylist.kubectlDestructive': '禁止执行具有破坏性的 kubectl 操作',
    'errors.denylist.curlWriteFile': '禁止使用 curl 写入文件（-o/-O/--output）',
    'errors.denylist.curlUpload': '禁止使用 curl 上传文件（-T/--upload-file）',
    'errors.denylist.curlExfil': '禁止使用 curl 发送本地文件内容（-d @file/-F @file）',
    'errors.denylist.curlMutating': '禁止使用 curl 发送数据（-d/--data/-X POST/PUT/PATCH/DELETE/-F）',
    'errors.denylist.wgetWrite': '禁止使用 wget 发送数据（--post-data/--post-file/--method）',
    'errors.denylist.redirectWrite': '禁止使用输出重定向写入文件（>）',
    'errors.denylist.scp': '禁止使用 scp 传输文件',
    'errors.denylist.rsync': '禁止使用 rsync 同步文件',
    'errors.denylist.curlBasic': '使用 curl 需要审批（网络请求可能导致数据泄露）',
    'errors.denylist.wgetBasic': '使用 wget 需要审批（网络下载可能引入不安全内容）',
    'errors.denylist.ftpSftp': '禁止使用 ftp/sftp（文件传输可能导致数据泄露）',
    'errors.denylist.shellInvocation': '禁止直接调用 shell（bash/sh/dash/zsh/fish 等）',
    'errors.denylist.terminalMultiplexer': '禁止使用 screen/tmux 等终端复用器',
    'errors.denylist.perlExec': '禁止使用 perl 执行代码',
    'errors.denylist.rubyExec': '禁止使用 ruby 执行代码',
    'errors.denylist.phpExec': '禁止使用 php 执行代码',
    'errors.denylist.ncNetcat': '禁止使用 nc/ncat/netcat（可用于反弹 shell）',
    'errors.denylist.teeWrite': '禁止使用 tee 写入文件',
    'errors.denylist.sedInplace': '禁止使用 sed -i 原地修改文件',
    'errors.denylist.findExec': '禁止使用 find -exec 执行命令',
    'errors.denylist.xargsExec': '禁止使用 xargs 执行命令',
    'errors.denylist.exportEnvInjection': '禁止 export 危险环境变量（LD_PRELOAD/BASH_ENV 等可劫持子进程）',
    'errors.denylist.exportPathHijack': '禁止将 PATH 设置为不可信目录（/tmp 等可写目录可用于命令劫持）',
    'degraded.banner': '🛡️ 已为此命令启用额外安全保护',
    'degraded.footerSuccess': '✓ 命令执行完毕 (受保护模式)',
    'degraded.footerWarning': '⚠ 命令已结束，退出码 {{exitCode}} (受保护模式)',
    'degraded.footerError': '✗ 命令执行失败 (受保护模式): {{error}}',
  },
  'en-US': {
    'errors.threadIdRequired': 'threadId is required for sandbox mode.',
    'errors.commandRequired': 'Command is required.',
    'errors.commandDenied': 'Command is denied.',
    'errors.denylist.rm': 'rm is not allowed.',
    'errors.denylist.mv': 'mv is not allowed.',
    'errors.denylist.chmod': 'chmod is not allowed.',
    'errors.denylist.chown': 'chown is not allowed.',
    'errors.denylist.sudo': 'sudo is not allowed.',
    'errors.denylist.gitDestructive': 'Destructive git commands are not allowed.',
    'errors.denylist.npmInstall': 'npm install/add/update/publish is not allowed.',
    'errors.denylist.pnpmInstall': 'pnpm install/add/update/publish is not allowed.',
    'errors.denylist.yarnInstall': 'yarn install/add/upgrade/publish is not allowed.',
    'errors.denylist.pipeToShell': 'Piping to shell is not allowed (potential remote code execution).',
    'errors.denylist.curlPipeExec': 'Piping curl/wget output to shell is not allowed.',
    'errors.denylist.pythonInline': 'python -c inline execution is not allowed (use script files instead).',
    'errors.denylist.nodeInline': 'node -e/--eval inline execution is not allowed (use script files instead).',
    'errors.denylist.pythonServer': 'Starting HTTP/SMTP server via python -m is not allowed.',
    'errors.denylist.eval': 'eval is not allowed.',
    'errors.denylist.source': 'source/. is not allowed.',
    'errors.denylist.su': 'su is not allowed.',
    'errors.denylist.dd': 'dd is not allowed (low-level disk operations).',
    'errors.denylist.mkfs': 'mkfs is not allowed.',
    'errors.denylist.rebootShutdown': 'reboot/shutdown commands are not allowed.',
    'errors.denylist.crontabWrite': 'Modifying crontab is not allowed.',
    'errors.denylist.systemctlDestructive': 'Destructive systemctl operations are not allowed.',
    'errors.denylist.iptables': 'Modifying firewall rules is not allowed.',
    'errors.denylist.dockerDestructive': 'Destructive docker operations are not allowed.',
    'errors.denylist.kubectlDestructive': 'Destructive kubectl operations are not allowed.',
    'errors.denylist.curlWriteFile': 'curl file write (-o/-O/--output) is not allowed.',
    'errors.denylist.curlUpload': 'curl file upload (-T/--upload-file) is not allowed.',
    'errors.denylist.curlExfil': 'curl sending local file contents (-d @file/-F @file) is not allowed.',
    'errors.denylist.curlMutating': 'curl data sending (-d/--data/-X POST/PUT/PATCH/DELETE/-F) is not allowed.',
    'errors.denylist.wgetWrite': 'wget data sending (--post-data/--post-file/--method) is not allowed.',
    'errors.denylist.redirectWrite': 'Output redirection to file (>) is not allowed.',
    'errors.denylist.scp': 'scp file transfer is not allowed.',
    'errors.denylist.rsync': 'rsync file sync is not allowed.',
    'errors.denylist.curlBasic': 'curl requires approval (network requests may leak data).',
    'errors.denylist.wgetBasic': 'wget requires approval (downloads may introduce unsafe content).',
    'errors.denylist.ftpSftp': 'ftp/sftp is not allowed (file transfer may leak data).',
    'errors.denylist.shellInvocation': 'Direct shell invocation (bash/sh/dash/zsh/fish) is not allowed.',
    'errors.denylist.terminalMultiplexer': 'Terminal multiplexers (screen/tmux) are not allowed.',
    'errors.denylist.perlExec': 'perl execution is not allowed.',
    'errors.denylist.rubyExec': 'ruby execution is not allowed.',
    'errors.denylist.phpExec': 'php execution is not allowed.',
    'errors.denylist.ncNetcat': 'nc/ncat/netcat is not allowed (potential reverse shell).',
    'errors.denylist.teeWrite': 'tee file write is not allowed.',
    'errors.denylist.sedInplace': 'sed -i inplace modification is not allowed.',
    'errors.denylist.findExec': 'find -exec command execution is not allowed.',
    'errors.denylist.xargsExec': 'xargs command execution is not allowed.',
    'errors.denylist.exportEnvInjection': 'Exporting dangerous environment variables (LD_PRELOAD/BASH_ENV etc.) is not allowed — they can hijack child processes.',
    'errors.denylist.exportPathHijack': 'Setting PATH to untrusted directories (/tmp etc.) is not allowed — writable dirs enable command hijacking.',
    'degraded.banner': '🛡️ Additional security protection enabled for this command',
    'degraded.footerSuccess': '✓ Command completed (protected mode)',
    'degraded.footerWarning': '⚠ Command exited with code {{exitCode}} (protected mode)',
    'degraded.footerError': '✗ Command execution failed (protected mode): {{error}}',
  }
};

let currentLocale: TerminalCoreLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setTerminalCoreLocale = (locale: TerminalCoreLocale): void => {
  currentLocale = locale;
};

export const setTerminalCoreTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`terminalCore.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};

const DIM_GREY = '\x1b[38;5;243m';
const RESET = '\x1b[0m';

/** Wrap a translated string in terminal dim-grey with CRLF padding. */
const wrapTerminalLine = (text: string): string =>
  `\r\n${DIM_GREY}${text}${RESET}\r\n`;

export const degradedBanner = (): string =>
  wrapTerminalLine(t('degraded.banner'));

export const degradedFooter = (exitCode: number): string =>
  exitCode === 0
    ? wrapTerminalLine(t('degraded.footerSuccess'))
    : wrapTerminalLine(t('degraded.footerWarning', { exitCode }));

export const degradedErrorFooter = (error: string): string =>
  wrapTerminalLine(t('degraded.footerError', { error }));
