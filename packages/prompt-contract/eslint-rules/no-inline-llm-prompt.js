/**
 * prompt-contract/no-inline-llm-prompt
 *
 * 禁止 `apps/` 下出现长中文字面量直接送 LLM 的反模式。
 *
 * 治理目的：apps 是 host（Electron / Daemon / 移动端壳），不应承载任何 prompt
 * 文案——所有 LLM-facing 自然语言段都必须出自 `@tabtin/agent-prompt` 或
 * `@tabtin/agent-runtime/prompts`，并在 SECTION_REGISTRY 登记。
 *
 * 否则会出现：
 *   - apps 里散落"小段中文 prompt"，治理脚本扫不到（不在 packages/agent-* 范围）
 *   - 同一句话在 apps 与 packages 双写、漂移失控
 *   - 阶段 0 的 0_active_renderers.yaml 全集失真
 *
 * 触发形态：
 *   1) `const xxx = '中文字符 ≥ 30'`，左侧标识符名包含 prompt / message / content /
 *      systemPrompt / userInput（不区分大小写、含子串）
 *   2) `obj.xxx = '...'` 同上
 *   3) `{ xxx: '...' }` 同上（属性 key 名匹配）
 *   4) `fn('...')` / `obj.fn('...')` 中函数名包含 addMessage / sendPrompt /
 *      prompt / system（不区分大小写、含子串）
 *
 * 触发位置：
 *   - 仅文件路径含 `/apps/` 时启用
 *   - 排除：路径含 `/i18n/` / `/locales/` / `/locale/` / `__tests__/` / `*.test.*` /
 *     `*.spec.*` / `*.stories.*` / `*.fixture.*`
 *
 * 字面量类型：StringLiteral（含 'xxx' / "xxx"）+ TemplateLiteral（含 `xxx`，
 * 但仅纯字面量、无 `${...}` 表达式时计 length；含表达式视作动态拼装放过—
 * 拼模板里的固定部分如果想拦也写得过来，但本治理阶段先聚焦"直接写大段中文"
 * 的最显眼反模式）。
 *
 * 中文字符计数：CJK Unified Ideographs + 扩展 A/B 范围。≥ 30 字阈值的选择
 * 兜底两类正面用例：
 *   - 短 toast / 按钮 label / 字段名：通常 ≤ 20 字
 *   - 错误码人类可读消息：通常 ≤ 50 字但不会赋值给名含 prompt 的变量
 *   ⇒ 30 是经验下限，能漏掉短 prompt 但不会误报普通 UI 文案
 *
 */

const MIN_CJK_CHARS = 30

// 路径排除（任一片段命中则跳过）
const EXCLUDED_PATH_SEGMENTS = [
  '/i18n/',
  '/locales/',
  '/locale/',
  '/__tests__/',
  '/__mocks__/',
  '/__fixtures__/',
]
// 文件名后缀排除
const EXCLUDED_FILENAME_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.stories\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.fixture\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.fixtures\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.mock\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.mocks\.(ts|tsx|js|jsx|mjs|cjs)$/i,
]

// 变量 / 属性名子串匹配（不区分大小写）
const LLM_TARGET_NAME_PATTERNS = [/prompt/i, /message/i, /content/i, /systemPrompt/i, /userInput/i]
// 调用对象名子串匹配（不区分大小写）—— 注意 `prompt | system` 也在调用名清单
const LLM_CALL_NAME_PATTERNS = [/addMessage/i, /sendPrompt/i, /^prompt$/i, /^system$/i, /sendMessage/i]

/** 数 CJK 字符（含扩展 A/B），不数标点 / ASCII / 空白 */
function countCjkChars(str) {
  if (typeof str !== 'string' || str.length === 0) return 0
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      n++
    }
  }
  // surrogate pair 范围（CJK ext B 等）粗略计——把 0xd800..0xdbff 视作 1 个字
  // 不影响 30 字阈值判断（即便低估也只是放过更多用例，不会误报）
  return n
}

function isExcludedPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return true
  const normalized = filename.replace(/\\/g, '/')
  if (!normalized.includes('/apps/')) return true
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return true
  }
  for (const pat of EXCLUDED_FILENAME_PATTERNS) {
    if (pat.test(normalized)) return true
  }
  return false
}

/** 把 Literal / TemplateLiteral 节点变成"用于计数的字符串"，含动态部分返回 null */
function nodeToStaticString(node) {
  if (!node) return null
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : null
  }
  if (node.type === 'TemplateLiteral') {
    // 含 ${...} 表达式 → 动态拼装，跳过
    if (node.expressions.length > 0) return null
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw ?? '').join('')
  }
  return null
}

