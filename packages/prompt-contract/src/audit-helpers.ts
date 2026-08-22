/**
 * Audit Helpers —— 给 audit.test.ts P1-P7 反向校验用的工具集
 *
 * 阶段 1.6 实现。
 *
 * 设计原则：
 *   - 纯函数，无副作用
 *   - 不读 disk，所有输入由 caller 准备
 *   - 输入校验严格，输出结构化（便于 audit test 报具体错误）
 *
 */

import type { SectionDescriptor } from './section-descriptor.js';

// ─── P1: PresenceInProduction sentinel 不变量 ─────────────────────────
//
// 阶段 0.5 review 反馈固化进 audit 的关键护栏。防止下一波 Agent 误用
// -1 作 sentinel / 写错 active+0 / cold+非 0。
//
// 不变量（与 `section-descriptor.ts::PresenceInProduction` JSDoc 一致）：
//   - hitSessions 如存在必须是非负整数，禁 -1 sentinel
//   - category=active ⇒ observed=true 且 (hitSessions 缺省 或 >= 1)
//   - category=production-cold ⇒ observed=false 且 hitSessions === 0
// ──────────────────────────────────────────────────────────────────────

export interface PresenceInvariantsResult {
  ok: boolean;
  issues: string[];
}

export function checkPresenceInvariants(d: SectionDescriptor): PresenceInvariantsResult {
  const issues: string[] = [];
  const pp = d.presenceInProduction;
  const id = d.id;

  if (!pp) {
    issues.push(`${id}: presenceInProduction is missing`);
    return { ok: false, issues };
  }

  // hitSessions 全局约束
  if (pp.hitSessions !== undefined) {
    if (typeof pp.hitSessions !== 'number' || !Number.isInteger(pp.hitSessions)) {
      issues.push(`${id}: hitSessions must be integer (got ${typeof pp.hitSessions})`);
    } else if (pp.hitSessions < 0) {
      issues.push(
        `${id}: hitSessions must be >= 0 (got ${pp.hitSessions}; -1 sentinel forbidden)`,
      );
    }
  }

  // observed 类型
  if (typeof pp.observed !== 'boolean') {
    issues.push(`${id}: observed must be bool (got ${typeof pp.observed})`);
  }

  // active 不变量
  if (pp.category === 'active') {
    if (pp.observed !== true) {
      issues.push(`${id}: category=active requires observed=true`);
    }
    if (pp.hitSessions !== undefined && pp.hitSessions < 1) {
      issues.push(
        `${id}: category=active requires hitSessions >= 1 (got ${pp.hitSessions}; omit field if not yet backfilled)`,
      );
    }
  }

  // production-cold 不变量
  if (pp.category === 'production-cold') {
    if (pp.observed !== false) {
      issues.push(`${id}: category=production-cold requires observed=false`);
    }
    if (pp.hitSessions !== 0) {
      issues.push(
        `${id}: category=production-cold requires hitSessions=0 strict (got ${pp.hitSessions})`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

// ─── P2: 字符上限 ─────────────────────────────────────────────────────

export interface CharBudgetResult {
  ok: boolean;
  actual: number;
  budget: number;
}

export function checkSectionCharBudget(
  d: SectionDescriptor,
  renderedText: string,
): CharBudgetResult {
  const actual = renderedText.length;
  return { ok: actual <= d.charBudget, actual, budget: d.charBudget };
}

// ─── P3: 语言纪律 ────────────────────────────────────────────────────
//
// "全中文化"指的是 LLM-facing 规范性自然语言段中文化，不是把代码里所有英文翻译。
// 算法（与 99 阶段 5 验收口径一致）：
//   1. 剥离白名单：XML tag / `code` / ```block``` / 路径 / URL / 大写常量 /
//      snake_case 工具名 / errno / wire 字段 / 缩写
//   2. 剩下的"规范性自然语言"按 CJK vs ASCII letter 比例判定
//   3. CJK ≥ 50% → 'zh'；CJK < 10% 且 ASCII ≥ 10 字 → 'en'；其他 → 'mixed'
//
// 当 stripped 后无字符可判（譬如纯 wrapper），返回 'zh' 作 neutral 默认。
// ──────────────────────────────────────────────────────────────────────

export type DetectedLanguage = 'zh' | 'en' | 'mixed';

const COMMON_ACRONYMS = new RegExp(
  `\\b(?:LLM|API|JSON|YAML|TOML|SSE|RAG|TLS|OAuth|HTTP|HTTPS|UI|UX|FC|MCP|CLI|UUID|UTC|UTF|CJK|HTML|CSS|TS|JS|XML|SQL|REST|gRPC|TCP|IP|TCC|SSH|DNS|MD|CDN|SDK|IDE|VPN|MAC|RAM|CPU|GPU|SSD|HDD|USB|PDF|EPUB|PPTX|PNG|JPG|GIF|MP3|MP4|AI|ML|NLP|GPT|RPC|RPM|PR|CI|CD|QPS|TPS|TODO|FIXME|XSS|CSRF|CORS|JWT|XSS|CDN|VM|OS|TBD|N\\/A|FAQ)\\b`,
  'g',
);

export function detectLanguage(text: string): DetectedLanguage {
  let stripped = text;
  // XML tag <foo> / <foo bar="..."> / </foo>
  stripped = stripped.replace(/<\/?[\w-]+(?:\s+[\w-]+(?:="[^"]*")?)*\s*\/?>/g, ' ');
  // markdown code block ```...```
  stripped = stripped.replace(/```[\s\S]*?```/g, ' ');
  // markdown inline `code`
  stripped = stripped.replace(/`[^`]*`/g, ' ');
  // markdown link [text](url) → 保留 text
  stripped = stripped.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // URL
  stripped = stripped.replace(/https?:\/\/[^\s)]+/g, ' ');
  // 路径（含 / 且非纯文字）
  stripped = stripped.replace(/[\w@.-]+\/[\w./-]+/g, ' ');
  // ALL_CAPS / CONSTANTS （2+ 字符）
  stripped = stripped.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' ');
  // UUID (含 - 的 hex)
  stripped = stripped.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
  // snake_case (lower + 1+ underscore)
  stripped = stripped.replace(/\b[a-z]+(?:_[a-z0-9]+){1,}\b/g, ' ');
  // kebab-case 标识符（譬如 organization-audit-test / test-id-123）
  stripped = stripped.replace(/\b[a-z]+(?:-[a-z0-9]+){1,}\b/g, ' ');
  // 缩写
  stripped = stripped.replace(COMMON_ACRONYMS, ' ');

  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    // CJK Unified Ideographs
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    ) {
      cjk++;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      ascii++;
    }
  }

  const total = cjk + ascii;
  // 纯 marker / 短引用，无可判字符 → 默认 zh（中文项目 neutral 默认）
  if (total === 0) return 'zh';

  const cjkRatio = cjk / total;
  // CJK ≥ 50%：中文段
  if (cjkRatio >= 0.5) return 'zh';
  // CJK 10%-50%：真混杂（少量中文连接词 + 大量英文 = mixed，需要单独识别）
  if (cjkRatio >= 0.1) return 'mixed';
  // CJK < 10%：英文段（但 ascii 要有足够内容，避免短残留误判）
  if (ascii >= 10) return 'en';
  // 短残留 / 几乎无可判字符 → 默认 zh
  return 'zh';
}

export interface LanguageDisciplineResult {
  ok: boolean;
  declared: 'zh' | 'en';
  detected: DetectedLanguage;
  hasException: boolean;
  reason?: string;
}

export function checkLanguageDiscipline(
  d: SectionDescriptor,
  renderedText: string,
): LanguageDisciplineResult {
  const detected = detectLanguage(renderedText);
  const declared = d.language;
  const hasException = Boolean(d.languageExceptionReason);

  // 双重护栏（review #2）：
  //   1. declared 与 detected 必须一致（'mixed' 视作不符）
  //   2. declared='en' 必须显式申报 languageExceptionReason
  //      —— extract_renderers.py 已在生成路径拦截，但 audit helper 作为
  //         独立护栏也加上，防止手改 generated.ts / 绕过脚本时漏。
  const languageMatches = detected === declared;
  const enExceptionOk = declared !== 'en' || hasException;
  const ok = languageMatches && enExceptionOk;

  let reason: string | undefined;
  if (!ok) {
    const parts: string[] = [];
    if (!languageMatches) {
      parts.push(`declared language=${declared} but detected=${detected}`);
    }
    if (!enExceptionOk) {
      parts.push('language=en requires languageExceptionReason');
    }
    reason = `${d.id}: ${parts.join('; ')}`;
  }

  return {
    ok,
    declared,
    detected,
    hasException,
    reason,
  };
}

// ─── P4: Cache 纪律 ──────────────────────────────────────────────────

export interface CacheDisciplineResult {
  ok: boolean;
  issues: string[];
}

export function checkCacheDiscipline(d: SectionDescriptor): CacheDisciplineResult {
  const issues: string[] = [];
  if (d.cacheBreak === true && !d.cacheBreakReason) {
    issues.push(`${d.id}: cacheBreak=true requires cacheBreakReason`);
  }
  // P4 后续可加：cacheBreak=true 不能出现在 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之前
  // 但 boundary 的位置需要 caller 提供，当前函数仅做 reason 必填校验
  return { ok: issues.length === 0, issues };
}

// ─── P7: 工具硬契约关键词 ────────────────────────────────────────────
//
// high-risk 工具 description 必须包含按"主题"分组的关键词，确保 LLM 即使
// 不读 skill 也能拿到底线行为约束（99 阶段 6.1 分层设计：L1 必读 / L3 可选）。
//
// 数据结构：`Record<toolId, HardContractTopic[]>`。每个 topic 是一组同义词
// （OR 语义，任一命中算覆盖）；所有 topics 必须全部覆盖（AND 语义）。
//
// 设计取舍：
//   - 单关键词列表（旧形态）容易漏判同义词（譬如 description 重写后用 "禁止"
//     而原配是 "禁"），治理时为了"过测试"反而临时塞回旧字眼；
//   - 主题分组让 audit 抓的是"硬契约语义在不在"，措辞自由可演进；
//   - 每个 topic 同时充当"治理决策书"——topic 名字写明这条契约是干嘛的，
//     瘦身时不能整 topic 砍掉。
//
// 关键词列表会随阶段 6.1 工具描述瘦身同步调整。新增 high-risk 工具时必须
// 在此登记一条 entry，否则 audit 跳过该工具不报（防漏 = 由 audit test
// "high-risk 工具必须在 HARD_CONTRACT_KEYWORDS 中"覆盖）。
// ──────────────────────────────────────────────────────────────────────

/** 一条主题：name 是"这条契约干嘛"的标签；keywords 是同义词集（OR）。 */
export interface HardContractTopic {
  /** 主题名称，譬如 "失败处理硬契约" / "禁交互命令"。报错时打印。 */
  readonly name: string;
  /** 同义词集，任一命中即视为覆盖。 */
  readonly keywords: readonly string[];
}

/**
 * high-risk 工具 description 必须覆盖的硬契约主题集。
 *
 * 仅覆盖 tier='high-risk' 工具；medium / low-risk 工具不在此表（也不要求
 * 硬契约关键词——它们的描述简短到肉眼就能 review）。
 *
 * **host-side 工具不登记 topics**：source='host' 的工具（如 mcp_call_tool）
 * description 住在 apps/ 仓库，runtime audit 拿不到工厂实例 ——
 * 这类工具的 P7 校验由 host audit 后续接入。P7-β 已加 host 豁免逻辑。
 */
export const HARD_CONTRACT_KEYWORDS: Readonly<Record<string, readonly HardContractTopic[]>> =
  Object.freeze({
    read_file_tool: [
      // 失败处理底线：LLM 看 envelope hint 决策，不能默认 retry / 绕路
      { name: '失败处理硬契约', keywords: ['envelope', 'error_kind', '失败'] },
      // 默认窗口：不读完整文件的两个信号（reminder / persisted）
      { name: '分页 + 续读信号', keywords: ['offset', 'limit'] },
      // edit_file 衔接契约：行号前缀剥离
      { name: '行号前缀剥离 (edit_file 衔接)', keywords: ['行号', 'cat -n', '精确字符串替换'] },
      // 阶段 6 review 补：单行截断 marker 不要 retry（review B4 真退化）。
      // 这是 "成功路径上预防反复无效重读" 的硬契约，不能搬 envelope。
      { name: '单行截断不重试', keywords: ['line truncated', 'minified', '巨型日志'] },
      // 阶段 6 review 补：图片 resize 后细节看不清推 chat（review 真退化）。
      // 同上 —— 成功路径上没有 envelope hint 触发，删了 LLM 会反复重读。
      { name: '图片 resize 不重读', keywords: ['resized', '重读', '云端解析'] },
    ],
    edit_file_tool: [
      { name: 'old_string 参数', keywords: ['old_string'] },
      { name: 'new_string 参数', keywords: ['new_string'] },
      // read-before-write 软引导
      { name: 'read-before-write 软引导', keywords: ['read_file'] },
      // 字面写入 / 缩进保护
      { name: '字面写入警告', keywords: ['字面', '缩进', 'tab'] },
      // 阶段 6 review 补：old_string 不唯一 → replace_all 决策（review D2，
      // edit_file 失败最常见原因，audit 漏抓让 LLM 撞 OLD_STRING_NOT_FOUND 反复 trial-error）
      { name: 'old_string 不唯一时 replace_all', keywords: ['replace_all', '不唯一'] },
      // 阶段 6 review 补：.md trailing space 语义（review D2）。
      { name: '.md trailing space 语义', keywords: ['.md', 'trailing', 'hard line break'] },
    ],
    write_file_tool: [
      { name: '覆写语义', keywords: ['覆盖', '覆写'] },
      { name: 'read-before-write 软引导', keywords: ['tool_stale_read', 'STALE_READ', '当前内容'] },
      { name: '整文件 vs 小块编辑', keywords: ['精确字符串替换', '整文件重写'] },
      { name: 'office 禁止', keywords: ['office', 'pdf', 'xlsx'] },
    ],
    delete_file_tool: [
      { name: '删除语义', keywords: ['删除'] },
      { name: '撤销机制', keywords: ['Checkpoint', '撤销', '回滚'] },
    ],
    run_terminal_command_tool: [
      // workspace / cwd 契约（：env 名与切目录语法在 <shell_runtime>，
      // 工具描述只保留 workspace 指向 + shell_runtime 指针，不再要求 TABTIN_WORKSPACE）
      { name: 'workspace / cwd 契约', keywords: ['workspace', 'shell_runtime'] },
      // 长任务背景化（status=running 由 push 通知激活下一轮）
      { name: '长任务 background 化', keywords: ['wait_ms', 'background'] },
      // 禁交互命令
      { name: '禁交互命令', keywords: ['交互', '禁'] },
      // 反向引导：避免用 shell 做有专用 FC 的事
      { name: '工具偏好（避免 shell 搜索/读写）', keywords: ['专用', 'sandbox', '结构化'] },
      // 等待场景矩阵（PRD push 通知重构 §7.4 硬约束：description 必须列出标准等待用法）
      { name: '等待场景矩阵', keywords: ['等待场景', 'pattern'] },
      // stdout > 30KB 走 full_output_path（review D3）。
      // LLM 看截断输出最常做错的决策（容易认为命令失败而 retry）。
      { name: 'stdout 截断 + full_output_path', keywords: ['full_output_path', '30KB'] },
    ],
    // mcp_call_tool_tool 是 source='host' 工具，description 住在 apps/，
    // runtime audit 拿不到工厂实例 —— P7-β 已加 host 豁免，本表不登记 topics。
  });

export interface ToolHardContractTopicMiss {
  readonly name: string;
  readonly keywords: readonly string[];
}

// ─── P2-field / P3-field: inputSchema 字段 description 治理 helper ────
//
// 设计动机（2026-05-21 阶段 6 议题 3 收口）：
//   之前的 P2-aggregate 只数工具自身 description，忽略 inputSchema 字段
//   description（LLM 调用工具时 schema 字段 description 也强制可见）。33 工具
//   136 个字段合计 10767 chars，与工具自身 11622 chars 同量级。
//
//   audit 漏算 → 治理报告"还差 1622 chars"的假"接近达标"信号，实际还差 12389。
//
// 本节提供 4 个 helper：
//   - `collectInputSchemaFieldDescriptions(schema)` —— 递归抽 description 字符串 +
//     字段路径（譬如 `properties.wait_ms.description`），让 audit 报错能定位
//   - `getFieldBudget(tier, fieldPath)` —— tier-aware 单字段上限（hard-coded 政策）
//   - `checkFieldCharBudget(...)` —— 单字段 budget 校验
//   - `checkFieldLanguageDiscipline(...)` —— 字段 description 语言纪律校验
// ──────────────────────────────────────────────────────────────────────

/** 单个字段 description 抽取项：路径 + 文本 + 是否命中"关键字段"关键词。 */
export interface InputSchemaFieldDescription {
  /** 字段路径（譬如 `properties.wait_ms`、`properties.questions.items.properties.id`）。报错时定位用。 */
  readonly path: string;
  /** description 字符串原文。 */
  readonly text: string;
}

/**
 * 递归收集 inputSchema 内所有 description 字符串 + 路径。
 *
 * 与 audit test 里旧的 `collectInputSchemaDescriptions` 不同：本 helper 返回
 * 带路径的对象，audit 报错能告诉维护者"哪个字段超 budget"。
 *
 * 路径形式：`properties.<key>` / `properties.<key>.items.properties.<sub>` 等。
 * 顶层 schema 自身的 description（譬如 root `description`）路径标 `<root>`。
 */
export function collectInputSchemaFieldDescriptions(
  schema: unknown,
): InputSchemaFieldDescription[] {
  const out: InputSchemaFieldDescription[] = [];
  const visit = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.description === 'string') {
      out.push({ path, text: n.description });
    }
    // properties.<key>：每个属性递归
    if (n.properties && typeof n.properties === 'object') {
      for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
        visit(v, `${path === '<root>' ? '' : `${path}.`}properties.${k}`);
      }
    }
    // items（array schema）：递归一次
    if (n.items && typeof n.items === 'object') {
      visit(n.items, `${path === '<root>' ? '' : `${path}.`}items`);
    }
    // additionalProperties / patternProperties / dependencies 等次要点：
    // 这些 JSON Schema 结构理论上可带 description，但 agent-runtime 当前工具
    // 用得极少，且即便用了也是 schema 校验语义而非 LLM 决策提示——为保持
    // helper 简单可读、降低误报，本期不递归。后续如发现新工具用到再补。
  };
  visit(schema, '<root>');
  return out;
}

/**
 * 哪些字段算"关键字段"（high-risk 工具里直接关系硬契约的字段）。
 *
 * 规则：字段路径里包含任一 `HARD_CONTRACT_KEYWORDS` topic 里的关键词
 * （视为 LLM 必读、需要更多说明空间），budget 上限放宽到 high-risk 关键字段档。
 *
 * 设计取舍：硬编码字段名表会让"新增 high-risk 字段"必须改两处（schema +
 * 此表）；而 substring 匹配 HARD_CONTRACT 关键词让 P7 治理基线就是 P2-field
 * 关键字段的派生表。新增 topic 时关键字段集合自动扩。
 */
export function isHighRiskKeyField(toolId: string, fieldPath: string): boolean {
  const topics = HARD_CONTRACT_KEYWORDS[toolId];
  if (!topics) return false;
  for (const topic of topics) {
    for (const kw of topic.keywords) {
      // 关键词通常是 snake_case 字段名（譬如 `wait_ms` / `session_id` /
      // `exit_code` / `old_string`）或中文短句（譬如 `禁`、`覆盖`）。
      // 字段路径只匹配 ASCII 标识符部分即可——中文关键词不参与字段判定
      // （字段路径全 ASCII）。
      if (/^[\w./-]+$/.test(kw) && fieldPath.includes(kw)) return true;
    }
  }
  return false;
}

/**
 * 单字段 budget（按 tool tier + 是否关键字段分档）。
 *
 * 政策（2026-05-21 阶段 6 议题 3）：
 *   - high-risk 工具关键字段（命中 HARD_CONTRACT 关键词）：≤ 300
 *   - high-risk 其他字段：≤ 200
 *   - medium 工具任一字段：≤ 150
 *   - low-risk 工具任一字段：≤ 150
 *
 * 比 charBudget（工具级 1200/1500/500）严格得多——字段 description 只是
 * "这个参数干嘛 + 怎么传"的硬契约，不是教程。教学性内容必须搬到 envelope
 * hint 或 skill。
 */
export function getFieldBudget(
  tier: 'high-risk' | 'medium' | 'low-risk',
  isKey: boolean,
): number {
  if (tier === 'high-risk') return isKey ? 300 : 200;
  return 150; // medium / low-risk 一律 150
}

export interface FieldCharBudgetResult {
  ok: boolean;
  actual: number;
  budget: number;
  isKeyField: boolean;
}

/**
 * 校验单个字段 description 长度是否 ≤ tier-aware budget。
 *
 * @param toolId 工具注册表 id（带 `_tool` 后缀），用来查 HARD_CONTRACT_KEYWORDS。
 * @param tier 工具风险等级。
 * @param fieldPath 字段路径（譬如 `properties.wait_ms`）。
 * @param text 字段 description 文本。
 */
export function checkFieldCharBudget(
  toolId: string,
  tier: 'high-risk' | 'medium' | 'low-risk',
  fieldPath: string,
  text: string,
): FieldCharBudgetResult {
  const isKeyField = isHighRiskKeyField(toolId, fieldPath);
  const budget = getFieldBudget(tier, isKeyField);
  return { ok: text.length <= budget, actual: text.length, budget, isKeyField };
}

export interface FieldLanguageDisciplineResult {
  ok: boolean;
  declared: 'zh' | 'en';
  detected: DetectedLanguage;
  hasException: boolean;
}

/**
 * 校验单字段 description 检测语言与工具 descriptor.language 一致。
 *
 * 复用 `detectLanguage`；放宽规则：字段 description 太短（< 20 字符）时返回
 * declared 不强校验（短文本检测信号弱，误报多）。
 */
export function checkFieldLanguageDiscipline(
  declaredLanguage: 'zh' | 'en',
  text: string,
  hasException: boolean,
): FieldLanguageDisciplineResult {
  // 短字段（譬如 "Optional tag list"）信号太弱不查；阈值 20 是经验值，
  // 与 detectLanguage 的 `ascii >= 10` 短残留兜底相互衔接。
  if (text.trim().length < 20) {
    return { ok: true, declared: declaredLanguage, detected: declaredLanguage, hasException };
  }
  const detected = detectLanguage(text);
  // 'mixed' 视作不符（字段 description 应纯一种语言；不能"中文工具 + 半英文字段"）
  const languageMatches = detected === declaredLanguage;
  // declared='en' 时必须有 languageExceptionReason
  const enExceptionOk = declaredLanguage !== 'en' || hasException;
  return {
    ok: languageMatches && enExceptionOk,
    declared: declaredLanguage,
    detected,
    hasException,
  };
}

// ─── P7-γ: LLM 可见字符串禁含废弃参数名（防漂移 audit） ───────────────
//
// 设计动机（2026-05-21 review 第三轮抓的真生产 bug）：
//   - 2026-05-18 后台执行重构把 `run_in_background: true` / `background_task_id`
//     / 旧 `timeout` 替换为 `wait_ms` / `session_id` / `hard_timeout_ms`。
//   - tool description 修了，但 runtime envelope hint / inputSchema field
//     description / 跨工具决策段（sections.ts）等"LLM 可见但不在工具 description
//     字段"的字符串还在用旧参数名。
//   - LLM 看到 envelope hint 会按废弃参数调，被 schema 静默忽略走默认行为。
//
// 本 audit 提供两个工具：
//   - `DEPRECATED_PARAM_TERMS`：禁用术语表（治理基线，扩展时同步更新）
//   - `checkNoDeprecatedTerms(text, allowedReasonRegexes?)`：对一段 LLM 可见
//     文本扫描，命中报"哪个旧术语 / 推荐换成谁"。
//
// **不豁免**注释 / docstring（开发者文档，但写错了会污染后续 review）—— caller
// 自己决定是否豁免。本 helper 只负责扫描 + 报告，是否豁免由 caller 决定。
// ──────────────────────────────────────────────────────────────────────

/** 一条废弃术语：旧形态 → 现行替代 + 理由（报错时打印让维护者明白迁移路径）。 */
export interface DeprecatedParamTerm {
  /** 旧形态 substring（譬如 `run_in_background: true`）—— substring 匹配。 */
  readonly oldTerm: string;
  /** 现行替代（譬如 `wait_ms: 0`），用在错误信息里。 */
  readonly newTerm: string;
  /** 一句话理由 / 关联的重构 commit / PRD。 */
  readonly reason: string;
}

/**
 * 当前已知废弃参数 / 字段名集合（治理基线 2026-05-21）。
 *
 * 新增 / 退役时同步本表 + 在对应 tool description / envelope hint 一次性迁移
 * 干净。**只列 LLM-facing 旧术语**——内部代码符号 / 类型名 / 数据库字段不在
 * 本表范围。
 */
export const DEPRECATED_PARAM_TERMS: readonly DeprecatedParamTerm[] = Object.freeze([
  {
    oldTerm: 'run_in_background',
    newTerm: 'wait_ms: 0',
    reason: '2026-05-18 后台执行重构：参数名从 boolean `run_in_background` 改为 数值 `wait_ms`（0=立即背景化、>0=阻塞等待 N 毫秒）。',
  },
  {
    oldTerm: 'background_task_id',
    newTerm: 'session_id',
    reason: '2026-05-18 后台执行重构：envelope 字段从 `background_task_id` 统一为 `session_id`。',
  },
]);

export interface DeprecatedTermHit {
  readonly oldTerm: string;
  readonly newTerm: string;
  readonly reason: string;
  /** 文本中第一次出现的字符偏移（用于 caller 输出 file:column 风格定位）。 */
  readonly index: number;
}

export interface NoDeprecatedTermsResult {
  ok: boolean;
  hits: readonly DeprecatedTermHit[];
}

/**
 * 扫描 LLM 可见字符串是否含已知废弃参数 / 字段名。
 *
 * @param text 要扫描的文本（譬如工具 description、envelope hint、prompt 段）。
 * @param terms 默认 `DEPRECATED_PARAM_TERMS`；caller 也可传子集（譬如只查
 *              `run_in_background` 一项）。
 *
 * 返回 hits 列表（空 = ok）。注释 / 历史 skip test / 测试断言**不**由本
 * helper 豁免，caller 决定是否调本 helper。
 */
export function checkNoDeprecatedTerms(
  text: string,
  terms: readonly DeprecatedParamTerm[] = DEPRECATED_PARAM_TERMS,
): NoDeprecatedTermsResult {
  const hits: DeprecatedTermHit[] = [];
  for (const term of terms) {
    const i = text.indexOf(term.oldTerm);
    if (i >= 0) {
      hits.push({
        oldTerm: term.oldTerm,
        newTerm: term.newTerm,
        reason: term.reason,
        index: i,
      });
    }
  }
  return { ok: hits.length === 0, hits };
}

export interface ToolHardContractResult {
  /** 全部 topics 都至少命中 1 个 keyword 即 true。 */
  ok: boolean;
  /** 是否需要本工具做硬契约校验（仅 tier='high-risk' 且在 HARD_CONTRACT_KEYWORDS 中登记的工具 applicable=true）。 */
  applicable: boolean;
  /** 工具实际长度（字符），方便上层一并报"description 长度 + 缺哪条契约"。 */
  actualLength: number;
  /** charBudget（descriptor 取），方便上层组合报错。 */
  budget: number;
  /** 所有 topics（含覆盖与未覆盖），便于上层做诊断。 */
  topics: readonly HardContractTopic[];
  /** 未覆盖的 topics（caller 用来构造 audit 报错信息）。 */
  missingTopics: readonly ToolHardContractTopicMiss[];
}

/**
 * 校验 high-risk 工具 description 是否覆盖全部硬契约 topics。
 *
 * 三种结果：
 *   - applicable=false：非 high-risk 或未在 HARD_CONTRACT_KEYWORDS 登记 → ok=true 直接返
 *   - applicable=true, missingTopics=[] → ok=true（全部 topics 覆盖）
 *   - applicable=true, missingTopics=[...] → ok=false，caller 报缺哪几条契约
 *
 * 调用者通常组合 `checkSectionCharBudget` 一起用，让 audit 报错信息含
 * "工具名 + 当前长度 + 预算 + 缺哪条硬契约"。
 */
export function checkToolHardContract(
  d: SectionDescriptor,
  descriptionText: string,
): ToolHardContractResult {
  const actualLength = descriptionText.length;
  const budget = d.charBudget;

  if (d.category !== 'tool_description' || d.tier !== 'high-risk') {
    return {
      ok: true,
      applicable: false,
      actualLength,
      budget,
      topics: [],
      missingTopics: [],
    };
  }
  const topics = HARD_CONTRACT_KEYWORDS[d.id];
  if (!topics) {
    // tier='high-risk' 但未登记硬契约 topics —— 由 audit test 单独抓
    // ("high-risk 工具必须在 HARD_CONTRACT_KEYWORDS 中" 测试)，
    // 本 helper 视为 applicable=false 不报错。
    return {
      ok: true,
      applicable: false,
      actualLength,
      budget,
      topics: [],
      missingTopics: [],
    };
  }

  const missingTopics: ToolHardContractTopicMiss[] = [];
  for (const topic of topics) {
    const hit = topic.keywords.some((kw) => descriptionText.includes(kw));
    if (!hit) {
      missingTopics.push({ name: topic.name, keywords: topic.keywords });
    }
  }

  return {
    ok: missingTopics.length === 0,
    applicable: true,
    actualLength,
    budget,
    topics,
    missingTopics,
  };
}
