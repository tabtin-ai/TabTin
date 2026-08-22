/**
 * Skill 激活器：由 runtime beforeRun hook 调用，不暴露给模型。
 *
 * 角色升级：`skills_read` 返回 tool_result（模型可选择忽略），`skill_invoke`
 * 把 SKILL.md 正文展开为 `user` message 注入对话历史——模型必须遵循（RLHF
 * compliance：user 指令优先级高于 tool 观察）。
 *
 * 依赖注入同 `skills_read`：宿主提供 `getSkill` 回调，runtime 不碰 fs。
 *
 * 返回值利用 Wave 2a 引擎契约：
 * - `newMessages`：skill body 作为 user message
 * - `contextModifier`：frontmatter `allowed-tools` / `model` / `effort`
 */

import type { Message } from '../engine/contracts/conversation.js';
import type { ToolResult, ToolResultContextModifier } from '../engine/contracts/tools.js';
import type {
  SkillLookupResult,
  SkillRecord,
  SkillResolution,
  SkillsToolsCallbackContext,
} from '../tools/skills-tools.js';
import {
  buildSkillAvailabilityError,
  renderSkillResourceManifest,
} from '../tools/skills-tools.js';
import type { SkillResourceEntry } from '../skills/skill-listing-types.js';
import { jsonError } from '../capability/core/_utils.js';
import {
  INTERNAL_ERROR,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  SKILL_DISABLED,
  SKILL_NOT_FOUND,
  SKILL_NOT_INSTALLED,
  SKILL_UNSUPPORTED_PREFIX,
} from '../engine/errors/error-kinds.js';

// ─── 依赖注入接口 ───────────────────────────────────────────────────

export interface SkillInvokeDeps {
  getSkill: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => SkillLookupResult;
  /**
   * 可选：云端 / DB 是否已启用该 skill（本地 registry 可能尚无 SKILL.md）。
   *
   * ：宿主注入后，getSkill 落空但 isSkillEnabled 为 true 时给出
   * 「已启用但未安装到本地」的可诊断错误，而非笼统的 skill_not_found。
   */
  isSkillEnabled?: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => boolean;
  /**
   * 可选：本地 registry 是否存在该 skill（不做启用过滤）。
   *
   * ：getSkill 因 Agent 未启用而落空时，用本回调区分
   * 「技能存在但当前 Agent 未启用」与「根本找不到」。
   */
  skillExists?: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => boolean;
  /**
   * H19 Wave 2g：frontmatter `model: xxx` 的宿主侧校验回调。
   *
   * - 返回 `true` / `undefined` → runtime 透传 modelOverride；
   * - 返回 `false` → runtime **忽略** modelOverride，并在 tool_result
   *   content 里附一个告知句子（`Model '<name>' not available, using default.`），
   *   这样模型能看到是什么原因降级、不会再困惑于 `modelOverride.model not found`。
   *
   * 宿主不注入时维持历史行为（任何模型名都直接透传，错了才在 LLM 层 4xx）。
   * Electron / Daemon 如何拿到合法模型清单由宿主自行决定——通常走
   * 用户 organization 的 model catalog IPC。
   */
  validateModel?: (modelId: string) => boolean;
  /**
   * 可选：列出被 invoke 的 skill 的 Tier-3 附属资源（references/ + examples/）。
   *
   * 注入后，注入给 Agent 的 skill 正文末尾会附上一段「附属参考文件」清单，告知
   * Agent 执行过程中可用 `skills_read` 传 `path` 按需读取分层文档。宿主不注入时
   * 维持旧行为（只注入 SKILL.md 正文）。
   */
  listSkillResources?: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<SkillResourceEntry[]> | SkillResourceEntry[];
  /**
   * ** RB1**：host 在装配 ToolProvider 时烘进的 per-runtime 业务身份。
   * `skill_invoke` 用这里的烘焙值构造回调上下文，不再从运行时 `ToolContext` 读。
   */
  spaceId?: string;
  organizationId?: string;
}

// ─── 常量 ──────────────────────────────────────────────────────────────

/** F3 token 截断：skill body 超此字符数则截断 + 尾部提示。 */
const MAX_SKILL_CONTENT_CHARS = 30_000;

