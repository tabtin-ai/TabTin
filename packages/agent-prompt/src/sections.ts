import type {
  ConversationReferenceInput,
  RuntimeIdentity,
  ToolLike,
  EnabledAppInfo,
  SubagentCatalogEntry,
  WorkingDirType,
  PromptShellInfo,
} from './types.js';
import { formatAgentDatetime } from './datetime.js';
import { SECTION_OPERATING_LOOP } from './generated-content.js';

const DEFAULT_BEHAVIOR_RULES: readonly string[] = [
  '跟随用户语言：用户用中文你就用中文，用英文你就用英文，混用时跟主语种但保留技术术语原形。',
  '基于事实，不靠猜测：你操作和回答所依据的一切具体值——标识符、路径、参数、引用、字段——都必须来自工具结果或已确认的事实，绝不凭记忆或直觉拼造；缺了就先用工具获取，而不是先猜再试。信息不足时先补取证，再行动。',
  '指代落空要澄清：用户按名称 / 属性指代某个目标（文件、文件夹、表、记录、页面……）时，只有候选里确有匹配才执行；一个都不匹配时，即使只剩唯一候选，也不得静默把它当成用户所指去执行有副作用的动作（打开 / 删除 / 移动 / 修改等），要先说明「没找到叫 X 的」并给出实际存在的候选让用户确认。只读的浏览 / 列举不受此限。',
  '简洁高效：用最少必要的工具调用完成任务，不要做冗余查询。',
  '透明：不确定时明说局限。',
  '及时同步：任务推进中及时告知用户当前进展和接下来的计划。',
  '结构化呈现：查询结果用表格或列表呈现，不要回显 raw JSON。',
  '清晰引导：需要用户动作时，给出具体的下一步建议。',
];

/**
 *  规则优先级链（LLM 可见契约 SSoT）。
 *
 * 偏好型（语言 / 语气 / 输出格式 / 风格等）可被本轮临时要求覆盖；
 * 平台安全、权限、数据保护、审批与 sandbox 等硬边界不可覆盖。
 * Electron 显式 opt-in 后把 personal + Agent 自由文本统一放进 pre-user
 * `agent-profile`；未 opt-in 的宿主仍在 system 携带 personal rules。
 * Agent custom rules 由  始终走动态 profile。
 */
export const RULES_PRIORITY_CHAIN =
  '平台硬边界 > 本轮用户明确临时要求（偏好范围）> Agent 专属偏好 > 个人通用偏好 > `<principle>` 系统默认行为';

/** 偏好型规则举例（可被本轮临时要求覆盖的类别）。 */
export const RULES_PREFERENCE_EXAMPLES = '语言、语气、输出格式、风格';

/**
 * 硬边界不可覆盖说明——必须同时出现在 personal / agent-profile / 单层
 * custom_rules 段首，防止模型把「本轮用户优先」误读成可绕过安全。
 */
export const RULES_HARD_BOUNDARY_NOTE =
  '平台安全、权限、数据保护、审批与 sandbox 等硬边界不可被个人/Agent 偏好或本轮临时要求覆盖，仍必须遵守；'
  + '也不要把偏好覆盖权扩展成可绕过仓库强制工作流或安全边界。';

/**
 * 当前 Agent 的身份句 / 人设与规则正文（不含 `<context>` 外壳）。
 *
 * 由 `buildAgentProfileHook` 包成 `<context type="agent-profile">`，贴当前
 * user 消息之前注入——对话中可切换 Agent，故**不**进静态 `<principle>` /
 * system prompt。有展示名时用「你是{name}。」注入身份，
 * 不用 `## 展示名称` 元数据标题。`personalRules` / `customRules` 分别承接存量
 * `UserProfile.personal_rules` / `Agent.custom_rules` 自由文本，不解析正文，
 * 只按字段来源和顺序结构化。产品不再使用独立「当前目标」段。全部为空 →
 * 返回 ''（本轮跳过注入）。
 *
 * ：段首与 system `<custom_rules>` 共用 `RULES_PRIORITY_CHAIN`，
 * 声明本轮临时偏好可覆盖本段长期偏好，硬边界仍不可覆盖。
 */
export function buildAgentProfileSection(input: {
  agentName?: string;
  /** `UserProfile.personal_rules`：兼容存量自由文本，按个人长期偏好注入。 */
  personalRules?: string;
  /** `Agent.custom_rules`：Agent 人设与专属规则。 */
  customRules?: string;
  /** ：`Workspace.custom_rules`：当前执行现场规则（与 Agent 人设分离）。 */
  workspaceRules?: string;
}): string {
  const agentName = input.agentName?.trim() || '';
  const personalRules = input.personalRules?.trim() || '';
  const customRules = input.customRules?.trim() || '';
  const workspaceRules = input.workspaceRules?.trim() || '';
  if (!agentName && !personalRules && !customRules && !workspaceRules) return '';

  const lines: string[] = [];
  if (agentName) {
    lines.push(`你是${agentName}。`);
  }
  if (personalRules || customRules || workspaceRules) {
    if (lines.length > 0) lines.push('');
    lines.push(
      '## 人设与规则',
      '[系统说明] 下面是用户保存的长期自由文本配置，不是平台安全策略。'
        + `规则优先级是：${RULES_PRIORITY_CHAIN}。`
        + `本轮真实 user 消息位于本上下文之后，因此其中对${RULES_PREFERENCE_EXAMPLES}等事项的明确临时要求优先。`
        + '平台不对下列自由文本做脆弱的自然语言分类；按字段来源和固定顺序合并：'
        + '`personal_rules` → `custom_rules`（Agent）→ `workspace_rules`（现场）；'
        + '现场规则就近优先于 Agent 人设。'
        + RULES_HARD_BOUNDARY_NOTE,
    );
    if (personalRules) {
      lines.push(
        '',
        '<long_term_preference source="personal_rules" format="free_text">',
        personalRules,
        '</long_term_preference>',
      );
    }
    if (customRules) {
      lines.push(
        '',
        '<long_term_preference source="custom_rules" format="free_text">',
        customRules,
        '</long_term_preference>',
      );
    }
    if (workspaceRules) {
      lines.push(
        '',
        '<long_term_preference source="workspace_rules" format="free_text">',
        workspaceRules,
        '</long_term_preference>',
      );
    }
  }
  return lines.join('\n');
}

function stripTopLevelTag(section: string, tagName: string): string {
  return section
    .replace(new RegExp(`^<${tagName}>\\n?`), '')
    .replace(new RegExp(`\\n?</${tagName}>$`), '');
}