function nameMatchesAnyPattern(name, patterns) {
  if (typeof name !== 'string' || name.length === 0) return false
  return patterns.some((p) => p.test(name))
}

/** 从 PropertyKey / VariableDeclarator id / AssignmentExpression left 等取标识符名 */
function getKeyOrIdName(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'MemberExpression') {
    if (node.property.type === 'Identifier') return node.property.name
    if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
      return node.property.value
    }
  }
  return null
}

/** 从 CallExpression callee 取"调用名"——支持 fn() / obj.fn() / a.b.fn() */
function getCalleeName(callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') {
    if (callee.property.type === 'Identifier') return callee.property.name
    if (callee.property.type === 'Literal' && typeof callee.property.value === 'string') {
      return callee.property.value
    }
  }
  return null
}

/**
 * 给定字面量节点，判定"它在 LLM 相关位置"。
 * 返回触发原因（用于报错信息），不触发则返回 null。
 */
function detectLLMContext(node) {
  const parent = node.parent
  if (!parent) return null

  // 1) const xxx = '...'  / let / var
  if (parent.type === 'VariableDeclarator' && parent.init === node) {
    const name = getKeyOrIdName(parent.id)
    if (nameMatchesAnyPattern(name, LLM_TARGET_NAME_PATTERNS)) {
      return `variable "${name}" is LLM-related`
    }
  }

  // 2) obj.xxx = '...'  / xxx = '...'
  if (parent.type === 'AssignmentExpression' && parent.right === node) {
    const name = getKeyOrIdName(parent.left)
    if (nameMatchesAnyPattern(name, LLM_TARGET_NAME_PATTERNS)) {
      return `assignment target "${name}" is LLM-related`
    }
  }

  // 3) { xxx: '...' } 对象 / class field
  if (parent.type === 'Property' && parent.value === node && !parent.computed) {
    const name = getKeyOrIdName(parent.key)
    if (nameMatchesAnyPattern(name, LLM_TARGET_NAME_PATTERNS)) {
      return `object property "${name}" is LLM-related`
    }
  }
  if (parent.type === 'PropertyDefinition' && parent.value === node && !parent.computed) {
    const name = getKeyOrIdName(parent.key)
    if (nameMatchesAnyPattern(name, LLM_TARGET_NAME_PATTERNS)) {
      return `class field "${name}" is LLM-related`
    }
  }

  // 4) fn('...') / obj.fn('...')—字面量作为参数传给名字含 LLM 关键字的函数
  if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
    const name = getCalleeName(parent.callee)
    if (nameMatchesAnyPattern(name, LLM_CALL_NAME_PATTERNS)) {
      return `call argument to LLM-related fn "${name}()"`
    }
  }
  if (parent.type === 'NewExpression' && parent.arguments.includes(node)) {
    const name = getCalleeName(parent.callee)
    if (nameMatchesAnyPattern(name, LLM_CALL_NAME_PATTERNS)) {
      return `new-expression argument to LLM-related ctor "new ${name}()"`
    }
  }

  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止 apps/ 下出现长中文字面量直接送 LLM。所有 prompt 必须出自 @tabtin/agent-prompt 或 @tabtin/agent-runtime/prompts 并在 SECTION_REGISTRY 登记。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/packages/prompt-contract/eslint-rules/README.md#no-inline-llm-prompt',
    },
    schema: [],
    messages: {
      inlinePrompt:
        '禁止在 apps/ 下硬编码长中文 prompt（CJK ≥ {{cjk}} 字符；触发位置：{{reason}}）。请改为从 @tabtin/agent-prompt 或 @tabtin/agent-runtime/prompts import 已注册的 section。',
    },
  },

  create(context) {
    const filename = context.filename || (context.getFilename ? context.getFilename() : '')
    if (isExcludedPath(filename)) {
      return {}
    }

    function check(node) {
      const text = nodeToStaticString(node)
      if (text == null) return
      const cjk = countCjkChars(text)
      if (cjk < MIN_CJK_CHARS) return
      const reason = detectLLMContext(node)
      if (!reason) return
      context.report({
        node,
        messageId: 'inlinePrompt',
        data: { cjk: String(cjk), reason },
      })
    }

    return {
      Literal: check,
      TemplateLiteral: check,
    }
  },
}

export default rule
