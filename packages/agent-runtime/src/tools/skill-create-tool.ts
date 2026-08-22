/**
 * `skill_create` FC 工具 — Wave 2b
 *
 * 解决 L29（shell 写长文本 heredoc/echo 转义地狱）：Agent 通过结构化参数
 * 生成 SKILL.md，runtime 调宿主回调写文件。
 *
 * 依赖注入：宿主提供 `writeSkill(slug, content, ctx)` 回调，负责写到
 * 当前 Agent 可写的本地 skills 目录，返回写入的文件路径。
 */

import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import type { SkillsToolsCallbackContext } from './skills-tools.js';
import { jsonError } from '../capability/core/_utils.js';
import {
  INTERNAL_ERROR,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  PARAM_TOO_LARGE,
  RUNTIME_MISCONFIG,
  UPSTREAM_ERROR,
} from '../engine/errors/error-kinds.js';
import {
  toJsonErrorMetadata,
  translateBackendError,
  type TranslatedBackendError,
} from './_backend-error-translator.js';

// ─── 依赖注入接口 ───────────────────────────────────────────────────

export interface SkillCreateDeps {
  writeSkill: (
    slug: string,
    content: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<string>;

  /**
   *  / ：云端注册契约是 organization_id + agent_id，不再传 space_id。
   * 宿主须透传真实 HTTP status / body，供错误分类使用。
   */
  registerSkill?: (params: {
    organizationId: string;
    agentId?: string;
    name: string;
    description: string;
    slug: string;
    emoji?: string;
  }) => Promise<{
    skill_id?: string;
    slug?: string;
    error?: string;
    status?: number;
    body?: unknown;
  }>;

  /**
   * ** RB1**：host 在装配 ToolProvider 时烘进的 per-runtime 业务身份。
   * `skill_create` 用这里的烘焙值决定注册门槛 + 写文件回调上下文，不再从运行时
   * `ToolContext` 读业务 id。
   */
  spaceId?: string;
  organizationId?: string;
  agentId?: string;
}

// ─── 常量 ──────────────────────────────────────────────────────────────

/** slug 格式：kebab-case，与 skill-doc-parser.ts KEBAB_CASE 一致。 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;
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

// 阶段 6.6 议题 3 翻译：保留 snake_case / kebab-case 标识符与 SKILL.md 等专有名。
const createInputSchema = {
  type: 'object',
  properties: {
    slug: {
      type: 'string',
      description:
        '横杠形式的 skill 目录名（譬如 `code-review` / `daily-report`）；会成为规范 key 的后缀 `user:<slug>`。',
    },
    name: {
      type: 'string',
      description:
        '人类可读的 skill 名称（譬如"代码审查"），在 skill 面板和 Agent 对话里显示。',
    },
    description: {
      type: 'string',
      description:
        'skill 列表里的一句话描述（最多 1024 字符）。',
    },
    when_to_use: {
      type: 'string',
      description:
        '什么时候应该触发这个 skill（帮 Agent 决定何时调用）。',
    },
    content: {
      type: 'string',
      description:
        '完整 `SKILL.md` 正文（markdown 指令）。**不要**包含 YAML 头——会从其他参数自动生成。',
    },
    allowed_tools: {
      type: 'array',
      items: { type: 'string' },
      description:
        '可选：本 skill 允许使用的规范工具名列表（譬如 `["run_terminal_command", "read_file"]`）。',
    },
  },
  required: ['slug', 'name', 'description', 'content'],
  additionalProperties: false,
} as unknown as Tool['inputSchema'];

// ─── 辅助 ──────────────────────────────────────────────────────────────

function buildFrontmatter(params: {
  slug: string;
  name: string;
  description: string;
  when_to_use?: string;
  allowed_tools?: string[];
}): string {
  const lines: string[] = ['---'];
  lines.push(`slug: ${params.slug}`);
  lines.push(`name: ${yamlSafeString(params.name)}`);
  lines.push(`description: ${yamlSafeString(params.description)}`);
  if (params.when_to_use) {
    lines.push(`when_to_use: ${yamlSafeString(params.when_to_use)}`);
  }
  if (params.allowed_tools?.length) {
    lines.push(`allowed-tools: ${params.allowed_tools.join(' ')}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * YAML 安全字符串：如果包含特殊字符（冒号、引号、换行等），用双引号包裹。
 * 否则原样输出（kebab-case slug 等简单值不需要引号）。
 */
function yamlSafeString(value: string): string {
  if (/[:\n\r"'#{}[\],&*?|>!%@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function validateAllowedTools(tools: string[] | undefined): ToolResult | null {
  if (!tools?.length) return null;

  const retired = tools.filter((tool) => RETIRED_ALLOWED_TOOL_NAMES.has(tool));
  if (retired.length > 0) {
    return jsonError(
      `allowed_tools 包含已退役工具名：${retired.join(', ')}。请改用 canonical 工具名，例如 run_terminal_command、read_file、write_file、delete_file。`,
      {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'allowed_tools',
        retired,
        hint: 'Replace retired tool names with canonical tool names such as run_terminal_command, read_file, write_file, or delete_file.',
      },
    );
  }

  const invalid = tools.filter((tool) => !TOOL_NAME_PATTERN.test(tool));
  if (invalid.length > 0) {
    return jsonError(
      `allowed_tools 包含非法工具名：${invalid.join(', ')}。工具名必须匹配 ^[a-zA-Z0-9_-]{1,64}$。`,
      {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'allowed_tools',
        invalid,
        hint: 'Use only canonical tool names containing letters, numbers, underscores, or hyphens, with at most 64 characters.',
      },
    );
  }

  return null;
}

interface NormalizedSkillCreateInput {
  slug: string;
  name: string;
  description: string;
  content: string;
  whenToUse?: string;
  allowedTools?: string[];
}

function normalizeSkillCreateInput(input: unknown): NormalizedSkillCreateInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    slug: typeof raw.slug === 'string' ? raw.slug.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    whenToUse: typeof raw.when_to_use === 'string' ? raw.when_to_use.trim() : undefined,
    allowedTools: Array.isArray(raw.allowed_tools)
      ? (raw.allowed_tools as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined,
  };
}

function validateSkillCreateInput(params: NormalizedSkillCreateInput): ToolResult | null {
  if (!params.slug) {
    return jsonError(
      '缺少参数 slug。请提供 kebab-case 格式的目录名，例如 "code-review"。',
      {
        error_kind: MISSING_REQUIRED_PARAM,
        field: 'slug',
        hint: 'Provide a kebab-case slug such as "code-review" before calling skill_create.',
      },
    );
  }
  if (!SLUG_PATTERN.test(params.slug)) {
    return jsonError(
      `slug "${params.slug}" 格式不合法。必须是 kebab-case（小写字母、数字、连字符），` +
        '例如 "code-review"、"daily-report"。',
      {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'slug',
        value: params.slug,
        hint: 'Rewrite slug in kebab-case using lowercase letters, numbers, and single hyphens only.',
      },
    );
  }
  if (params.slug.length > MAX_SLUG_LENGTH) {
    return jsonError(`slug 超过 ${MAX_SLUG_LENGTH} 字符限制。`, {
      error_kind: PARAM_TOO_LARGE,
      field: 'slug',
      length: params.slug.length,
      limit: MAX_SLUG_LENGTH,
      hint: `Shorten slug to ${MAX_SLUG_LENGTH} characters or fewer while keeping it kebab-case.`,
    });
  }
  return validateRequiredSkillCreateText(params) ?? validateAllowedTools(params.allowedTools);
}

function validateRequiredSkillCreateText(params: NormalizedSkillCreateInput): ToolResult | null {
  if (!params.name) {
    return jsonError('缺少参数 name。请提供人类可读的技能名称。', {
      error_kind: MISSING_REQUIRED_PARAM,
      field: 'name',
      hint: 'Provide a short human-readable skill name before calling skill_create.',
    });
  }
  if (!params.description) {
    return jsonError('缺少参数 description。请提供一行技能描述。', {
      error_kind: MISSING_REQUIRED_PARAM,
      field: 'description',
      hint: 'Provide a one-line description that explains when this skill should be used.',
    });
  }
  if (!params.content) {
    return jsonError('缺少参数 content。请提供技能的 markdown 指令正文。', {
      error_kind: MISSING_REQUIRED_PARAM,
      field: 'content',
      hint: 'Provide the SKILL.md instruction body without YAML frontmatter.',
    });
  }
  return null;
}

/** ：注册失败不得伪装成 FC「参数格式不对」，否则 Agent 会改 content 死循环。 */
const SKILL_REGISTRATION_HINT =
  'Backend skill registration failed. Do not retry skill_create by rewriting content or description; fix Organization/Agent context or ask the user for help.';

function translateSkillRegistrationFailure(input: {
  status?: number;
  body?: unknown;
  error?: unknown;
}): TranslatedBackendError {
  const translated = translateBackendError({
    status: input.status,
    body: input.body,
    error: input.error,
    toolName: 'skill_create',
    operation: 'skill registration',
    fallbackMessage: 'The skill could not be registered.',
  });
  // 通用 4xx→invalid_param_format 会误导 Agent 检查 FC schema；注册失败统一抬到 upstream。
  if (translated.error_kind === INVALID_PARAM_FORMAT) {
    return {
      ...translated,
      error_kind: UPSTREAM_ERROR,
      message: 'The skill could not be registered with the server.',
      hint: SKILL_REGISTRATION_HINT,
    };
  }
  return {
    ...translated,
    hint: SKILL_REGISTRATION_HINT,
  };
}

async function registerSkillIfAvailable(
  deps: SkillCreateDeps,
  params: NormalizedSkillCreateInput,
): Promise<{ ok: true; effectiveSlug: string; skillId?: string } | { ok: false; result: ToolResult }> {
  if (!deps.registerSkill) return { ok: true, effectiveSlug: params.slug };
  if (!deps.organizationId) {
    return {
      ok: false,
      result: jsonError('缺少 Organization 上下文，无法注册 Skill。', {
        error_kind: RUNTIME_MISCONFIG,
        slug: params.slug,
        hint: SKILL_REGISTRATION_HINT,
      }),
    };
  }
  try {
    const reg = await deps.registerSkill({
      organizationId: deps.organizationId,
      agentId: deps.agentId,
      name: params.name,
      description: params.description,
      slug: params.slug,
    });
    if (reg.error) {
      const translated = translateSkillRegistrationFailure({
        status: reg.status,
        body: reg.body ?? { error: reg.error },
      });
      return {
        ok: false,
        result: jsonError(translated.message, toJsonErrorMetadata(translated, { slug: params.slug })),
      };
    }
    return {
      ok: true,
      effectiveSlug: reg.slug ?? params.slug,
      skillId: reg.skill_id,
    };
  } catch (err) {
    const translated = translateSkillRegistrationFailure({ error: err });
    return {
      ok: false,
      result: jsonError(translated.message, toJsonErrorMetadata(translated, { slug: params.slug })),
    };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createSkillCreateTool(deps: SkillCreateDeps): Tool {
  return {
    name: 'skill_create',
    // 阶段 6.7 议题 1 治理（2026-05-21）：原 <skills_usage> 段（3110 字）已删，
    // 完整创建流程 + Agent/PMO mode + Workspace 上下文约束 + kebab-case 提取规则
    // 全部从段吸收到本工具说明书。tier 从 low-risk 升 medium，budget 500→1200。
    // ：技能携带集 / 启停归属当前 Agent，不再用「Space 的 skill 库」叙事。
    description:
      '在**当前 Agent 可写的本地 skill 目录**里创建一个新 skill。工具自己处理 `YAML frontmatter` + 文件写入，避开 shell heredoc 转义问题。写入后归属当前 Agent 的技能携带集，**从下一条消息开始可用**。\n\n' +
      '**什么时候用**：用户说"把这个保存成 skill" / "做成一个 skill" / "记下这个流程让以后能复用"等。\n\n' +
      '**创建流程**：\n' +
      '1. **先搜索去重**：`skills_search(意图关键词)`。已有相似 skill 时问用户要**更新**还是**新建**——不默认新建。\n' +
      '2. **提取 kebab-case `slug`**：`[a-z0-9-]` ≤64 字符。用户用中文表达意图时从意图提炼出英文 slug（"代码风格检查" → `code-style-check`），保留中文作为 `name`。\n' +
      '3. **必填**：`slug` + `name`（CJK 允许，UI / 对用户说话引用都用它）+ `description`（≤1024）+ `content`（Markdown）。可选：`when_to_use` / `version` / `compatibility` / `allowed_tools` / `paths`。\n' +
      '4. **成功后必须告诉用户**：从**下一条消息开始**才出现在 `<skills>` 段（当前轮的 `<skills>` 已经采集完才写文件）。这是正常的，不要怀疑创建失败。\n\n' +
      '**模式 / 上下文约束**：\n' +
      '- 仅 Agent / PMO 模式，且已选定执行现场（Workspace）时可用。\n' +
      '- `plan` / `ask` / `study` 模式下**不能**调本工具——告诉用户你可以帮他起草内容，但他需切到 Agent 模式才能保存到当前 Agent。\n' +
      '- 返回 "Workspace / Agent 上下文缺失" 错误 → 老实告诉用户没保存成功，不要重试。\n\n' +
      '**用户说"刚创建了但看不到"** → 先 `skills_search` / `skills_read` 排查。常见原因：(1) `YAML frontmatter` 格式不对；(2) `slug` 非法字符；(3) 未绑定当前 Agent / Workspace 上下文时创建。用人话告诉问题，除非用户问，不要回显原始元数据。',
    inputSchema: createInputSchema,
    isReadOnly: false,
    policyActionKind: 'object_write',
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const params = normalizeSkillCreateInput(input);

      // ── 参数校验 ──
      const validationError = validateSkillCreateInput(params);
      if (validationError) return validationError;

      const cbCtx: SkillsToolsCallbackContext = {
        spaceId: deps.spaceId,
        organizationId: deps.organizationId,
      };

      const registration = await registerSkillIfAvailable(deps, params);
      if (!registration.ok) return registration.result;
      const { effectiveSlug, skillId } = registration;

      const frontmatter = buildFrontmatter({
        slug: effectiveSlug,
        name: params.name,
        description: params.description,
        when_to_use: params.whenToUse,
        allowed_tools: params.allowedTools,
      });

      const fullContent = frontmatter + '\n' + params.content;

      let filePath: string;
      try {
        filePath = await deps.writeSkill(effectiveSlug, fullContent, cbCtx);
      } catch (err) {
        return jsonError(
          '写入技能文件失败：宿主未能完成技能保存。',
          {
            error_kind: INTERNAL_ERROR,
            slug: effectiveSlug,
            hint: 'Stop retrying skill_create with the same input and tell the user the local skill storage failed.',
          },
        );
      }

      return {
        content: JSON.stringify({
          success: true,
          slug: effectiveSlug,
          skill_id: skillId,
          canonicalKey: `user:${effectiveSlug}`,
          filePath,
          message: `技能 "${params.name}" 已创建。下一轮对话开始可用。`,
        }),
      };
    },
  };
}