const TRUNCATION_NOTICE =
  '\n\n[注意：技能内容已截断（超过 30,000 字符）。以上为核心指令，请据此执行。]';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** `ext:` / `tin:` 前缀统一错误文案。 */
const UNSUPPORTED_PREFIX_MESSAGE =
  '此技能仅在在线模式下可用。请切换到在线 Agent 后重试。';

const CANONICAL_KEY_PATTERN =
  /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?:[a-z0-9-][a-z0-9-\\/]*$/i;

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const RETIRED_ALLOWED_TOOL_NAMES = new Set([
  'bash',
  'web_fetch',
  'file_read',
  'file_edit',
  'file_write',
  'file_delete',
  'execute_command',
  'code_grep',
  'code_glob',
  'code_semantic_search',
  'read_diagnostics',
  'document_read',
  'system_relaunch_app',
  'system_clear_os_error_blacklist',
  'plan_exit',
  'skills.search',
]);

// ─── 输入 schema ───────────────────────────────────────────────────────

// 阶段 6.6 议题 3 翻译：保留 canonical key / $ARGUMENTS / <skills> 标识，
// 自然语言翻译成中文。
// ─── Frontmatter 轻量提取 ─────────────────────────────────────────────

interface SkillMeta {
  body: string;
  allowedTools?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /**
   * Wave 1.5 P0-1 补丁：SKILL.md frontmatter 里的 primary_env 字段。
   *
   * 三种写法等价（YAML 用户习惯不一）：
   *   primary_env: OPENAI_API_KEY   (snake_case，后端/Python 习惯)
   *   primaryEnv:  OPENAI_API_KEY   (camelCase，JS/TS 习惯)
   *   primary-env: OPENAI_API_KEY   (kebab-case，allowed-tools 同风格)
   *
   * 语义：指定 Skill 所需的**主要环境变量名**。当 service_name **不在**
   * SKILL_CREDENTIAL_ENV_MAP 硬编码表里（如 deepseek / gemini / moonshot /
   * 用户自建 LLM）时，后端的 `_derive_generic` 需要用这个 hint 作为 env key
   * 名把 encrypted_data.api_key 派生成 `{<primary_env>: <key>}`。
   *
   * 缺省情况下为 undefined；运行时调用方（skill_invoke 工具）写入
   * `contextModifier.activeSkill.primaryEnv`，由 query.ts 落到 state，下一轮
   * 构造 ToolContext.skillContext.primaryEnv，最终 run_terminal_command 工具通过 resolver
   * 带着它请求后端 skill-reveal 端点。
   */
  primaryEnv?: string;
}

/**
 * 从 SKILL.md 全文中提取 frontmatter 元字段 + 纯 markdown body。
 *
 * 不依赖 js-yaml（agent-runtime 是 pure TS 库），用简单行级匹配提取
 * `allowed-tools` / `model` / `effort` 三个字段。对于 `allowed-tools`
 * 支持三种写法：
 *
 *   inline 空格/逗号分隔：
 *     `allowed-tools: run_terminal_command read_file`
 *     `allowed-tools: run_terminal_command, read_file`
 *
 *   inline YAML 数组：
 *     `allowed-tools: [run_terminal_command, read_file]`
 *
 *   多行 YAML 数组（H23 Wave 2g 补齐）：
 *     ```yaml
 *     allowed-tools:
 *       - run_terminal_command
 *       - read_file
 *     ```
 *
 * 多行识别规则：当 `allowed-tools:` 之后只有冒号（value 为空），进入多行
 * 模式；后续以 `- ` 开头的行视为数组项，直到遇到第一个非缩进、非列表项
 * 的行（通常是下一个 key 或 frontmatter 结束）。缩进不严格要求（YAML
 * 在顶层序列里允许任意缩进），但列表项必须以 `-` 起头。
 */