export function buildPrincipleSection(): string {
  const rulesText = DEFAULT_BEHAVIOR_RULES.map((r) => `- ${r}`).join('\n');
  const operatingLoopText = stripTopLevelTag(SECTION_OPERATING_LOOP, 'operating_loop');

  //  / ：具体 Agent 身份走 agent-profile（「你是{name}。」/ 人设与规则）；
  // 本段只定义不抢 persona 的默认原则；运行位置与术语走 environment。
  return `<principle>
## 行为规则

${rulesText}

## 每轮操作循环

${operatingLoopText}
</principle>`;
}

/** @deprecated use buildPrincipleSection. Kept for older package consumers. */
export const buildIdentitySection = buildPrincipleSection;

/**
 * Runtime self-knowledge —— 拆成三段独立 push：
 *
 * 1. `<environment>` — 「我现在在哪」：Organization / 工作空间 / Session +
 *    可用环境变量 + 产品术语。纯事实与术语；**不**贴工作目录绝对路径值。
 * 2. `<shell_runtime>` — 「Shell 工具运行时约定」：默认 cwd、当前 shell 身份、
 *    以及如何按 shell 语法引用 environment 中列出的变量。独立成段避免把工具规则
 *    塞进身份段。
 * 3. `<platform_data>` — 「平台托管数据触发条件 + 使用纪律」：只在恢复早期
 *    对话、定位截断输出或调试执行链路时读取，具体协议归工具 description。
 *
 * environment 始终注入平台位置与术语；shell_runtime / platform_data 由 RuntimeIdentity 驱动。
 */

// `formatWorkspacePathLine` + `MAX_ENVIRONMENT_PATHS` 在单根契约下退役
// （docs/single-root-space-prd.md §2.1）：environment 段只展示 workspaceRoot
// 单一执行根，不再渲染 TabCode / TabFolder 多路径列表。

/**
 * `<environment>` 段：平台位置、产品术语与运行时身份事实。
 *
 * 单根契约（见 docs/single-root-space-prd.md §2.1）：每个工作空间只有一个执行根
 * = `workspaceRoot`（= agent.working_dir）。绝对路径值**不**写在本段——避免模型把
 * 产品名「工作空间」 与路径前缀 `workspace/` 混用；本段只列环境变量名和使用边界。
 * **不写**工具规则、教程、安全规则——那些归 shell_runtime / platform_data /
 * principle 段。
 */
export function buildEnvironmentSection(identity?: RuntimeIdentity): string {
  const termLines = [
    '## 术语',
    '',
    '- **Organization**：拥有工作空间 / Project 的团队 / 租户。',
    identity
      ? '- **工作空间**：当前执行现场，包含已启用 App、云端资源和本地工作目录；具体身份见本段，路径变量见本段 `## 环境变量`，shell 语法见 `<shell_runtime>`。'
      : '- **工作空间**：当前执行现场，包含已启用 App、云端资源和本地工作目录；有运行时身份时，本段会列出路径变量，shell 语法见 `<shell_runtime>`。',
    '- **Agent**：当前对话的人设、规则、技能与记忆载体。',
    '- **App**：用户可打开并承载资源或操作的功能模块；当前可用能力见 `<apps>`。',
  ];

  if (!identity) {
    return [
      '<environment>',
      '你运行在 TabTin 工作空间中。',
      '',
      ...termLines,
      '</environment>',
    ].join('\n');
  }

  // §17.6 D4：RuntimeIdentity.sessionId → threadId。本段渲染仅作展示，
  // 局部别名 `sessionId` 保留以最小化下游字符串模板改动（与 platform_data 段一致）。
  // workspaceRoot 仍由 RuntimeIdentity 携带并驱动 shell_runtime / env 注入；
  // 本段只渲染环境变量名，不渲染路径值。
  const { spaceId, organizationId, threadId: sessionId, spaceName, organizationName } = identity;
  // 名字字段缺失时退化为只显示 UUID（老路径 / 测试兼容）；存在时把名字放
  // 在 UUID 之前，让 Agent 在面向用户的措辞里优先使用名字。
  const organizationLabel = organizationName ? `"${organizationName}"   (id: ${organizationId})` : organizationId;
  const spaceLabel = spaceName ? `"${spaceName}"   (id: ${spaceId})` : spaceId;
  // label 中文化（阶段 1 P3 audit 抓出来的真问题：原英文 label 让段判 mixed）。
  return [
    '<environment>',
    '你运行在 TabTin 工作空间中。',
    '',
    '## 当前运行环境',
    '',
    `组织：       ${organizationLabel}`,
    `工作空间：  ${spaceLabel}`,
    `会话：       ${sessionId}`,
    '',
    '## 环境变量',
    '',
    '- `TABTIN_WORKSPACE`：runtime 自动注入的工作目录绝对路径；终端默认 cwd 等于它的值。只在 shell 命令内部拼路径，不要作为结构化 FC 工具参数；相对路径相对工作目录根本身，禁止再套一层 `workspace/` 前缀。',
    '',
    ...termLines,
    '</environment>',
  ].join('\n');
}

/**
 * 渲染 `<shell_runtime>` 段首的「当前 shell 身份 + 语法纪律」条目。
 *
 * 方案 2 收敛：shell 专属语法提示统一归口到本段——POSIX（bash/zsh/
 * sh）声明 shell 身份 + POSIX 语法，Windows（powershell/cmd）给对应语法块；issue
 *  起共享 cwd/env 条目也按 shell 分支。`run_terminal_command` 工具描述保持
 * shell 无关的纯功能骨架（不含具体 shell 命令示例）。数据源
 * `resolveAgentShellInfo()` 与真正执行命令的 `spawnAgentShellProcess` 同源。
 *
 * 缺 shellInfo（旧 host / 测试）→ 返回空串，段落逐字节兼容历史输出。
 */
