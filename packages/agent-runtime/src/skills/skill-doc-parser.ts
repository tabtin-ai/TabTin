/**
 * SKILL.md 解析（Wave A · M1）
 *
 * 策略（PRD §六 + §五.2 M1 要点 ③④）：
 * - 用成熟 YAML 库（js-yaml）解析 frontmatter，不自写——agentSkills.ts 的自写
 *   parser 有局限（不支持嵌套对象、不兼容复杂 YAML），E1 §1.2 + PRD 修订 ARCH-3
 *   已明确要换。
 * - 半成品降级：解析失败（YAML 坏、缺必填字段）记 warn 日志，返回 null，不抛。
 *   Watcher 可能撞上"文件刚 open 还没 flush"，这时重试靠下一次 change 事件。
 * - slug 向下兼容（PRD §六 U-2）：
 *   - 如果 frontmatter 有 `slug` → 用它
 *   - 否则如果 `name` 是 kebab-case → 视为 `slug = name`
 *   - 否则用目录名作为 slug（保底方案，符合 agentskills.io 规范"name 必须匹配父目录"）
 * - 未知 frontmatter 字段（如 `cursor:` / `hooks`）原样
 *   保留到 `SkillFrontmatter` 的索引签名里，不作业务动作（PRD §六 PRD-2）。
 */

import * as yaml from 'js-yaml';
import type {
  SkillAgentDefinition,
  SkillFrontmatter,
  SkillInstallSpec,
  SkillRequirements,
} from './skill-types.js';

/**
 * frontmatter 边界正则。
 *
 * 要求文件以 `---` 开头、结尾另一个 `---`（允许行尾 CR）。不匹配则返回 body 全文。
 * 与 agentskills.io 及常见 Agent Skills frontmatter 约定一致。
 */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** `slug` / `name` 的 kebab-case 校验：小写字母 + 数字 + `-`，不能以 `-` 开头/结尾。 */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** slug / 目录名 → Title Case 展示名兜底（`table-operator` → `Table Operator`）。 */
function beautifySlug(slug: string): string {
  if (!slug) return '';
  const seg = slug.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? slug;
  const words = seg.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return seg;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** 长度约束（对齐 agentskills.io 规范，PRD §七 工程约束）。 */
const MAX_SLUG_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface ParseResult {
  frontmatter: SkillFrontmatter;
  /** SKILL.md 全文（含 frontmatter），给 skills_read 直接返回 */
  content: string;
}

export interface ParseOptions {
  /** 目录名（不是绝对路径），用于 slug 回退 */
  dirName: string;
  /** 用于错误日志中标示哪个文件出问题 */
  docPath: string;
}

/**
 * 归一化为 string[]：
 * - 字符串 "a b c" → 按空格分
 * - 字符串 "a,b,c" → 按逗号分
 * - 数组 → trim 过滤空
 * - 其他 → []
 */
function toStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const arr = value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const splitter = trimmed.includes(',') ? ',' : /\s+/;
    const arr = trimmed
      .split(splitter)
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

/**
 * 安全取字符串值（非字符串返回 undefined）。
 */
function toStr(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toRequirements(value: unknown): SkillRequirements | undefined {
  const obj = toRecord(value);
  if (!obj) return undefined;
  const requirements: SkillRequirements = {
    bins: toStringArray(obj.bins),
    any_bins: toStringArray(obj.any_bins),
    env: toStringArray(obj.env),
    config: toStringArray(obj.config),
  };
  return Object.values(requirements).some(Boolean) ? requirements : undefined;
}

function toInstallSpecs(value: unknown): SkillInstallSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const specs: SkillInstallSpec[] = [];
  for (const item of value) {
    const obj = toRecord(item);
    if (!obj) continue;
    const id = toStr(obj.id);
    const kind = toStr(obj.kind) as SkillInstallSpec['kind'] | undefined;
    if (!id || !kind) continue;
    if (!['brew', 'node', 'pip', 'go', 'download'].includes(kind)) continue;
    specs.push({
      id,
      kind,
      formula: toStr(obj.formula),
      package: toStr(obj.package),
      module: toStr(obj.module),
      url: toStr(obj.url),
      bins: toStringArray(obj.bins),
      label: toStr(obj.label),
      os: toStringArray(obj.os),
    });
  }
  return specs.length ? specs : undefined;
}

function toAgentDefinitions(value: unknown): SkillAgentDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents: SkillAgentDefinition[] = [];
  for (const item of value) {
    const obj = toRecord(item);
    if (!obj) continue;
    const filename = toStr(obj.filename);
    const name = toStr(obj.name);
    if (!filename || !name) continue;
    agents.push({
      filename,
      name,
      description: toStr(obj.description),
      model: toStr(obj.model),
      reply_mode: toStr(obj.reply_mode),
      tool_domains: toStringArray(obj.tool_domains),
    });
  }
  return agents.length ? agents : undefined;
}

function loadFrontmatterData(
  raw: string,
  options: ParseOptions,
  warn: (msg: string) => void,
): Record<string, unknown> | null {
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) {
    warn(`${options.docPath}: 缺少 frontmatter，跳过`);
    return null;
  }

  let loaded: unknown;
  try {
    loaded = yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`${options.docPath}: frontmatter YAML 解析失败（${reason}）`);
    return null;
  }

  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    warn(`${options.docPath}: frontmatter 必须是对象`);
    return null;
  }
  return loaded as Record<string, unknown>;
}