function extractSkillMeta(content: string): SkillMeta {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { body: content };

  const yamlBlock = match[1];
  const body = content.slice(match[0].length);

  let allowedTools: string[] | undefined;
  let model: string | undefined;
  let effort: 'low' | 'medium' | 'high' | undefined;
  let primaryEnv: string | undefined;

  const lines = yamlBlock.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('allowed-tools:')) {
      const value = trimmed.slice('allowed-tools:'.length).trim();
      const parsed = parseAllowedToolsFrontmatter(lines, i, value);
      if (parsed.tools) allowedTools = parsed.tools;
      i = parsed.nextIndex;
    } else if (trimmed.startsWith('model:')) {
      model = stripInlineDecor(trimmed.slice('model:'.length)) || undefined;
    } else if (trimmed.startsWith('effort:')) {
      const val = stripInlineDecor(trimmed.slice('effort:'.length));
      if (VALID_EFFORTS.has(val)) {
        effort = val as 'low' | 'medium' | 'high';
      }
    } else {
      // P0-1 补丁（Wave 1.5 质疑 4）：三种等价写法 + 大小写兼容识别。
      //
      // 为什么统一用 PRIMARY_ENV_KEYS + find：
      //   - 避免三元嵌套 `keyLen` 的代码气味（技术优雅度 Review #1）；
      //   - 大小写归一化用 `trimmed.toLowerCase()` 一次搞定，兼容 Skill
      //     作者从外部 README 复制时的 `Primary_env:` /
      //     `PRIMARY_ENV:` 等偏差（产品 Review D）。
      //
      // 为什么 `unquoted && !primaryEnv` 的语义是"取第一个出现的"：
      //   - js-yaml 对重复 key 会**拒绝**解析（抛 YAMLException）；
      //   - 本手写 parser 比 js-yaml 宽容，取第一个而非静默覆盖，避免
      //     "用户同时写两种写法" 时下一次 key 悄悄覆盖上一次。
      //   - 若之前已经设置过 primaryEnv，此处跳过时打一条 warn 日志，
      //     让 Skill 作者知道 "你写了多种写法，我只认第一次"（技术优雅
      //     Review #8——让 lenient 行为变**显性化**）。
      primaryEnv = readPrimaryEnvDeclaration(trimmed, primaryEnv);
    }
  }

  return { body, allowedTools: filterCanonicalAllowedTools(allowedTools), model, effort, primaryEnv };
}

/** 三种等价写法（全部 lowercase 做匹配）。顺序无关，只要命中任一即可。 */
const PRIMARY_ENV_KEYS = ['primary_env:', 'primaryenv:', 'primary-env:'] as const;
const LIST_ITEM_RE = /^-(?:\s+(.*)|\s*$)/;

function parseAllowedToolsFrontmatter(
  lines: string[],
  index: number,
  value: string,
): { tools?: string[]; nextIndex: number } {
  if (value.startsWith('[') && value.endsWith(']')) {
    return {
      tools: value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      nextIndex: index,
    };
  }
  if (value) {
    return { tools: value.split(/[\s,]+/).filter(Boolean), nextIndex: index };
  }

  const parsed = collectAllowedToolsList(lines, index + 1);
  return {
    tools: parsed.tools.length > 0 ? parsed.tools : undefined,
    nextIndex: parsed.tools.length > 0 ? parsed.nextIndex - 1 : index,
  };
}

function collectAllowedToolsList(lines: string[], startIndex: number): { tools: string[]; nextIndex: number } {
  // 多行 YAML 数组：扫描后续以 `- ` 开头的行。
  //
  // 严格化规则（Wave 2g review 后收紧）：
  //   - 只认 `- ` 或 `-<EOL>` 为列表项起始（避免把 `---`、`-5`
  //     这类 YAML 分隔符 / 负数节点当成 list item）；
  //   - 遇到 `#` 开头的注释行**跳过**（YAML 标准支持）；
  //   - 遇到空行跳过（YAML 允许数组里有空白分隔）；
  //   - 遇到其他非 `- ` 起头的非空非注释行即结束扫描；
  //   - 支持 `- "run_terminal_command"` / `- 'run_terminal_command'` 单双引号剥离；
  //   - 只收集纯标量字符串——嵌套对象（`- name: run_terminal_command`）不支持。
  const tools: string[] = [];
  let nextIndex = startIndex;
  while (nextIndex < lines.length) {
    const item = parseAllowedToolsListItem(lines[nextIndex].trim());
    if (item === 'skip') {
      nextIndex++;
      continue;
    }
    if (item == null) break;
    tools.push(item);
    nextIndex++;
  }
  return { tools, nextIndex };
}