function buildShellIdentityBullet(shellInfo?: PromptShellInfo): string {
  if (!shellInfo) return '';
  if (shellInfo.kind === 'powershell') {
    return `- 当前 shell：PowerShell（\`${shellInfo.shell}\`），不是 bash：
  - 串联命令用 \`;\`（PS7 也支持 \`&&\`）；切目录 \`Set-Location <path>\` 或 \`cd <path>; <cmd>\`，环境变量 \`$env:TABTIN_WORKSPACE\`
  - 含空格的路径用单引号字面字符串（\`'C:\\path with space\\x'\`）
  - 等待用工具参数 \`wait_ms\` / \`pattern\`；bash 专属写法（\`until...do...done\` / \`[[ ! -f ]]\` / \`| cat\`）不适用
`;
  }
  if (shellInfo.kind === 'cmd') {
    return `- 当前 shell：cmd.exe（\`${shellInfo.shell}\`），不是 bash：
  - 串联命令用 \`&&\`；切目录 \`cd /d <path> && <cmd>\`，环境变量 \`%TABTIN_WORKSPACE%\`
  - 含空格的路径用双引号（\`"C:\\path with space\\x"\`）；cmd 不识别单引号
  - 等待用工具参数 \`wait_ms\` / \`pattern\`；bash 专属写法（\`until...do...done\` / \`[[ ! -f ]]\` / \`| cat\`）不适用
`;
  }
  // POSIX 主路径（bash/zsh/sh/other，含 macOS zsh / Linux bash）。
  // 只声明语法纪律，不枚举具体等待命令配方（与 Windows 侧一致，避免命令特判）。
  return `- 当前 shell：${shellInfo.kind}（\`${shellInfo.shell}\`）——用 POSIX shell 语法：\`&&\` / \`;\` 串联、\`cd /abs && <cmd>\` 切目录、\`$TABTIN_WORKSPACE\` 读环境变量。等待用工具参数 \`wait_ms\` / \`pattern\`；别套用其它 shell（PowerShell / cmd）的专属写法。
`;
}

/**
 * `<shell_runtime>` 段中与 cwd / 工作目录变量引用相关的共享条目。
 *
 * ：切目录 / env **形态**只在身份行声明一次；本段只补「默认 cwd 契约」。
 * `TABTIN_WORKSPACE` 的完整描述归 `<environment>` 的 `## 环境变量`。缺 shellInfo 时
 * 用 shell 中性文案，**禁止**回落 `cd /abs &&` / `$TABTIN_WORKSPACE` 等 POSIX 残留
 * （旧 host 也不应被诱导写 bash）。
 * ：禁止把产品名「工作空间」 说成路径前缀 `workspace/`。
 */
function buildShellRuntimeSharedBullets(shellInfo?: PromptShellInfo): string {
  const noWorkspacePrefix =
    '相对路径相对工作目录根本身——**禁止**再套一层名为 `workspace/` 的前缀。';
  if (shellInfo?.kind === 'powershell') {
    return `- 默认 cwd = \`$env:TABTIN_WORKSPACE\` 的值（见 \`<environment>\` 的 \`## 环境变量\`）。终端执行入口不单独接受 cwd；
  要切目录用绝对路径，或按上方身份行的切目录语法内联。
- PowerShell 中引用 \`TABTIN_WORKSPACE\` 用 \`$env:TABTIN_WORKSPACE\`。${noWorkspacePrefix}
`;
  }
  if (shellInfo?.kind === 'cmd') {
    return `- 默认 cwd = \`%TABTIN_WORKSPACE%\` 的值（见 \`<environment>\` 的 \`## 环境变量\`）。终端执行入口不单独接受 cwd；
  要切目录用绝对路径，或按上方身份行的切目录语法内联。
- cmd 中引用 \`TABTIN_WORKSPACE\` 用 \`%TABTIN_WORKSPACE%\`。${noWorkspacePrefix}
`;
  }
  if (shellInfo) {
    return `- 默认 cwd = \`$TABTIN_WORKSPACE\` 的值（见 \`<environment>\` 的 \`## 环境变量\`）。终端执行入口不单独接受 cwd；
  要切目录用绝对路径，或按上方身份行的切目录语法内联。
- POSIX shell 中引用 \`TABTIN_WORKSPACE\` 用 \`$TABTIN_WORKSPACE\`。${noWorkspacePrefix}
`;
  }
  // 无身份行：勿假设任何具体 shell 语法；也不贴 POSIX/`$…` 变量形态。
  return `- 默认 cwd = \`<environment>\` 的 \`## 环境变量\` 所列工作目录变量的值。终端执行入口不单独接受 cwd；
  要切目录用绝对路径；无 shell 身份行时**勿假设 bash/POSIX**，等待用 \`wait_ms\` / \`pattern\`。
- 需要工作目录绝对路径时，按实际 shell 语法引用 \`<environment>\` 所列变量。${noWorkspacePrefix}
`;
}

/**
 * `<shell_runtime>` 段：Shell 工具的运行时约定。
 *
 * 单一职责：解释 `run_terminal_command` 默认 cwd + 当前 shell 变量引用语法，
 * 并声明「当前是哪个 shell + 该用什么语法」（ 方案 2：shell 语法提示从
 * 工具描述收敛到此；：共享 cwd/env 条目也按 shell 分支，避免与身份行矛盾）。
 * 依赖 RuntimeIdentity（有 identity 才注入），放在 environment 段之后。
 */
export function buildShellRuntimeSection(
  identity?: RuntimeIdentity,
  shellInfo?: PromptShellInfo,
): string {
  if (!identity) return '';
  return `<shell_runtime>
${buildShellIdentityBullet(shellInfo)}${buildShellRuntimeSharedBullets(shellInfo)}- 工作目录根对应的本地文件区初始可为空；需要落盘时用相对该根的路径（如 \`artifacts/report.pdf\`），
  shell 内需要绝对路径时，用 \`<environment>\` 所列变量按实际 shell 语法拼接——不要额外创建名为 \`workspace\` 的子目录。
- 命令撞 hardline / 受限模式 / 权限策略时，按返回的错误分类与建议调整，必要时请用户手动执行；不要靠重复尝试探边界。
</shell_runtime>`;
}

/**
 * `<platform_data>` 段：平台托管数据 + 使用纪律。
 *
 * 只承载高层策略：何时读取、按需小范围读取、作为 silent memory 使用，以及
 * 平台数据不得出站。record_type / 分页等 API 协议归 read_platform_data 工具描述。
 *
 * 单独成段是因为这些规则全部围绕「platform data 是 silent memory」展开，
 * 跟 environment 段的「我在哪」是不同议题。
 */
/** 对话预览在 `<conversation_reference>` 段内的显示上限。 */
const CONVERSATION_REFERENCE_PREVIEW_CHARS = 300;

function formatRuntimeIdLabel(name: string | undefined, id: string): string {
  return name ? `"${name}"   (id: ${id})` : id;
}

/**
 * `<conversation_reference>` 段 —— 用户从另一段对话复制过来的引用上下文。
 *
 * 粘贴到新对话后，Agent 应把 archive 当隐式记忆（跟 `<platform_data>` 同款
 * 纪律）：用 read_file 恢复细节，不在面向用户的回复里暴露 archive 绝对路径
 * 或复述读盘动作。
 */
