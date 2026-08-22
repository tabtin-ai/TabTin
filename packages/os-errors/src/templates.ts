/**
 * LLM 模板表 —— OSError 的核心知识所在。
 *
 * 为什么不放在 system prompt：每次对话烧 token；99% 对话用不到。
 * 所以「错误处理协议」跟着错误本身按需投递：错误产生时由模板器拼出
 * 一段自然语言，Agent 当场看到、当场理解、当场转述。
 *
 * 模板返回的是 { userGuidance, agentDirectives, recoveryActions } 三元组，
 * 由 serialize.ts 拼成 llm_message。
 */

import type { OSErrorCategory, OSErrorCode, RecoveryAction } from './types.js';

interface TemplateInput {
  path: string;
  platform: NodeJS.Platform;
  category: OSErrorCategory;
  rawDetail: string;
}

interface TemplateOutput {
  userGuidance: string;
  agentDirectives: string[];
  recoveryActions: RecoveryAction[];
}

// macOS 隐私设置面板深度链接表
const MACOS_DEEPLINKS = {
  filesAndFolders:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  appleEvents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

const WINDOWS_DEEPLINKS = {
  /** Windows 安全中心 → 病毒和威胁防护 → 受控文件夹访问 */
  controlledFolderAccess: 'windowsdefender://Threat/',
};

// ─── OS_PERMISSION_DENIED ────────────────────────────────────────────────

function tplPermissionDeniedMacOS(input: TemplateInput): TemplateOutput {
  const { path: p, category } = input;

  // Wave 1 第二轮 Review 修订：
  //   - 原文案对所有 category 都说"我帮你重启 TabTin 让权限生效"
  //   - 真实 macOS 行为：Desktop / Documents / Downloads / Removable / Network
  //     这些"普通文件夹"授权后**新发起的 fs syscall 立即生效，不需要重启**
  //   - 仅 Full Disk Access / Screen Recording / Microphone / Camera 等
  //     "Capability 模式"权限授权后，**需要重启进程**才能让 TCC sandbox
  //     上下文重新计算
  //   - 让 LLM 对普通文件夹也建议重启 → 用户白白经历重启过程，丢上下文 +
  //     有可能误点未保存的 doc 弹窗
  //
  // 修订策略：按 category 拆 directives 与文案。两类共享 userGuidance 头部
  // 但末尾收束语 + agentDirectives 差异化。
  const categoryName: Record<OSErrorCategory, string> = {
    RemovableVolume: '外接磁盘',
    CloudStorage: 'iCloud 云盘',
    Documents: '文稿文件夹',
    Desktop: '桌面文件夹',
    Downloads: '下载文件夹',
    NetworkVolume: '网络共享卷',
    FullDisk: '完全磁盘访问权限',
    Other: '文件与文件夹',
  };

  const cat = categoryName[category];
  const isFullDisk = category === 'FullDisk';
  const deepLink = isFullDisk
    ? MACOS_DEEPLINKS.fullDisk
    : MACOS_DEEPLINKS.filesAndFolders;
  const settingsPath = isFullDisk
    ? '系统设置 → 隐私与安全性 → 完全磁盘访问权限'
    : '系统设置 → 隐私与安全性 → 文件与文件夹';

  // 共享头：自然语言描述发生了什么 + 在哪儿授权。去掉"如果你之前点过『不允许』"
  // 这种把动机转嫁给用户的预设，去掉"权限类目：xx"这种工程师味注释。
  const headBase =
    `我打开 ${p} 时被 Mac 阻止了——这是「${cat}」类的权限，需要你手动开一下。` +
    `请打开「${settingsPath}」，找到 TabTin，`;

  if (isFullDisk) {
    // Full Disk Access：授权后必须重启
    const userGuidance =
      headBase +
      `把它加入并勾选启用。授权后 TabTin 会弹出确认框，让你打开系统设置或重启应用；重启前会先请你保存未存工作。`;

    const agentDirectives = [
      '不要重试这个路径，重试在重启前只会再次拿到同样的权限错误',
      '不要建议用户用 sudo / chmod / xattr 等方式绕过 macOS 权限保护',
      '不要调用模型工具重启进程；重启由宿主确认框处理',
      '用户说已经授权后，提醒他们在宿主确认框里选择重启；重启回来后用户再次提及该任务时立即重试',
    ];

    const recoveryActions: RecoveryAction[] = [
      { type: 'open_system_settings', label: `打开${settingsPath}`, deepLink },
      { type: 'restart_app', label: '重启 TabTin（完全磁盘访问授权后必须）' },
      { type: 'choose_alternate_path', label: '改用其他位置' },
    ];

    return { userGuidance, agentDirectives, recoveryActions };
  }

  // Desktop / Documents / Downloads / Removable / Network / Other：
  // 授权后**不需要重启**——直接 clear + 重试即可。
  const userGuidance =
    headBase +
    `打开「${cat}」开关。授权完后告诉我一声，我直接帮你接着读，通常不需要重启 TabTin。`;

  const agentDirectives = [
    '不要重试这个路径，重试只会再次拿到同样的权限错误',
    '不要建议用户用 sudo / chmod / xattr 等方式绕过 macOS 权限保护',
    '用户表示授权完成后，立即重试原工具；不要假设存在模型侧解封工具',
    '只有当重试再次拿到同一权限错误时（极少见），才说"看起来这条权限可能需要重启 TabTin 才生效，要我帮你重启吗？"，用户同意时交给宿主授权流程处理',
    '不要主动建议重启 —— 普通文件夹授权后通常立即生效',
  ];

  const recoveryActions: RecoveryAction[] = [
    { type: 'open_system_settings', label: `打开${settingsPath}`, deepLink },
    { type: 'choose_alternate_path', label: '改用其他位置' },
  ];

  return { userGuidance, agentDirectives, recoveryActions };
}

function tplPermissionDeniedWin32(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  const userGuidance =
    `我尝试访问 ${p} 时被拒绝。Windows 上常见原因有两种：` +
    `(1) 文件本身的 NTFS 权限只允许其他账号读写，可右键文件 → 属性 → 安全 检查；` +
    `(2) 你的账户对该路径没有读写权限。` +
    `请确认你当前 Windows 账户拥有对这个目录的访问权，或换一个你有权限的位置让我重试。`;

  const agentDirectives = [
    `不要重试同一路径直到用户调整权限或换路径`,
    `不要建议用户运行 icacls / takeown 等高风险命令，除非用户明确表达管理员意图`,
  ];

  const recoveryActions: RecoveryAction[] = [
    { type: 'choose_alternate_path', label: '改用其他位置' },
  ];

  return { userGuidance, agentDirectives, recoveryActions };
}

function tplPermissionDeniedLinux(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  const userGuidance =
    `我尝试访问 ${p} 时收到 EACCES（权限被拒绝）。` +
    `请确认你当前账户对这个路径有读写权限（可在终端运行 \`ls -l ${p}\` 查看），` +
    `或换一个你有权限的位置让我重试。`;
  const agentDirectives = [
    `不要重试同一路径直到用户调整权限或换路径`,
    `不要主动建议用户使用 sudo —— 除非用户明确表达管理员意图`,
  ];
  return {
    userGuidance,
    agentDirectives,
    recoveryActions: [
      { type: 'choose_alternate_path', label: '改用其他位置' },
    ],
  };
}

// ─── OS_AV_BLOCKED（仅 Windows） ─────────────────────────────────────────

function tplAVBlocked(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  const userGuidance =
    `我访问 ${p} 时操作被拦截或长时间没响应，疑似你电脑上的安全软件（常见为 360 安全卫士 / 火绒 / 腾讯电脑管家 / Windows Defender 受控文件夹访问）阻止了 TabTin。` +
    `请打开你的安全软件，把 TabTin 加进信任 / 白名单后告诉我，我重新尝试。` +
    `如果不确定用的是哪个安全软件，看任务栏右下角的盾牌或动物图标。`;

  const agentDirectives = [
    `不要重试这个路径直到用户确认已加白名单`,
    `不要建议重启 TabTin —— 重启不解决杀软拦截`,
    `如果用户使用 Windows Defender 受控文件夹访问，可推荐快捷链接：windowsdefender://Threat/`,
  ];

  const recoveryActions: RecoveryAction[] = [
    { type: 'whitelist_in_av', label: '在安全软件中添加 TabTin 白名单' },
    {
      type: 'open_system_settings',
      label: '打开 Windows 安全中心',
      deepLink: WINDOWS_DEEPLINKS.controlledFolderAccess,
    },
  ];

  return { userGuidance, agentDirectives, recoveryActions };
}

// ─── CLOUD_NOT_DOWNLOADED ────────────────────────────────────────────────

function tplCloudNotDownloaded(input: TemplateInput): TemplateOutput {
  const { path: p, platform } = input;

  let provider = '云盘';
  if (platform === 'darwin') provider = 'iCloud 云盘';
  else if (platform === 'win32') provider = 'OneDrive';

  const userGuidance =
    `${p} 还是 ${provider} 的占位文件，本地暂未完整下载。` +
    `请在文件管理器里右键这个文件，选「始终保留在此设备」（macOS 是「现在下载」），让它先同步好；` +
    `或者告诉我读取另一个已下载到本地的版本。`;

  const agentDirectives = [
    `不要重试这个路径直到用户确认已下载完成`,
    `不要尝试重启 TabTin —— 占位文件问题与权限无关`,
    `如果用户网络/云盘配额异常，建议改用本地副本`,
  ];

  return {
    userGuidance,
    agentDirectives,
    recoveryActions: [
      { type: 'wait_cloud_sync', label: '等待云盘同步完成' },
      { type: 'choose_alternate_path', label: '改用其他已下载文件' },
    ],
  };
}

// ─── NETWORK_CREDENTIAL_REQUIRED ─────────────────────────────────────────

function tplNetworkCredential(input: TemplateInput): TemplateOutput {
  const { path: p, platform } = input;
  const isWin = platform === 'win32';

  const userGuidance = isWin
    ? `访问网络盘 ${p} 需要凭据。请在文件资源管理器里手动打开一次这个共享，输入账号密码并勾选「记住凭据」，然后告诉我可以了，我重新尝试。`
    : `访问网络共享 ${p} 需要凭据。请在 Finder 里手动连接一次该共享（菜单 前往 → 连接服务器），输入凭据并保存到钥匙串，然后告诉我可以了。`;

  return {
    userGuidance,
    agentDirectives: [
      `不要重试同一路径直到用户确认凭据已保存`,
      `不要建议用户在命令行里明文输入密码`,
    ],
    recoveryActions: [{ type: 'reauth_credential', label: '重新输入网络凭据' }],
  };
}

// ─── PATH_TOO_LONG（Windows） ────────────────────────────────────────────

function tplPathTooLong(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  const userGuidance =
    `路径 ${p} 长度超过 Windows 默认限制（260 字符）。` +
    `你可以把文件移到层级更浅的目录（如 C:\\Work\\），或在系统中启用「长路径支持」` +
    `（组策略：计算机配置 → 管理模板 → 系统 → 文件系统 → 启用 Win32 长路径）。`;

  return {
    userGuidance,
    agentDirectives: [
      `不要重试这个路径，长度问题不会因重试改变`,
      `如果是 Agent 自己生成的路径，下次生成时控制长度 < 240 字符`,
    ],
    recoveryActions: [{ type: 'choose_alternate_path', label: '换更短的路径' }],
  };
}

// ─── DISK_LOCKED ─────────────────────────────────────────────────────────

function tplDiskLocked(input: TemplateInput): TemplateOutput {
  const { path: p, platform } = input;
  const tech = platform === 'darwin' ? 'FileVault' : platform === 'win32' ? 'BitLocker' : 'LUKS';
  const userGuidance =
    `访问 ${p} 失败，磁盘可能已加密但尚未解锁（${tech}）。` +
    `请在文件管理器或磁盘工具里输入密码解锁该磁盘后，告诉我可以了再重试。`;
  return {
    userGuidance,
    agentDirectives: [`不要重试，磁盘必须先解锁`],
    recoveryActions: [{ type: 'reauth_credential', label: `解锁 ${tech} 加密盘` }],
  };
}

// ─── TARGET_BUSY ─────────────────────────────────────────────────────────

function tplTargetBusy(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  return {
    userGuidance:
      `${p} 当前被其他程序占用（可能正在编辑或同步中）。请关闭使用该文件的程序后告诉我，或换一个文件让我尝试。`,
    agentDirectives: [
      `可以等待用户确认后重试一次，但不要循环重试`,
      `如果是 Agent 自己创建的进程在用，应先释放它`,
    ],
    recoveryActions: [{ type: 'choose_alternate_path', label: '改用其他文件' }],
  };
}

// ─── TARGET_NOT_FOUND ────────────────────────────────────────────────────

function tplTargetNotFound(input: TemplateInput): TemplateOutput {
  const { path: p } = input;
  return {
    userGuidance:
      `路径 ${p} 不存在。请确认路径拼写正确，或告诉我你想让我读取的实际位置。`,
    agentDirectives: [
      `不要重试同一路径，先跟用户确认实际位置`,
      `如果路径是 Agent 自己推断的，应承认推断有误并请用户给出准确路径`,
    ],
    recoveryActions: [{ type: 'choose_alternate_path', label: '指定正确路径' }],
  };
}

// ─── 主调度器 ────────────────────────────────────────────────────────────

export function renderTemplate(
  code: OSErrorCode,
  input: TemplateInput,
): TemplateOutput {
  switch (code) {
    case 'OS_PERMISSION_DENIED':
      if (input.platform === 'darwin') return tplPermissionDeniedMacOS(input);
      if (input.platform === 'win32') return tplPermissionDeniedWin32(input);
      return tplPermissionDeniedLinux(input);
    case 'OS_AV_BLOCKED':
      return tplAVBlocked(input);
    case 'CLOUD_NOT_DOWNLOADED':
      return tplCloudNotDownloaded(input);
    case 'NETWORK_CREDENTIAL_REQUIRED':
      return tplNetworkCredential(input);
    case 'PATH_TOO_LONG':
      return tplPathTooLong(input);
    case 'DISK_LOCKED':
      return tplDiskLocked(input);
    case 'TARGET_BUSY':
      return tplTargetBusy(input);
    case 'TARGET_NOT_FOUND':
      return tplTargetNotFound(input);
  }
}