function parseAllowedToolsListItem(trimmed: string): string | 'skip' | null {
  if (trimmed === '' || trimmed.startsWith('#')) return 'skip';
  const match = LIST_ITEM_RE.exec(trimmed);
  if (!match) return null;
  const rawItem = (match[1] ?? '').trim();
  if (!rawItem) return 'skip';
  const unquoted = rawItem.replace(/^['"](.+)['"]$/, '$1');
  // 嵌套对象（如 `- name: run_terminal_command`）这种复杂 YAML 不支持，直接忽略
  // 该项（不 break，避免整块数据丢失）。
  return unquoted.includes(':') ? 'skip' : unquoted;
}

function readPrimaryEnvDeclaration(trimmed: string, current: string | undefined): string | undefined {
  const lowerTrim = trimmed.toLowerCase();
  const hit = PRIMARY_ENV_KEYS.find((k) => lowerTrim.startsWith(k));
  if (!hit) return current;
  const rawValue = stripInlineDecor(trimmed.slice(hit.length));
  if (!rawValue) return current;
  if (!current) return rawValue;
  if (current !== rawValue) {
    // 静默覆盖会让后续调试极难定位。打到 console.warn 而非 throw，
    // 保持 Skill 加载容错（坏 frontmatter 不炸整个 Skill）。
    console.warn(
      `[skill-invoke] frontmatter 多次声明 primary_env（首次="${current}", 本次="${rawValue}"），` +
      `以首次出现为准。建议只保留一种写法。`,
    );
  }
  return current;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPersonalPluginRuntimeInstruction(skill: SkillRecord, key: string): string | null {
  if (!skill.personalPluginId || !skill.personalPluginRuntime) return null;

  const displayTitle = skill.personalPluginRuntime.title ?? skill.personalPluginDisplayName ?? skill.name;
  const args = ['tabtin', 'plugin', 'launch', skill.personalPluginId];
  if (skill.personalPluginRuntime.serviceId) {
    args.push('--service-id', skill.personalPluginRuntime.serviceId);
  }
  if (displayTitle) {
    args.push('--title', displayTitle);
  }
  if (skill.personalPluginRuntime.requireMcp === true) {
    args.push('--require-mcp');
  }
  args.push('--open-browser');
  const command = args.map(shellQuote).join(' ');
  return [
    `请启动 Personal Plugin skill \`${key}\` 对应的本地 runtime。`,
    '',
    '必须直接调用 `run_terminal_command` 执行下面的 TabTin CLI 命令：',
    '',
    '```bash',
    command,
    '```',
    '',
    '不要搜索文件系统，不要从当前 workspace 或用户 home 目录查找插件脚本。',
    '插件安装目录、local service cwd、项目目录、MCP attach 和浏览器打开都由 TabTin CLI 转交宿主授权流程，并根据 Personal Plugin registry 自动处理。',
    `CLI 返回 running 后，用简短中文告诉用户 ${displayTitle} 已打开；如果 CLI 报错，再复述错误和下一步。`,
  ].join('\n');
}

/**
 * 统一处理 frontmatter 标量值："剥行尾 YAML 注释 + trim + 剥首尾成对引号"。
 *
 * 为什么 `model:` / `effort:` / `primary_env:` 都用同一个辅助函数：
 * 技术优雅度 Review 发现 `model: gpt-4o # preferred` 会被历史实现当作
 * modelId 一起透传给 LLM 层 4xx；统一行内注释策略（都剥）后，三处都能
 * 容忍 YAML 标准的 `# comment`，无漂移。
 *
 * 不处理 block scalars（`|` / `>`）——这些在 frontmatter 的单行语义里
 * 不出场；遇到会按字面值透传，用户自己负责。
 */
function stripInlineDecor(raw: string): string {
  const noComment = raw.replace(/\s+#.*$/, '');
  const trimmed = noComment.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, '$2').trim();
}

function filterCanonicalAllowedTools(tools: string[] | undefined): string[] | undefined {
  if (!tools?.length) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTool of tools) {
    const tool = stripInlineDecor(rawTool);
    if (!tool) continue;
    if (!TOOL_NAME_PATTERN.test(tool)) continue;
    if (RETIRED_ALLOWED_TOOL_NAMES.has(tool)) continue;
    if (seen.has(tool)) continue;
    seen.add(tool);
    result.push(tool);
  }
  return result.length > 0 ? result : undefined;
}

// ─── 辅助 ──────────────────────────────────────────────────────────────

function hasUnsupportedPrefix(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('ext:') || lower.startsWith('tin:');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface ParsedSkillInvokeInput {
  key: string;
  args?: string;
  agentRunId?: string;
}

function parseSkillInvokeInput(input: unknown): ParsedSkillInvokeInput | ToolResult {
  const raw = (input ?? {}) as { skill?: unknown; args?: unknown; agentRunId?: unknown };
  const key = typeof raw.skill === 'string' ? raw.skill.trim() : '';
  const args = typeof raw.args === 'string' ? raw.args : undefined;
  const agentRunId = typeof raw.agentRunId === 'string' ? raw.agentRunId.trim() : undefined;

  if (!key) {
    return jsonError(
      '缺少参数 skill。请传入 <skills> 段展示的完整 canonical key，例如 "user:code-style-check"。',
      {
        error_kind: MISSING_REQUIRED_PARAM,
        field: 'skill',
        hint: 'Pass the exact canonical skill key from the <skills> list, or run skills_search to find one first.',
      },
    );
  }

  if (hasUnsupportedPrefix(key)) {
    return jsonError(UNSUPPORTED_PREFIX_MESSAGE, {
      error_kind: SKILL_UNSUPPORTED_PREFIX,
      key,
      hint: 'Use a local user: or app: skill key. For external or online-only skills, ask the user to switch to an online agent.',
    });
  }

  if (!CANONICAL_KEY_PATTERN.test(key)) {
    return jsonError(
      `技能 key 格式不合法："${key}"。请使用 <skills> 段展示的完整 canonical key，` +
        `例如 "user:code-style-check" 或 "app:tabcode/code-review"。`,
      {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'skill',
        value: key,
        hint: 'Use a canonical skill key in the form user:<slug> or app:<app>/<slug>.',
      },
    );
  }

  return { key, args, agentRunId };
}

function resolveSkillForInvoke(
  deps: SkillInvokeDeps,
  key: string,
  cbCtx: SkillsToolsCallbackContext,
): { ok: true; skill: SkillRecord } | { ok: false; result: ToolResult } {
  let lookup: SkillLookupResult;
  try {
    lookup = deps.getSkill(key, cbCtx);
  } catch {
    return {
      ok: false,
      result: jsonError(
        `查找技能 "${key}" 时发生内部错误。`,
        {
          error_kind: INTERNAL_ERROR,
          key,
          hint: 'Stop invoking this skill in the current run and ask the user to try again after the skill registry is available.',
        },
      ),
    };
  }

  if (lookup && 'status' in lookup) {
    const resolution = lookup as SkillResolution;
    if (resolution.status === 'available') {
      return { ok: true, skill: resolution.skill };
    }
    return {
      ok: false,
      result: buildSkillAvailabilityError(key, resolution, 'invoke'),
    };
  }
  if (lookup) return { ok: true, skill: lookup };
  if (deps.isSkillEnabled?.(key, cbCtx) === true) {
    return {
      ok: false,
      result: jsonError(
        `技能 \`${key}\` 已在当前 Agent 启用，但本机尚未安装 SKILL.md。` +
          '请让 Skill 作者先发布该 Skill 版本，或在 Skill 面板重新安装后再试。',
        {
          error_kind: SKILL_NOT_INSTALLED,
          reason: 'enabled_but_not_installed_locally',
          key,
          hint:
            'The skill is enabled in cloud/DB but missing from the local registry. ' +
            'Ask the owner to publish a version, or reinstall from the Skills panel.',
        },
      ),
    };
  }
  if (deps.skillExists?.(key, cbCtx) === true) {
    return {
      ok: false,
      result: jsonError(
        `技能 \`${key}\` 存在，但当前 Agent 未启用。` +
          '请在 Agent 技能设置中添加并开启该技能后再试。',
        {
          error_kind: SKILL_DISABLED,
          reason: 'not_enabled_for_agent',
          key,
          hint:
            'The skill exists locally but is not in the current Agent carry/enable set. ' +
            'Ask the user to attach and enable it in Agent skill settings.',
        },
      ),
    };
  }
  return {
    ok: false,
    result: jsonError(
      `未找到技能 \`${key}\`。可能已被删除或未安装。可以用 skills_search 搜索相关技能。`,
      {
        error_kind: SKILL_NOT_FOUND,
        reason: 'not_found',
        key,
        hint: 'Run skills_search with keywords from the user request, then invoke one of the returned canonical skill keys.',
      },
    ),
  };
}

async function appendSkillResourcesManifest(args: {
  body: string;
  deps: SkillInvokeDeps;
  key: string;
  cbCtx: SkillsToolsCallbackContext;
  personalPluginRuntimeInstruction: string | null;
}): Promise<string> {
  const { body, deps, key, cbCtx, personalPluginRuntimeInstruction } = args;
  if (personalPluginRuntimeInstruction || !deps.listSkillResources) return body;
  try {
    const resources = await deps.listSkillResources(key, cbCtx);
    const manifest = renderSkillResourceManifest(key, resources);
    return manifest ? `${body}${manifest}` : body;
  } catch {
    // 附属清单是增强项，失败不影响主指令注入
    return body;
  }
}

function buildSkillInvokeContextModifier(
  meta: SkillMeta,
  skill: SkillRecord,
  key: string,
  deps: SkillInvokeDeps,
): {
  contextModifier: ToolResultContextModifier;
  modelOverrideRejectedNotice?: string;
} {
  const contextModifier: ToolResultContextModifier = {
    activeSkill: {
      skillKey: key,
      primaryEnv: meta.primaryEnv ?? skill.primaryEnv,
    },
  };
  let modelOverrideRejectedNotice: string | undefined;
  if (meta.allowedTools?.length) {
    contextModifier.allowedTools = meta.allowedTools;
  }
  if (meta.model) {
    const isValid = deps.validateModel?.(meta.model) ?? true;
    if (isValid) {
      contextModifier.modelOverride = meta.model;
    } else {
      // 中文文案：让 LLM（以及把 tool_result content 展示给用户的 UI）
      // 能直接理解回退原因 + 怎么修。TabTin 面向中文用户，英文系统
      // 提示容易让 LLM 切换到英文回复。
      modelOverrideRejectedNotice =
        `Skill 指定的模型 "${meta.model}" 不在当前可用模型列表中，` +
        `已改用当前会话默认模型继续执行。如需改用该模型，请检查 SKILL.md 的 ` +
        `frontmatter \`model:\` 字段拼写，或联系 organization 管理员开通权限。`;
    }
  }
  if (meta.effort) {
    contextModifier.effortOverride = meta.effort;
  }
  return { contextModifier, modelOverrideRejectedNotice };
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createSkillActivation(
  deps: SkillInvokeDeps,
): (input: unknown) => Promise<ToolResult> {
  return async (input: unknown): Promise<ToolResult> => {
      const parsedInput = parseSkillInvokeInput(input);
      if ('content' in parsedInput) return parsedInput;
      const { key, args, agentRunId } = parsedInput;

      // ── 查找 skill ──

      const cbCtx: SkillsToolsCallbackContext = {
        spaceId: deps.spaceId,
        organizationId: deps.organizationId,
        agentRunId,
      };

      const resolvedSkill = resolveSkillForInvoke(deps, key, cbCtx);
      if (!resolvedSkill.ok) return resolvedSkill.result;
      const skill = resolvedSkill.skill;

      // ── 解析 frontmatter + 提取 body ──

      const meta = extractSkillMeta(skill.content);
      let { body } = meta;
      const personalPluginRuntimeInstruction = buildPersonalPluginRuntimeInstruction(
        skill,
        key,
      );
      if (personalPluginRuntimeInstruction) {
        body = personalPluginRuntimeInstruction;
      }

      // $ARGUMENTS 参数替换
      if (args && !personalPluginRuntimeInstruction) {
        body = body.replace(/\$ARGUMENTS/g, args);
      }

      // F3: token 截断
      if (body.length > MAX_SKILL_CONTENT_CHARS) {
        body = body.slice(0, MAX_SKILL_CONTENT_CHARS) + TRUNCATION_NOTICE;
      }

      // Tier-3：附上 references / examples 清单（普通 skill 才附；Personal Plugin
      // runtime 指令是自包含启动脚本，不涉及分层文档）。让 Agent 执行时知道可用
      // `skills_read` 传 `path` 按需读取分层文档。
      body = await appendSkillResourcesManifest({
        body,
        deps,
        key,
        cbCtx,
        personalPluginRuntimeInstruction,
      });

      // ── 构造 contextModifier ──

      // Wave 1.5: 标记当前 Skill 为 active，下一轮 `ToolContext.skillContext`
      // 即可读到，`run_terminal_command` 工具据此决定是否注入 Skill 绑定的密钥 env。
      //
      // 为什么写进 contextModifier 而不是返回值 content？
      //   - content 走 LLM，把 skillKey 让模型看见虽然不是密钥但也无必要；
      //   - contextModifier 是 runtime 契约通道，`query.ts` 统一写入 state
      //     后由下一轮构造 ToolContext 消费，不污染对话历史。
      //
      // **P0-1 补丁（Wave 1.5 质疑 4）**：primaryEnv 取值优先级：
      //   1. `meta.primaryEnv` — 由 `extractSkillMeta` 直接从 SKILL.md
      //      frontmatter 解析（支持 primary_env / primaryEnv / primary-env
      //      三种写法，YAML 用户习惯不一）；
      //   2. `skill.primaryEnv` — 宿主（LocalSkillRegistry）在 `getSkill`
      //      时填充的结构化字段（同一 SKILL.md，parseSkillDoc 归一化过的）。
      //      纯兜底：当宿主把 `content` 做了裁剪/编码（如 Daemon HTTP 传
      //      大 SKILL.md 时省略 frontmatter 节流）时，runtime 也能从顶级
      //      字段读到 primaryEnv。
      //
      // **原实现依赖不存在的 `skill.meta` 字段**（三视角 Review 技术 #4）,
      // LocalSkill / SkillRecord 接口均无 meta、宿主也从未 populate →
      // primaryEnv 恒为 undefined → 非映射表服务（deepseek/gemini/moonshot）
      // 永远跑不通。本补丁让 "从 content frontmatter 解析"成为主路径，
      // "skill.primaryEnv 结构化字段"成为二级兜底，不再有幽灵 `meta` 字段。
      // H19 Wave 2g：宿主注入 validateModel 时对 modelOverride 做预检。
      //
      // 为什么这里判：skill frontmatter 写错 `model:` 的场景下，原本是走
      // 到 LLM 层才 4xx 用户一脸懵（"为什么 skill_invoke 直接失败？"），
      // 现在降级为"静默忽略 override + 在 tool_result content 里附提示"，
      // 让模型感知并继续用当前模型执行 skill——降级不如成功但比崩强。
      //
      // validateModel 未注入时维持透传——兼容 Daemon / 旧宿主。
      const {
        contextModifier,
        modelOverrideRejectedNotice,
      } = buildSkillInvokeContextModifier(meta, skill, key, deps);

      // ── 构造 newMessages（user role，RLHF 角色升级） ──

      const wrapperAttrs = [
        `key="${escapeAttr(key)}"`,
      ].filter((part): part is string => !!part);
      const wrappedBody = `<skill_instructions ${wrapperAttrs.join(' ')}>\n${body}\n</skill_instructions>`;

      const newMessages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: wrappedBody,
            },
          ],
        },
      ];

      // ── 构造返回值 ──

      const baseContent = `正在执行技能：${skill.name}（${key}）`;
      const content = modelOverrideRejectedNotice
        ? `${baseContent}\n${modelOverrideRejectedNotice}`
        : baseContent;

      const result: ToolResult = {
        content,
        newMessages,
        contextModifier,
      };

      return result;
  };
}
