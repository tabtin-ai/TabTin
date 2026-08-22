/**
 * prompt-contract/tool-description-length
 *
 * 工具 description 单条按 tier 上限拦截。
 *
 * Tier → charBudget（来自 packages/prompt-contract/src/section-descriptor.ts
 * `ToolRiskTier` JSDoc，以及 registry-entries.generated.ts 各 tool 条目的
 * 实际 charBudget 字段）：
 *
 *   - high-risk ≤ 1500 字符（read_file / edit_file / write_file / shell / mcp_* 等）
 *   - medium    ≤ 1200 字符（web_search / parse_document / memory_* / grep / glob / agent / plan_* 等）
 *   - low-risk  ≤  500 字符（ask_user / todo_write / skills_* / show_widget / 元工具）
 *
 * 触发条件：
 *   - 文件路径在 `packages/agent-runtime/src/tools/` 下
 *     或 `packages/agent-runtime/src/capability/core/shell.ts`
 *   - 对象字面量同时含 `name: '<string-literal>'` 和 `description: <string-like>` 两个字段
 *   - 把 name 拼上 `_tool` 后缀（registry id 命名规范）从 REGISTRY 找 tier + charBudget
 *   - description 的实际字符数 > charBudget → 报错
 *
 * description 字符数计算规则（"静态可求"才算）：
 *   - StringLiteral：取 value.length
 *   - TemplateLiteral 无 ${expr}：取 quasi 内容拼接后 length
 *   - BinaryExpression（`+`）：左右递归求和；任一侧含动态部分 → 全段视为动态
 *   - 任何动态形态（含变量、函数调用、`${expr}`）→ 跳过不报（保守起见，
 *     让 audit.test.ts 在运行期实际渲染后再拦——本规则只在"显然超"的静态
 *     形态上提早预警）
 *
 * 未登记工具（name 拼 _tool 后查不到 tier）→ 跳过不报。原因：
 *   1. 新工具刚加进来还没在 0_active_renderers 登记 → audit.test.ts 反向校验
 *      会拦（"代码有但注册表没"）。本规则不重复这个职责
 *   2. 避免 lint 跟 registry 双 SSoT 漂移
 *
 */

import { getToolTierMap } from './_load-registry.js'

const TOOL_FILE_PATH_PATTERNS = [
  '/packages/agent-runtime/src/tools/',
  '/packages/agent-runtime/src/capability/core/shell.ts',
]

function isToolFilePath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return false
  const normalized = filename.replace(/\\/g, '/')
  return TOOL_FILE_PATH_PATTERNS.some((p) => normalized.includes(p))
}

/**
 * 静态计算 string-like 节点长度。含动态部分返回 null。
 *
 * 支持形态：
 *   - 'literal'  / "literal"
 *   - `template literal 无 ${}`
 *   - 'a' + 'b' + `c` ...（递归）
 *   - **同文件 module-scope const 引用**：`description: READ_FILE_DESCRIPTION`
 *     形态，constMap 已预扫到 → 当作 Literal length 返回（review D1 修复）
 *
 * 不支持（返回 null）：
 *   - 跨文件 / import 进来的常量
 *   - 函数调用 `desc()` / `formatDescription(...)`
 *   - 含 `${expr}` 的模板
 *   - MemberExpression（譬如 `actionFileReadTool.name`）
 *
 * @param {any} node
 * @param {Map<string, number> | undefined} constMap module-scope const name → 静态长度
 * @returns {number | null}
 */
function computeStaticStringLength(node, constMap) {
  if (!node) return null
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value.length : null
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length > 0) return null
    return node.quasis.reduce((acc, q) => acc + (q.value.cooked ?? q.value.raw ?? '').length, 0)
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = computeStaticStringLength(node.left, constMap)
    if (l === null) return null
    const r = computeStaticStringLength(node.right, constMap)
    if (r === null) return null
    return l + r
  }
  // 同文件 module-scope const 引用（review D1 修复）：
  // 譬如 `const READ_FILE_DESCRIPTION = '...' + '...'; ... { description: READ_FILE_DESCRIPTION }`
  // 在不解析常量的情况下，read_file 等抽 const 的工具永远被 ESLint 跳过——
  // "0 violation" 是 false-positive（review D1 抓的关键漏洞）。
  if (node.type === 'Identifier' && constMap) {
    const len = constMap.get(node.name)
    if (typeof len === 'number') return len
  }
  return null
}

/**
 * 预扫 Program.body 收集所有 module-scope `const NAME = <静态字符串>` 形态。
 *
 * 仅识别 `const` / `let` 顶层声明且 init 是静态可求字符串（含 + 拼接 / 简单
 * 模板）。`export const X = '...'` 也走 `ExportNamedDeclaration` 包装识别。
 *
 * 跨模块 / `import { X } from ...` / 命名空间导出不在范围（保守不解析）。
 *
 * @param {any} programNode
 * @returns {Map<string, number>} name → 静态长度
 */