function promoteMetadataFields(data: Record<string, unknown>): {
  metaVersion?: string;
  tabtinMeta?: Record<string, unknown>;
} {
  const metaNs = toRecord(data.metadata);
  if (!metaNs) return {};

  const metaVersion = toStr(metaNs.version);
  // metadata.tabtin 优先；openclaw 为存量 skill 包兼容键，勿删
  const tabtinMeta = toRecord(metaNs.tabtin) ?? toRecord(metaNs.openclaw);
  if (tabtinMeta) {
    // metadata.tabtin.* 提升到顶层（新格式优先覆盖），供后续 rich 字段读取
    for (const [k, v] of Object.entries(tabtinMeta)) {
      data[k] = v;
    }
  }
  return { metaVersion, tabtinMeta };
}

function resolveSlug(
  data: Record<string, unknown>,
  rawName: string | undefined,
  options: ParseOptions,
  warn: (msg: string) => void,
): string | null {
  const rawSlug = toStr(data.slug);
  const slug = rawSlug ?? (rawName && KEBAB_CASE.test(rawName) ? rawName : options.dirName);
  if (!slug || !KEBAB_CASE.test(slug)) {
    warn(`${options.docPath}: slug "${slug}" 不是 kebab-case`);
    return null;
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    warn(`${options.docPath}: slug 超过 ${MAX_SLUG_LENGTH} 字符`);
    return null;
  }
  return slug;
}

function resolveDisplayName(
  rawName: string | undefined,
  slug: string,
  tabtinMeta: Record<string, unknown> | undefined,
): string {
  const explicitDisplay =
    toStr(tabtinMeta?.displayName) ?? toStr(tabtinMeta?.display_name);
  return explicitDisplay
    ?? (rawName && !KEBAB_CASE.test(rawName) ? rawName : undefined)
    ?? beautifySlug(slug);
}

function buildSkillFrontmatter(args: {
  data: Record<string, unknown>;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  metaVersion?: string;
  primaryEnv?: string;
}): SkillFrontmatter {
  const { data, slug, name, displayName, description, metaVersion, primaryEnv } = args;
  return {
    ...data,
    slug,
    name,
    displayName,
    description,
    when_to_use: toStr(data.when_to_use),
    // version：metadata.version（新格式）优先，回退顶层 version（旧格式）。
    // 关键：skill-preinstaller.readSkillVersion 读 frontmatter.version 做 sandbox
    // 升级判定，必须在这里归一化，否则迁移到新格式后升级判定会全 skip。
    version: metaVersion ?? toStr(data.version),
    compatibility: toStr(data.compatibility),
    'allowed-tools': data['allowed-tools'] as string | string[] | undefined,
    paths: toStringArray(data.paths),
    tags: toStringArray(data.tags),
    // category：metadata.tabtin.category（已提升到顶层）或顶层 category。供详情页 badge。
    category: toStr(data.category),
    requires: toRequirements(data.requires),
    install: toInstallSpecs(data.install),
    os_filter: toStringArray(data.os_filter) ?? toStringArray(data['os-filter']),
    always: toBool(data.always),
    emoji: toStr(data.emoji),
    homepage: toStr(data.homepage),
    agents: toAgentDefinitions(data.agents),
    'x-tabtin-apps': toStringArray(data['x-tabtin-apps']),
    'x-tabtin-agents': toStringArray(data['x-tabtin-agents']),
    primary_env: primaryEnv,
  };
}

/**
 * 解析 SKILL.md 文本内容。
 *
 * 返回 null 表示"这个文件不是一个合法的 skill（半成品/格式错）"——调用方应跳过并
 * 记 warn 日志。具体失败原因通过 `onError` 回调告知（测试 / UI red 标用）。
 */
export function parseSkillDoc(
  raw: string,
  options: ParseOptions,
  onWarn?: (msg: string) => void,
): ParseResult | null {
  const warn = onWarn ?? ((msg: string) => console.warn(`[skills] ${msg}`));

  const data = loadFrontmatterData(raw, options, warn);
  if (!data) return null;

  // ── 新标准格式归一化：metadata.* 优先，顶层字段回退 ──
  // 目标形态（Agent Skills 约定）：
  //   name: <kebab>, description, metadata: { version, tabtin: { displayName, ... } }
  // 旧格式（顶层 version / tools / requires ...）继续走下方的顶层读取兜底。
  const { metaVersion, tabtinMeta } = promoteMetadataFields(data);

  const rawName = toStr(data.name);
  const description = toStr(data.description);

  // description 是硬必填
  if (!description) {
    warn(`${options.docPath}: 缺少 description 字段`);
    return null;
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warn(
      `${options.docPath}: description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`,
    );
  }

  // slug 解析：v2.2 U-2 向下兼容链
  const slug = resolveSlug(data, rawName, options, warn);
  if (!slug) return null;

  // name 人类可读：没填就回退成 slug（UI 会把 kebab-case 转 Title Case 展示）
  const name = rawName ?? slug;
  if (name.length > MAX_NAME_LENGTH) {
    warn(`${options.docPath}: name 超过 ${MAX_NAME_LENGTH} 字符`);
  }

  // displayName 归一（绝不回退 `#` 一级标题）：
  //   1. metadata.tabtin.displayName（新格式）
  //   2. 旧格式顶层 name（当它是人类可读标题，即非 kebab）
  //   3. slug 美化（kebab → Title Case）
  const displayName = resolveDisplayName(rawName, slug, tabtinMeta);

  // Wave 1.5 P0-1 补丁：primary_env 三种写法归一化（YAML 用户习惯不一）。
  // 顺序：snake_case → camelCase → kebab-case。任一写法命中即为准。
  const primaryEnv =
    toStr(data.primary_env)
    ?? toStr((data as Record<string, unknown>).primaryEnv)
    ?? toStr((data as Record<string, unknown>)['primary-env']);

  const frontmatter = buildSkillFrontmatter({
    data,
    slug,
    name,
    displayName,
    description,
    metaVersion,
    primaryEnv,
  });

  return { frontmatter, content: raw };
}