export function buildConversationReferenceSection(input?: ConversationReferenceInput): string {
  if (!input?.threadId?.trim()) return '';

  const {
    // §17.6 D4：ConversationReferenceInput.sessionId → threadId。
    // 局部别名保留 sessionId 以最小化下游字符串模板改动。
    threadId: sessionId,
    title,
    preview,
    organizationId,
    organizationName,
    spaceId,
    spaceName,
    workspaceRoot,
    archiveDir,
    toolLogsDir,
    lastMessageAt,
    messageCount,
    createdAt,
    timeZone,
  } = input;

  const lines: string[] = [
    '<conversation_reference>',
    '[系统说明] 用户从另一段对话复制了这段引用，希望你了解那边发生了什么。把 archive 当隐式记忆，按需读取以恢复细节；不要复述读取动作，也不要在面向用户的回复里暴露 archive 绝对路径（输出纪律同 `<platform_data>`）。',
    '',
    '## 对话概要',
  ];

  if (title?.trim()) lines.push(`标题：       ${title.trim()}`);
  if (typeof messageCount === 'number') lines.push(`消息数：     ${messageCount}`);
  // 按用户设备时区渲染（带显式 offset），避免裸 UTC ISO 串让 Agent 误判对话新旧。
  if (lastMessageAt) lines.push(`最后活动：   ${formatAgentDatetime(lastMessageAt, timeZone)}`);
  else if (createdAt) lines.push(`创建时间：   ${formatAgentDatetime(createdAt, timeZone)}`);
  if (preview?.trim()) {
    const clipped = preview.trim().length > CONVERSATION_REFERENCE_PREVIEW_CHARS
      ? `${preview.trim().slice(0, CONVERSATION_REFERENCE_PREVIEW_CHARS)}…`
      : preview.trim();
    lines.push(`预览：       ${clipped}`);
  }

  lines.push(
    '',
    '## 定位（源对话运行时）',
    `组织：       ${formatRuntimeIdLabel(organizationName, organizationId)}`,
    `工作空间：  ${formatRuntimeIdLabel(spaceName, spaceId)}`,
    `会话：       ${sessionId}`,
  );
  if (workspaceRoot) lines.push(`工作目录：   ${workspaceRoot}`);

  if (archiveDir && toolLogsDir) {
    lines.push(
      '',
      '## Archive（源对话隐式记忆）',
      `    ${archiveDir}/${sessionId}/`,
      '      ├── messages.jsonl   完整对话记录',
      '      ├── events.jsonl     工具调用和流事件',
      '      └── snapshots.jsonl  每次 LLM 调用的输入快照',
      `    ${toolLogsDir}/${sessionId}/   每次工具调用一个 .md（完整 I/O）`,
      '',
      '需要回忆源对话细节时，使用当前实际可用的本地读取能力访问上述文件。',
    );
  } else {
    lines.push(
      '',
      '## Archive',
      '本地 archive 路径未能解析——若需细节，请让用户重新复制引用，或根据上方会话 ID 在平台托管 conversations 目录下查找。',
    );
  }

  lines.push('</conversation_reference>');
  return lines.join('\n');
}

export function buildPlatformDataSection(identity?: RuntimeIdentity): string {
  if (!identity) return '';
  // RuntimeIdentity 只作为"当前 session 具备平台数据上下文"的开关；具体路径
  // 由 read_platform_data 工具在宿主层用同一份 identity 配置读取，不暴露给模型。
  return `<platform_data>
仅在需要恢复早期对话、定位被截断的能力输出或调试执行链路时读取平台数据；普通任务不要主动读取。具体读取协议由实际可用能力说明。

把平台数据当作本地、敏感的隐式记忆：按需小范围读取；不要写改平台托管记录，不要暴露内部定位或记录名，也不要复述读取动作。不得把其中内容复制到 web、MCP、浏览器、HTTP、邮件等出站调用；只在用户回复中引用完成当前任务所必需的短片段。
</platform_data>`;
}