function collectModuleScopeConstStringLengths(programNode) {
  const map = new Map()
  if (!programNode || !Array.isArray(programNode.body)) return map

  const visit = (declNode) => {
    if (!declNode || declNode.type !== 'VariableDeclaration') return
    for (const d of declNode.declarations) {
      if (!d || d.type !== 'VariableDeclarator') continue
      if (!d.id || d.id.type !== 'Identifier' || !d.init) continue
      // 递归求长度时**不传 constMap**——避免 const A = '...' + B 这种链式
      // 引用造成的顺序依赖 / 循环死锁；保守只识别完全字面量。
      const len = computeStaticStringLength(d.init, undefined)
      if (len !== null) map.set(d.id.name, len)
    }
  }

  for (const stmt of programNode.body) {
    if (stmt.type === 'VariableDeclaration') {
      visit(stmt)
    } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      visit(stmt.declaration)
    }
  }
  return map
}

/**
 * 从对象字面量节点取一个字段值。返回 Property 节点（未命中返回 undefined）。
 * 不处理 SpreadElement / computed key / shorthand 简化形态——这些场景下取
 * 不到稳定字段名，直接跳过。
 */
function findProperty(objectExpression, fieldName) {
  for (const p of objectExpression.properties) {
    if (p.type !== 'Property') continue
    if (p.computed) continue
    const key = p.key
    let keyName = null
    if (key.type === 'Identifier') keyName = key.name
    else if (key.type === 'Literal' && typeof key.value === 'string') keyName = key.value
    if (keyName === fieldName) return p
  }
  return undefined
}

function getStringLiteralValue(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '工具 description 按 ToolRiskTier 上限（high-risk ≤1500 / medium ≤1200 / low-risk ≤500）拦截。超 budget 即报错——详细教学搬到 skill，description 只留硬契约。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/packages/prompt-contract/eslint-rules/README.md#tool-description-length',
    },
    schema: [],
    messages: {
      tooLong:
        'Tool {{name}} description too long (actual {{actual}} > tier-{{tier}} budget {{budget}}). 把详细教学搬到 skill, description 留硬契约。',
      registryUnavailable:
        'prompt-contract registry 加载失败：{{error}}. 该规则不报告任何 violation。',
    },
  },

  create(context) {
    const filename = context.filename || (context.getFilename ? context.getFilename() : '')
    if (!isToolFilePath(filename)) {
      return {}
    }

    // 懒加载：在 create() 内调，避免每次启动 eslint 都全量 parse generated.ts
    // （只在真要走规则逻辑的文件上才付费）
    const tierMap = getToolTierMap()
    if (tierMap.size === 0) {
      // generated.ts 缺失 / 解析失败：fail-open（不报 violation）
      // 静默——避免每个文件都报一次。treatment 见 _load-registry.js 顶部注释。
      return {}
    }

    // 预扫 module-scope const 字符串长度（review D1 修复）：
    // 让 `description: READ_FILE_DESCRIPTION` 这种 Identifier 引用形态能被
    // 静态解析；之前 const 引用直接跳过让 read_file 长期 false-positive 0 violation。
    /** @type {Map<string, number>} */
    let constStringLengths = new Map()

    return {
      Program(node) {
        constStringLengths = collectModuleScopeConstStringLengths(node)
      },
      ObjectExpression(node) {
        const nameProp = findProperty(node, 'name')
        const descProp = findProperty(node, 'description')
        if (!nameProp || !descProp) return

        // 优先取 name 字段字面值。
        let toolName = getStringLiteralValue(nameProp.value)

        // 退路（review D1 修补）：name 是跨文件 MemberExpression（譬如
        // `name: actionFileReadTool.name`）取不到字面 → 从 description 的
        // const 名按约定推导：`READ_FILE_DESCRIPTION` → 剥 `_DESCRIPTION` 后缀
        // → 转 lower snake → `read_file`。这是治理约定（抽 const 命名必须
        // 是 `<TOOL_NAME>_DESCRIPTION`），与 0_active_renderers.md 治理纪律段
        // 对齐。让 read_file 这类抽 const + 跨文件 name 的工具也能被 lint 抓。
        if (!toolName && descProp.value && descProp.value.type === 'Identifier') {
          const constName = descProp.value.name
          const m = /^([A-Z][A-Z0-9_]*)_DESCRIPTION$/.exec(constName)
          if (m) toolName = m[1].toLowerCase()
        }

        if (!toolName) return

        const registryId = `${toolName}_tool`
        const info = tierMap.get(registryId)
        if (!info) {
          // 未登记：跳过（由 audit.test.ts 反向校验"代码有但注册表没"）
          return
        }

        const actualLen = computeStaticStringLength(descProp.value, constStringLengths)
        if (actualLen === null) return // 含动态部分，跳过
        if (actualLen <= info.charBudget) return

        context.report({
          node: descProp,
          messageId: 'tooLong',
          data: {
            name: toolName,
            actual: String(actualLen),
            tier: info.tier,
            budget: String(info.charBudget),
          },
        })
      },
    }
  },
}

export default rule
