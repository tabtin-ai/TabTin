/**
 * tabtin/no-chat-design-violations
 *
 * 把 chat 模块"设计语言治理"成果钉死的守门规则。规则范围由 eslint.config.mjs
 * 的 `files` glob 控制（仅 `apps/tabtin-electron/src/renderer/src/components/chat/**`）；
 * 报告级别为 `warn`，不阻塞 CI——既能让新代码自然合规，也能用 warning 数量
 * 度量历史违规清理进度。
 *
 * 当前监控的 5 类违规（覆盖前面治理过的硬模式）：
 *
 * 1. **硬编码 Tailwind 原色**：`text-(red|green|amber|yellow|orange)-\d{3}` / `bg-...`
 *    → 必须改用语义 token：`text-success / text-destructive / text-warning / text-accent`
 *    → 例外：voice 录音红 / DiffSummaryLine 编辑器 +/- / chatDesignTokens 定义本身
 *      用文件级 `eslint-disable` 豁免
 *
 * 2. **违规透明度 `/50` `/70`**：design-system.md §三 强制 `/60` `/80`
 *    → 写成 `/60` 或无后缀（"次要" / "正常"）
 *
 * 3. **设计系统禁用字号**：`text-(xs|sm|base|lg|xl|2xl|3xl)`
 *    → 改用 `text-caption / body / subtitle / title / heading / display`
 *
 * 4. **像素硬编码字号**：`text-[10px]` / `text-[0.85em]` 等
 *    → 同 #3 改用语义字号；信息密度通过字重/间距而非另造一档
 *
 * 5. **整片彩色容器**：`bg-(warning|destructive|success)/[12]\d?` —— **暂不开启**
 *    （误伤面太大，dialog/popover 等场景仍合法）。横幅契约由 code review 守
 *
 * ## 关闭规则
 *
 * 文件级豁免（用于 token 定义文件、领域色文件）：
 *   ```ts
 *   /* eslint-disable tabtin/no-chat-design-violations -- 理由 *\/
 *   ```
 *
 * 行级豁免（极少数动作色场景，如 voice 录音红）：
 *   ```ts
 *   // eslint-disable-next-line tabtin/no-chat-design-violations -- 录音红是动作色
 *   ```
 */

const PATTERNS = [
  // 硬编码 Tailwind 原色（覆盖 text- / bg- / border- / fill-）
  // 不查 blue（accent 别名误报多）；orange 单独保留是因为前面 Tracker 用过
  {
    re: /\b(text|bg|border|fill)-(red|green|amber|yellow|orange)-\d{2,3}\b/,
    messageId: 'rawColor',
  },
  // 违规透明度档（/50 /70）—— 只查正文/状态色 token，避开 hover:bg-X/90 等合法用法
  // 仅识别已知 token 后跟 /50 或 /70
  {
    re: /\b(text|bg|border|fill)-(muted-foreground|foreground|background|destructive|warning|success|accent|primary|muted|popover|card|secondary|border)\/(50|70)\b/,
    messageId: 'badOpacity',
  },
  // 「警示色容器面」：destructive / warning 的中等透明度面（/10 /15 /20）
  //
  // chat 模块的横幅 / 卡片样式契约规定：容器永远白底，状态退到文字色 / 图标上。
  // 实践中**一致违规**的是 `bg-destructive/10` / `bg-warning/10` 这种"整片彩色面"
  // 横幅或错误 dialog。
  //
  // 收紧边界（避免误伤合法的 chip 小色面）：
  //   - 只查 destructive / warning（不查 success / accent / primary——它们多用于 chip / TodoCard 完成指示等小面 OK 场景）
  //   - 只查 /10 /15 /20（不查 /5——/5 是 tonal hint，不是容器整片）
  //   - /8 这种「小整数」单独命中（dogfood 期出现过 `bg-destructive/8`）
  //
  // 例外（需明确豁免）：
  //   - dialog / popover 内部的告警 chip / 小色块装饰：行级 eslint-disable
  //   - 业务上"危险但可逆"的整体警示场景（譬如 voice/* 录音红、ModeBanner 模式分类色）：文件级豁免
  {
    re: /\bbg-(destructive|warning)\/(?:8|10|15|20)\b/,
    messageId: 'semanticBgFace',
  },
  // 设计系统禁用字号
  {
    re: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/,
    messageId: 'rawFontSize',
  },
  // 像素 / em 硬编码字号
  {
    re: /\btext-\[(?:\d+(?:\.\d+)?(?:px|em|rem)|\d+(?:\.\d+)?)\]/,
    messageId: 'pixelFontSize',
  },
]

const MESSAGES = {
  rawColor:
    '[chat 设计语言] 禁用硬编码 Tailwind 原色 `{{match}}`。改用语义 token：text-success / text-destructive / text-warning / text-accent / text-muted-foreground 等。色彩应跟随主题切换，且色彩应退到"点状信号"上承担（圆点 / 文字 / 图标），不用于整片容器染色。如确为领域色（voice 录音红 / DiffSummaryLine +/-），请用文件级 eslint-disable 豁免。',
  badOpacity:
    '[chat 设计语言] 透明度违规 `{{match}}`。design-system.md §三 强制 `/60`（次要）或 `/80`（较重要次要），禁用 `/50` 与 `/70`。',
  semanticBgFace:
    '[chat 设计语言] 警示色面违规 `{{match}}`。横幅 / 卡片样式契约：容器永远 `bg-background`，状态退到 `text-success/80` / `text-destructive/80` / `text-warning/80` 等文字色或图标色上承担（point-only）。如确需小面积色面（譬如 dialog 内的告警 chip），加 `// eslint-disable-next-line tabtin/no-chat-design-violations -- 理由` 例外标注。',
  rawFontSize:
    '[chat 设计语言] 禁用 Tailwind 默认字号 `{{match}}`。改用语义字号：text-caption / text-body / text-subtitle / text-title / text-heading / text-display（见 design-system.md §二）。',
  pixelFontSize:
    '[chat 设计语言] 禁止硬编码像素 / em 字号 `{{match}}`。改用语义字号；想要"比 caption 还小"的视觉密度请用字重 + 间距 + tracking 表达，不要再造一档字号。',
}

/**
 * 在字符串里查找第一处匹配，返回 { match, offset } 或 null
 */
function findFirstViolation(text) {
  for (const { re, messageId } of PATTERNS) {
    const m = re.exec(text)
    if (m) {
      return { match: m[0], offset: m.index, messageId }
    }
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'chat 模块设计语言守门：禁用硬编码 Tailwind 原色 / 违规透明度 /50 /70 / 默认字号 / 像素字号。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinno-chat-design-violations',
    },
    schema: [],
    messages: MESSAGES,
  },

  create(context) {
    function checkString(node, raw) {
      if (typeof raw !== 'string') return
      const found = findFirstViolation(raw)
      if (!found) return
      context.report({
        node,
        messageId: found.messageId,
        data: { match: found.match },
      })
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') {
          checkString(node, node.value)
        }
      },
      TemplateElement(node) {
        // 模板字符串静态片段——`text-${tone}/50` 这种动态拼出来的不查（false positive 太多）
        const cooked = node.value && node.value.cooked
        if (typeof cooked === 'string') {
          checkString(node, cooked)
        }
      },
    }
  },
}

export default rule