/** 把任意文本压成单个 Markdown 表格单元格：折叠空白 + 转义 `|`，空值给占位符。 */
function tableCell(value: string | undefined): string {
  const s = (value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s || '—';
}

/**
 * `<apps>` 段：当前工作空间启用的 App 选型入口（精简版，）。
 *
 * 只保留：启用列表 + 称呼规则 + 未启用边界。CLI 子命令细节归
 * `<cli_capabilities>` / `--help`；skill 入口归 `<skills>` index。
 *
 * 装配方应从 `useSpaceApps.enabled` 过滤 + `ContextRegistry.getAgentExposedHandlers()`
 * 派生出 `EnabledAppInfo[]` 喂进来。缺省 / 空数组时跳过段（保持旧 host 兼容）。
 */
export function buildAppsSection(enabledApps?: readonly EnabledAppInfo[]): string {
  if (!enabledApps?.length) return '';
  const lines: string[] = [
    '<apps>',
    '当前工作空间已启用的 App（**选择把用户需求落到哪个 App** 的入口）。',
    '对用户用 displayName；内部匹配用 Key；操作走 `tabtin <CLI> ...`（子命令见 `<cli_capabilities>`、`tabtin <cliKey> --help`、`tabtin commands`）。',
    '未列出的 App：**不要**硬试 CLI（会 not installed）；说明未启用并引导安装，不要静默换通道。',
    '',
    '| App | Key | CLI | 能力 | 别名 |',
    '| --- | --- | --- | --- | --- |',
    ...enabledApps.map((app) => {
      const cli = app.cliKey && app.cliKey !== app.displayName ? app.cliKey : undefined;
      const cell = tableCell;
      const cliCol = cli ? `\`${cli}\`` : '—';
      const aliasCol = app.aliases?.length ? cell(app.aliases.join(' / ')) : '—';
      return `| ${cell(app.displayName)} | \`${cell(app.key)}\` | ${cliCol} | ${cell(app.capability)} | ${aliasCol} |`;
    }),
  ];
  lines.push('</apps>');
  return lines.join('\n');
}

/**
 * `<subagent_catalog>` 段 —— group 模式：当前工作空间可复用的子 Agent 角色库。
 *
 * 让主 Agent 组队时优先从已配置角色里挑选，而非每次凭空定义。空 catalog 跳过
 * 段（主 Agent 回退到 ad-hoc 定义角色，行为不变）。
 */
export function buildSubagentCatalogSection(catalog?: readonly SubagentCatalogEntry[]): string {
  if (!catalog?.length) return '';
  const lines: string[] = [
    '<subagent_catalog>',
    '当前工作空间已配置以下可复用的子 Agent 角色。组建团队时优先选择匹配角色；',
    '派发时写清任务背景、输入、交付与验收要求。没有合适角色时再临时定义。',
    '',
  ];
  for (const role of catalog) {
    const desc = role.description?.trim() || '（无描述）';
    // ：提供模板标识供能力协议引用，但不在 system prompt 维护参数名。
    const idPart = role.templateId ? `模板标识：${role.templateId}；` : '';
    lines.push(`- **${role.name}**（${idPart}${role.subagentType}）：${desc}`);
  }
  lines.push('</subagent_catalog>');
  return lines.join('\n');
}

export function buildCustomRulesSection(rules?: string): string {
  if (!rules?.trim()) return '';
  return `<custom_rules>\n${rules.trim()}\n</custom_rules>`;
}

/**
 * 分层规则统一渲染器（设置 IA Phase 3 §8.6）—— 把 **个人 / Agent** 两层
 * 通用规则组装进单个 `<custom_rules>` 块。
 *
 * **两层语义**（PM 决策）：
 *   - 个人基线（`personalRules`）：Agent **owner** 的 `UserProfile.personal_rules`，
 *     per-User 全局跨 Organization（共享 / 群聊现场取 owner 而非当前说话人，与
 *     userPortrait 现状对齐）。
 *   - Agent 专属（`customRules`）：`Agent.custom_rules`（存量字段，本层语义不变）。
 *
 *   （原「团队基线」层已下线：团队级一刀切 prompt 难以适配不同岗位、配不好反伤
 *   效果，岗位差异化改由 skill 系统按需装载承担。）
 *
 * **#6674 兼容语义**：段首写入统一优先级链。Electron 显式 opt-in 后由
 * agent-profile hook 把 personal + Agent 配置统一放进 pre-user context；
 * 未 opt-in 的宿主继续通过本函数在 system 携带 personal。custom rules
 * 由 shared assembler 始终清除，防止  回归。
 *
 * **DEFAULT_BEHAVIOR_RULES 关系**：不删除 `<principle>` 段平台内置行为规则
 *   （如「跟随用户语言」），但明确其优先级低于偏好型自定义规则；同时说明
 *   硬边界不是可被覆盖的默认行为。
 *
 * **单层优先级声明（ + ）**：个人空、仅 Agent 专属层非空时，
 *   注入单段 + 段首优先级（含本轮临时偏好与硬边界）。裸 wrap
 *   `buildCustomRulesSection` 保留无声明字节形态（audit / Electron FR-02 /
 *   snapshot）。两层全空 → 返回 ''。
 */
export function buildCustomRulesBlock(input: {
  personalRules?: string;
  customRules?: string;
}): string {
  const personal = input.personalRules?.trim() || '';
  const agent = input.customRules?.trim() || '';

  // 两层全空 → 不注入（空语义，等价旧 buildCustomRulesSection('')）。
  if (!personal && !agent) return '';

  // 仅 Agent 专属层（个人空）→ 单段形态 + 段首优先级声明。
  // 生产路径  后 Agent 专属改走 agent-profile；本分支保留给仍把
  // customRules 喂进 system 的调用方 / 单测。
  // 不复用 buildCustomRulesSection：那个是裸 wrap，被 audit / Electron FR-02 /
  // snapshot 钉死字节形态，单层优先级声明只在这条路径注入。
  if (!personal) {
    return [
      '<custom_rules>',
      '[系统说明] 下面是对你生效的自定义规则（长期偏好）。'
        + `规则优先级是：平台硬边界 > 本轮用户明确临时要求（偏好范围）> 本段自定义规则 > \`<principle>\` 系统默认行为。`
        + `偏好型规则（${RULES_PREFERENCE_EXAMPLES}等）：本轮用户消息中的明确临时要求优先于本段；`
        + '本段优先于 `<principle>`「跟随用户语言」等系统默认行为，不要回退跟随用户语言。'
        + RULES_HARD_BOUNDARY_NOTE,
      '',
      agent,
      '</custom_rules>',
    ].join('\n');
  }

  //  生产路径：system 通常只烘焙个人层；Agent 专属在
  // `<context type="agent-profile">` 的「人设与规则」。段首指向该块，避免
  // 误以为同块内还有 Agent 专属子标题。
  if (!agent) {
    return [
      '<custom_rules>',
      '[系统说明] 下面是跨 Agent 生效的个人通用规则（长期偏好）。'
        + `规则优先级是：${RULES_PRIORITY_CHAIN}。`
        + '若本轮消息前有 `<context type="agent-profile">` 且含「人设与规则」，'
        + '则在无本轮临时偏好冲突时，Agent 专属偏好 > 本段个人通用偏好；冲突时只执行 Agent 专属；不冲突则叠加。'
        + `偏好型规则（${RULES_PREFERENCE_EXAMPLES}等）：本轮用户消息中的明确临时要求优先于 Agent 专属与本段个人通用偏好。`
        + '两层都未规定的事项才用 `<principle>` 默认。'
        + RULES_HARD_BOUNDARY_NOTE,
      '',
      '## 个人通用规则（跨 Agent 生效的底层偏好）',
      personal,
      '</custom_rules>',
    ].join('\n');
  }

  // 多层同块（个人 + Agent 仍同时喂进 system 时）——保留合并协议 +  本轮层。
  const lines: string[] = [
    '<custom_rules>',
    '[系统说明] 下面是对你生效的自定义规则。'
      + `规则优先级是：${RULES_PRIORITY_CHAIN}。`
      + '执行任何任务前，你必须先在内部完成规则合并：',
    '',
    '1. 先按约束对象 / 意图分类：区分**硬边界**（平台安全、权限、数据保护、审批与 sandbox）'
      + `与**偏好型**（${RULES_PREFERENCE_EXAMPLES}、工作流程偏好等）。`,
    '2. 硬边界始终生效；个人/Agent 偏好或本轮临时要求都不得覆盖硬边界，也不得绕过仓库强制工作流。',
    '3. 偏好型：本轮用户消息中的明确临时要求 > Agent 专属偏好 > 个人通用偏好 > `<principle>` 默认。',
    '4. 对每一条个人通用规则，检查 Agent 专属规则里是否存在同类别、同约束对象且'
      + '语义冲突的规则；若冲突且无更高优先级的本轮临时要求，只执行 Agent 专属规则，'
      + '不要试图同时满足两者。',
    '5. 如果不冲突，个人通用规则与 Agent 专属规则叠加执行。',
    '6. 各层偏好都未规定的事项，才使用 `<principle>` 段里的系统默认行为。'
      + RULES_HARD_BOUNDARY_NOTE,
    '',
    '## 个人通用规则（跨 Agent 生效的底层偏好）',
    personal,
    '',
    '## Agent 专属规则',
    agent,
    '</custom_rules>',
  ];
  return lines.join('\n');
}

/** 宿主按代码场景注入的对话 worktree 路由规则。 */
export function buildWorktreeRoutingSection(): string {
  return `<worktree_routing>
在当前 TabTin 对话中创建或切换 Git worktree，分别使用 \`tabtin code worktree create\` / \`tabtin code worktree switch\`，不得直接执行 \`git worktree\` 或仓库脚本。必须在前台等待命令完成，不得后台执行。项目规则 / Skill 仍用于确定 branch、base 与 GitFlow；若其中写的是原生命令或脚本，把创建 / 切换步骤转换为上述 TabTin CLI。用户未指定路径时不要添加 \`--path\`，由 TabTin 选择托管目录。
</worktree_routing>`;
}

/**
 * `<work_mode>` 段 —— Agent 工作类型（code/doc/mixed）的默认执行策略指引。
 *
 * **职责**：取代已退役的 Soul 预设承担的「按场景配默认行为」——用 Agent 的工作
 * 目录类型决定它在「这类材料」上应有的默认做法与谨慎度。
 *
 * **只设行为默认，不放松强制安全**：实际可执行边界由后端 sandbox policy
 * （collaborative / full_auto，按 yolo gate 决定）强制，本段不改变任何权限，只告诉
 * Agent「面对这类工作，默认该怎么做事」。code 不等于"放开权限"，doc 也不等于"收紧
 * 权限"——三档都在同一套强制边界下，差别只在 Agent 的默认做法侧重。
 *
 * **空语义**：workingDirType 缺省 / 非法值 → 返回空串（builder 跳过注入），对未
 * 设置工作目录类型的 Agent 100% 行为兼容。
 */
export function buildWorkModeSection(workingDirType?: WorkingDirType): string {
  switch (workingDirType) {
    case 'code':
      return `<work_mode type="code">
当前是**代码项目**（工作目录是代码仓库）。默认执行策略：

- **不破坏现有代码是第一位**：改动收尾要让构建 / lint / 测试通过再算完成；遵循仓库已有的代码风格、目录结构和依赖管理方式，不擅自引入新范式。
- **先读懂再动手**：定位相关代码与调用方、找根因，而不是表面修补。
- **谨慎对待不可逆与高风险操作**：删除 / 覆盖文件、改依赖锁文件、git reset / push / 切分支等，动手前先说清影响；除非用户明确要求，否则不碰 git 历史。
</work_mode>`;
    case 'doc':
      return `<work_mode type="doc">
当前是**文档 / 文书项目**（以合同、案卷、资料、写作等文件处理为主）。默认执行策略：

- **以内容为中心**：重点是文件读写、整理与措辞质量，命令行 / 构建通常不是重点。
- **保护原始材料**：修改或重排前保留可追溯的原件；批量重命名 / 移动 / 删除文件前先确认。
- **重视结构与一致性**：关注产出物的条理、格式和用词统一，而不是工程化流程。
</work_mode>`;
    case 'mixed':
      return `<work_mode type="mixed">
当前是**代码与文档混合项目**。默认执行策略：

- **按当前任务自适应**：改代码时遵循代码项目的谨慎（构建 / 测试 / 风格、慎对 git 与不可逆操作）；处理文档时以内容整理为主、保护原件。
- **拿不准就更谨慎**：判断不清当前任务属于哪一类时，倾向更保守的一侧。
</work_mode>`;
    default:
      return '';
  }
}

/**
 * `<project_rules>` 段 —— 项目规约（AGENTS.md 自动加载，MVP）。
 *
 * 由 `packages/agent-runtime/src/engine/hooks/rules-injector.ts` 在每轮
 * LLM 调用前 `beforeIteration` 触发：从工作目录根部 `AGENTS.md` 读到内容
 * （宿主侧 `readProjectRules` 闭包负责读盘 + mtime 缓存 + 截断），调本函数
 * 渲染成 user message 注入 `state.messages` 最前。
 *
 * **段写在 agent-prompt 包**：保持"段文本 = SSoT 在 agent-prompt"的契约——
 * hook 只负责"何时注入 + 包成 message"，不写 LLM 可见文本。
 *
 * **为什么不复用 `user-context-wrapper`**（PRD §4.4 拍板）：wrapper 的统一外
 * 壳承载"跨轮 stale 检测"语义，且扩 `UserContextWrapperType` 必须同步改
 * Python 对端 `user_context_wrapper.py` + 跑契约测试——直接违反"不动 Django"。
 * 而 project_rules 每轮重注、不持久化、无跨轮 stale，用不上 wrapper 的机制，
 * 故用 bespoke `<project_rules source="AGENTS.md">` 标签，wrapper / Python 对端
 * 均不动。
 *
 * **与 `<custom_rules>` 的关系**：custom_rules 跟着 Agent 实体走（DB 字段，烘焙
 * 进静态 system 段）；project_rules 跟着代码库走（AGENTS.md，每轮注入 messages）。
 * 两者位置不同但都对模型可见、各带来源标签——对齐"共存、不分硬优先级"决策。
 *
 * **空语义**：body 去空白后为空 → 返回空串（hook 拿到空串会跳过注入）。
 */
export function buildProjectRulesSection(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `<project_rules source="AGENTS.md">
These are project-level instructions checked into the codebase. Follow them
unless they conflict with explicit user requests in this conversation.

${trimmed}
</project_rules>`;
}

/**
 * `<user_portrait>` 段 —— USER 层（M1.4）。
 *
 * 注入用户画像（5 段叙事），让 Agent 首日就"知道你是谁"。
 *
 * 触发条件：宿主从 user_portrait API 拉到 content_md 后传入。
 * 缺省为 undefined / 空串时不注入（M1 默认状态 + 用户禁用画像时）。
 *
 */
export function buildUserPortraitSection(content?: string): string {
  if (!content?.trim()) return '';
  return `<user_portrait>
[系统说明] 下面是当前用户的"小传"，由 TabTin 自动从他的笔记里整理出来。把它当作背景上下文用来个性化你的回复，**不要**明说"我从你的个人资料看到..."这种话。把这些信息自然融入对话即可。

如果小传里的内容和用户当前消息冲突，以用户当前消息为准——小传是历史上下文摘要，不是权威事实。

${content.trim()}
</user_portrait>`;
}

/**
 * Memory v2 自动召回（M3 阶段 3）—— `<memory_recall>` 段渲染器。
 *
 * 由 ``packages/agent-runtime/src/engine/hooks/memory-injector.ts`` 在每轮
 * LLM 调用前 ``beforeIteration`` 触发：从 Agent Memory API 拉到最近一条 user
 * 消息相关的 top-K 记忆，调本函数渲染段文本后再交给 ``buildUserContextWrapper``
 * （阶段 6 议题 2）包成统一的 ``<context type="memory-recall">...</context>``
 * user message 注入 ``state.messages``。
 *
 * **段写在 agent-prompt 包**：保持"段文本 = SSoT 在 agent-prompt"的契约——
 * hook 只负责"何时注入 + 包成 message"，不写 LLM 可见文本（避免把 prompt
 * 散落到 runtime 包）。snapshot / dump-prompt 测试也能直接 import 本函数
 * 生成稳定样本，不需要装载 runtime。
 *
 * **阶段 6 议题 2 治理**：段输出**不再自带** `<memory_recall>` 标签——统一外
 * 壳由 `buildUserContextWrapper('memory-recall', ...)` 在 hook 注入时套上。
 * 这让 6 类"自动加料"共享一个 wrapper SSoT，history 装填阶段只需要一个
 * parser 就能枚举所有类型。
 *
 * **入参约定**（来自 `@tabtin/agent-runtime` `MemorySummary`，避免循环依赖
 * 这里复述字段集）：
 * ```
 * { id?, content, memo_type?, tags?, importance?, created_at?, source_url? }
 * ```
 *
 * **空数组语义**：返回空字符串——hook 拿到空串会跳过注入（与 context-injector
 * 同款 idiomatic "空结果 = no-op"）。
 */
export interface MemoryRecallEntry {
  id?: string;
  content: string;
  memo_type?: string;
  tags?: string[];
  importance?: number;
  created_at?: string;
  source_url?: string;
}

/** 一条 memo 在 `<memory_recall>` 段里的 content 显示上限——超过尾截 + 省略号。 */
const MEMORY_RECALL_PREVIEW_CHARS = 300;

export function buildMemoryRecallSection(memos: readonly MemoryRecallEntry[]): string {
  if (!memos.length) return '';
  const lines: string[] = [];
  lines.push('[系统说明] 下面是跟你当前对话相关的 Agent 长期记忆（自动召回）。把它当作历史上下文，不要复述"我从你的记忆里看到..."。');
  lines.push('');
  for (const memo of memos) {
    const typeLabel = memo.memo_type ? `[${memo.memo_type}]` : '[memo]';
    const content = memo.content.length > MEMORY_RECALL_PREVIEW_CHARS
      ? `${memo.content.slice(0, MEMORY_RECALL_PREVIEW_CHARS)}…`
      : memo.content;
    const tail = memo.created_at ? ` (${memo.created_at})` : '';
    lines.push(`- ${typeLabel} ${content}${tail}`);
  }
  return lines.join('\n');
}

export const CLI_USAGE_GUIDE = [
  '## CLI 使用规则',
  '- 命令形如 `tabtin <cliKey> <子命令> [--flag value ...]`；子命令名以本段命令表、`tabtin <cliKey> --help` / `tabtin commands` 为准，别猜。',
  '- **参数一律用 `--flag value`，不要用位置参数**——除非 `--help` 的 Usage 明确写了 `<arg>`。',
  '- 大段文本 / JSON / Markdown 用 `@文件路径` 或 `-`(stdin) 传，别把长内容塞进命令行。',
  '- 报错先读 envelope 的 `error.message` + `error.hint`（通常指向 `--help`），按提示改，别反复试。',
  '- **通用全局参数**：`--format json` 机读、`--jq \'<表达式>\'` 过滤（作用于已解包 data）、`--output <file>` 写盘（与 `--jq` 二选一）、`--inline` 大输出内联、`--quiet`/`-Q` 抑 stdout、`--dry-run` 只看计划、`--yes` 跳确认、`--timeout` 超时；定位：`--organization-id`/`--space-id`/`--agent-id`/`--profile`。',
].join('\n');

export function buildCliCapabilitiesSection(cliReference?: string | null): string {
  if (!cliReference) return '';
  return `<cli_capabilities>\n${CLI_USAGE_GUIDE}\n\n## 可用 CLI 命令\n\n${cliReference}\n</cli_capabilities>`;
}

interface ToolCategory {
  key: string;
  label: string;
  match: (name: string) => boolean;
}

/**
 * 工具分类清单 —— 阶段 6.2 治理后只承载"按用途分组列 name"，不再 inline guide。
 *
 * **设计哲学**（99 阶段 6.2）：
 *   - L1 工具自身 description 是 SSoT（讲工具自己干嘛 + 内部硬契约）。
 *   - L2 `<tools_reference>` 段只承载**跨工具决策**——"什么时候用 A 不用 B"。
 *   - 重复的工具简介（"ask_user：让用户从 2-4 个选项里选..."）从本段下线，
 *     LLM 调用前看 tools[].description 已经有；本段重复反而稀释跨工具引导。
 *
 * **删了哪些**（阶段 6 前的旧形态）：
 *   - 9 个分类 ``guide`` 内联段（每段重述 2-4 个工具的职责，与工具 description
 *     高度重复，约占段总长 70%）。
 *   - "其他"分类的 ``name: description`` 列表（重复 tools[] description 字段）。
 *
 * **保留了什么**：
 *   - 工具按用途分组（让 LLM 一眼看到"我手里有几类工具"），但每组只列 name。
 *   - 统一的"跨工具决策矩阵"段，集中处理 A vs B 的边界引导。
 */
const TOOL_CATEGORIES: ToolCategory[] = [
  {
    key: 'command',
    label: '终端 / 后台任务',
    match: (n) => n === 'run_terminal_command',
  },
  {
    key: 'file',
    label: '文件读写',
    match: (n) => ['read_file', 'edit_file', 'write_file', 'delete_file'].includes(n),
  },
  {
    key: 'search',
    label: '代码 / 内容搜索',
    match: (n) => ['grep_search', 'glob_search'].includes(n),
  },
  {
    // （2026-07-08）：request_approval 已下架，ask 工具只剩 ask_user / ask_form。
    key: 'ask',
    label: 'Ask 工具 + 任务追踪',
    match: (n) => ['ask_user', 'ask_form', 'todo'].includes(n),
  },
  {
    key: 'presentation',
    label: '展示 / 富内容',
    match: (n) =>
      ['parse_document', 'present_to_user', 'show_widget', 'web_search'].includes(n),
  },
  {
    key: 'memory',
    label: '凭证 / 记忆',
    match: (n) =>
      ['memory_search', 'memory_write', 'memory_delete', 'credential_lookup', 'credential_retrieve'].includes(n),
  },
  {
    // 本地 Skill 模块 Wave B · M7：skills_* / skill_* 同组（命名分歧见
    // skill-create-tool.ts）。Skill 激活不是模型工具，不进此列表。
    key: 'skills',
    label: 'Skills / 子 Agent / Plan',
    match: (n) =>
      ['skills_read', 'skills_search', 'skill_create', 'agent', 'plan_create', 'plan_update_todos'].includes(n),
  },
  {
    key: 'mcp',
    label: 'MCP（外部工具协议）',
    match: (n) => n.startsWith('mcp_'),
  },
  {
    key: 'host',
    label: '宿主控制',
    match: (n) => n === 'relaunch_app' || n === 'clear_os_error_blacklist',
  },
];

/**
 * 跨工具决策矩阵 —— 原 `<tools_reference>` 段核心载体（ 已从 production prompt 下线）。
 *
 * `buildToolsReferenceSection` 仍保留供快照/对照；builder 不再注入该段。
 */
const CROSS_TOOL_DECISIONS: readonly string[] = [
  '- **TabTin 业务能力（browser / table / doc / slide / tracker / fetch）不是 FC，通过 `run_terminal_command` 调 `tabtin <subcommand>` CLI 触达**。用 `tabtin commands --format json | jq` 发现可用命令；可解析输出始终带 `--format json`；平台会把 TabTin CLI 的 JSON 表 / 记录自动渲染成富 UI 卡片。',
  '- **文件搜索**：搜文件路径 → `glob_search`（不是 find）；搜文件内容（正则）→ `grep_search`（不是 grep / rg）。**搜 Agent 自己的笔记 / 用户记忆** → `memory_search`（不是 grep）。',
  '- **TabDoc 找文档（关键词）**：用户说找/搜/检索**当前工作空间里的文档**（标题或正文含关键词）→ `run_terminal_command` + `tabtin doc search --query "…" --format json`（见 tabdoc-operator Skill）。**禁止**用 `doc list` 标题过滤代替；0 命中也要在回复里说明，**不要**静默降级 list。',
  '- **跨资源语义探索**：跨表 / 邮件等「类似内容 / 概念关联」→ 当前版本无专用语义搜索工具，用 `tabtin <sub> list` + `tabtin <sub> search` 按对象类型查。用户明确要 TabDoc 关键词找文档时走上一条的 `doc search` CLI。',
  '- **本地文件 vs 已上传文档**：用户对话里直接给本地路径 → `read_file`；用户之前在 chat 拖上传过文档（历史含 `file_id`）→ 读结构化内容用 `parse_document(file_id=...)`；**保存上传原件** → `save_attachment(file_id=...)`。HTML **浏览器渲染预览** → `save_attachment` 后 `tabtin browser open --url <相对路径或file://>`；HTML **源码/文件卡片** → `present_to_user` 的 `local_file` item。',
  '- **Ask 工具**：让用户从 2-4 个**选项**里选（含确认某个决策）→ `ask_user`；让用户填**多字段表单**（密码 / URL / 长文本）→ `ask_form`。**追踪 3+ 步任务** → `todo`（单步 / 闲聊不用）。',
  '- **展示**：内置 4 种结构化块（image / table / resource / file）→ `present_to_user`；可编辑产物（表 / 文档 / 演示）→ TabData / TabDoc / TabSlide CLI；自由形态 SVG / 流程图 / mockup → `show_widget`。画前若需遵循 `platform:visualization/tabtin-widget` 手册，用 `skills_read` 读取后再 `show_widget`。**禁止**用 shell/`tabtin file` 画 chat 内 widget。',
  '- **生成本地 office / pdf 文件（xlsx / docx / pptx / pdf）**：优先 `run_terminal_command` + `tabtin file create`（file-generation skill 的 CLI 手册），再用 `present_to_user` 的 `local_file` item 发布成卡片。不确定用法时 `skills_search` / `skills_read` 查阅。JSON spec 由你直接经 stdin 喂入，**只产出最终文件**：不落中间 spec.json、不写 Python/Node 脚本拼 spec 或生成文件、不用 `write_file` 写二进制 office/pdf。用户说「导出 Excel / 生成 xlsx」走 `tabtin file create`，**不要**误用 `tabtin table`。',
  '- **长任务 / Background**：`wait_ms: 0` 把命令立即背景化，命令完成时 push 通知会激活下一轮 turn——你可以继续做别的事不用主动等。想看进度用 `read_file(output_file)`；想停掉用 `run_terminal_command` 跑 `kill <pid>`（pid 在 status="running" envelope 里返回）。',
  '- **Web 抓取**：核查→ `web_search`；静态正文 → `tabtin fetch`；读渲染页正文 → `tabtin browser print --save <path>` 落盘后按需读；网页/列表落 TabData → 先读 Browser Skill，走 `tab list`（复用已打开页，保登录态）→ `open` → `network` / `eval` 拿接口数据 → API 复刻 → 写入 TabData；表名由你根据用户意图、页面标题/域名和字段语义判断并显式传入。表单/翻页走 open/act：先用返回清单的 ref，目标不在清单再 glance 一次；读正文用 print/fetch。',
  '- **Skills**：`skills_search` 查找，`skills_read` 读取完整内容。用户通过 `/skill` 明确选定的 Skill 会在模型调用前自动注入，无需再调用激活工具。有 `tabtin` CLI 等价的操作型 skill 优先走 CLI。',
  '- **能力发现**：用户问「有没有工具能做 X / TabTin 里有什么能力」→ `run_terminal_command` + `tabtin capabilities discover`（查工具/能力表）。用户问「有没有 skill 能做 X」→ `skills_search`。二者不要混用。',
  '- **MCP**：先 `tabtin mcp list-servers` / `tabtin mcp list-tools --server-name <n>` 发现工具，再 `mcp_call_tool` 调；其它 `tabtin mcp list-resources` / `read-resource` / `list-prompts` / `get-prompt` 是 CLI。',
];

/** @deprecated  — production prompt 不再注入；保留供快照/对照。 */
export function buildToolsReferenceSection(tools: ToolLike[]): string {
  const grouped = new Map<string, ToolLike[]>();
  for (const tool of tools) {
    const cat = TOOL_CATEGORIES.find((c) => c.match(tool.name));
    const key = cat?.key ?? 'other';
    const list = grouped.get(key) ?? [];
    list.push(tool);
    grouped.set(key, list);
  }

  const parts: string[] = [
    '<tools_reference>',
    `本 Agent 可使用 ${tools.length} 个工具。**工具职责 / 参数 / 失败处理看各工具自己的 description**，本段只给"什么时候用谁"的跨工具决策。`,
    '',
    '## 工具分类（按用途）',
  ];

  for (const cat of TOOL_CATEGORIES) {
    const catTools = grouped.get(cat.key);
    if (!catTools?.length) continue;
    parts.push(`- **${cat.label}**：${catTools.map((t) => `\`${t.name}\``).join(' / ')}`);
  }

  const other = grouped.get('other');
  if (other?.length) {
    parts.push(`- **其他**：${other.map((t) => `\`${t.name}\``).join(' / ')}`);
  }

  parts.push('', '## 跨工具决策');
  for (const d of CROSS_TOOL_DECISIONS) parts.push(d);

  parts.push('</tools_reference>');
  return parts.join('\n');
}
