/**
 * tabtin/no-design-system-violations
 *
 * renderer 全域设计系统 token 守门规则（design-system.md §2 / §3 / §4 / §10）。
 * 把 cursor rule `frontend-design-system.mdc` 列的高频踩坑钉成 lint 信号，范围由
 * eslint.config.mjs 的 `files` glob 控制（renderer/src 全域），级别 `warn`——不阻塞
 * 构建，warning 数量作为收敛进度仪表盘，新代码自然合规，历史违规随阶段迁移清零。
 *
 * 这是 `no-chat-design-violations`（仅 chat 模块）的全域加强版，多覆盖两类：
 *   - 硬编码 z-index（`z-10` / `z-[9999]`）→ 必须用语义类 `z-modal` / `z-dropdown` 等（§4）
 *   - 浮层实底 `bg-popover` → 浮层必须走 `OVERLAY_SURFACE_CLASS` 不透明中性面（§10.2）
 * 复用三类 token 违规：禁用字号、像素字号、`/50` `/70` 透明度。
 *
 * 关闭：文件级 `/* eslint-disable tabtin/no-design-system-violations -- 理由 *\/`；
 * 行级 `// eslint-disable-next-line tabtin/no-design-system-violations -- 理由`。
 *
 * 注意：裸 `<button>` / `<input>` / 手写 `fixed inset-0` modal 的收敛**不**由本规则
 * 承担——那是「组件替换」而非「类名违规」，字符串 lint 无法安全判定（误伤面极大），
 * 交由收敛计划阶段 1-4 的组件迁移 + code review 处理。
 */

const PATTERNS = [
  // 禁用 Tailwind 默认字号（§2）
  {
    re: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/,
    messageId: 'rawFontSize',
  },
  // 像素 / em 硬编码字号（§2）
  {
    re: /\btext-\[(?:\d+(?:\.\d+)?(?:px|em|rem)|\d+(?:\.\d+)?)\]/,
    messageId: 'pixelFontSize',
  },
  // 违规透明度 /50 /70（§3）——仅识别已知 token 后缀，避开 hover:bg-X/90 等合法用法
  {
    re: /\b(text|bg|border|fill|ring)-(muted-foreground|foreground|background|destructive|warning|success|accent|primary|muted|popover|card|secondary|border|ring)\/(50|70)\b/,
    messageId: 'badOpacity',
  },
  // 硬编码数值 z-index（§4）——语义类 z-sticky/z-modal/... 不匹配
  {
    re: /\bz-\d+\b/,
    messageId: 'hardcodedZIndex',
  },
  // 硬编码任意值 z-index（§4）——排除 z-[var(--z-*)] 这类 CSS 变量桥接
  {
    re: /\bz-\[(?![^\]]*--z-)[^\]]*\]/,
    messageId: 'hardcodedZIndex',
  },
  // 浮层底色（§10.2）——浮层禁用 bg-popover，统一走 OVERLAY_SURFACE_CLASS（不透明中性面）
  {
    re: /\bbg-popover\b/,
    messageId: 'solidOverlay',
  },
]

const MESSAGES = {
  rawFontSize:
    '[design-system §2] 禁用 Tailwind 默认字号 `{{match}}`。改用语义字号：text-caption / text-body / text-subtitle / text-title / text-heading / text-display。',
  pixelFontSize:
    '[design-system §2] 禁止硬编码像素 / em 字号 `{{match}}`。改用语义字号；更小密度用字重 + 间距 + tracking，不另造字号档。',
  badOpacity:
    '[design-system §3] 透明度违规 `{{match}}`。强制 `/60`（次要）或 `/80`（较重要次要），禁用 `/50` 与 `/70`。',
  hardcodedZIndex:
    '[design-system §4] 禁止硬编码 z-index `{{match}}`。改用语义类 z-sticky / z-floating / z-banner / z-overlay / z-modal / z-dropdown / z-toast / z-global / z-above-global（inline style 用 ZIndex.*，CSS 用 var(--z-*)）。',
  solidOverlay:
    '[design-system §10.2] 浮层禁用 `{{match}}`。脱离布局流的浮层（Popover/Dropdown/右键菜单/Dialog/Sheet/Toast/Tooltip/自定义浮层）必须走 `OVERLAY_SURFACE_CLASS`（或 .surface-glass-overlay）——不透明中性面（亮白/暗黑、不蹭主题色），不要自写 bg-popover/bg-background/bg-card 底色。',
}

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
        'renderer 全域设计系统 token 守门：禁用默认字号 / 像素字号 / 违规透明度 /50 /70 / 硬编码 z-index / 浮层实底 bg-popover。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinno-design-system-violations',
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
        const cooked = node.value && node.value.cooked
        if (typeof cooked === 'string') {
          checkString(node, cooked)
        }
      },
    }
  },
}

export default rule
