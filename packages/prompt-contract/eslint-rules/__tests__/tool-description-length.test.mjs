/**
 * prompt-contract/tool-description-length 规则单元测试
 *
 * 走 ESLint 内置 RuleTester + 真实 REGISTRY 数据。tier 信息来自
 * `packages/prompt-contract/src/registry-entries.generated.ts`：
 *   - read_file_tool / edit_file_tool / write_file_tool / run_terminal_command_tool: high-risk 1500
 *   - web_search_tool / parse_document_tool: medium 1200
 *   - todo_write_tool / ask_user_tool / show_widget_tool: low-risk 500
 *
 * 通过：终端打印 "tool-description-length: all tests passed"
 */

import { RuleTester } from 'eslint'
import rule from '../tool-description-length.js'
import { getToolTierMap } from '../_load-registry.js'

// Sanity check：registry 必须能加载，否则后续测试全 fail-open 不报错，反而误判通过
{
  const tierMap = getToolTierMap()
  if (tierMap.size === 0) {
    console.error('FATAL: registry 加载为空，请先 rerun extract_renderers.py 生成 registry-entries.generated.ts')
    process.exit(1)
  }
  if (!tierMap.has('read_file_tool') || tierMap.get('read_file_tool').tier !== 'high-risk') {
    console.error('FATAL: registry 数据形态不符合预期（read_file_tool 应为 high-risk）')
    process.exit(1)
  }
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const TOOLS_FILE = '/repo/packages/agent-runtime/src/tools/web-tools.ts'
const SHELL_FILE = '/repo/packages/agent-runtime/src/capability/core/shell.ts'
const NON_TOOL_FILE = '/repo/packages/agent-runtime/src/engine/loop.ts'

// 制造一段确定字符数的纯字面量内容
function repeat(s, n) {
  return new Array(n + 1).join(s)
}

const SHORT_DESC = '短描述'
const HIGH_RISK_OVER_LIMIT = repeat('x', 1600) // 1600 > high-risk 1500
const MEDIUM_OVER_LIMIT = repeat('y', 1300) // 1300 > medium 1200
const LOW_RISK_OVER_LIMIT = repeat('z', 600) // 600 > low-risk 500
const LOW_RISK_OK = repeat('a', 400) // 400 ≤ 500

ruleTester.run('tool-description-length', rule, {
  valid: [
    // — 路径不在受规则约束的目录 —
    {
      name: '文件不在 tools/ 或 shell.ts：跳过',
      filename: NON_TOOL_FILE,
      code: `export const x = { name: 'read_file', description: '${HIGH_RISK_OVER_LIMIT}' }`,
    },

    // — 描述合规 —
    {
      name: '工具描述合规（high-risk 远低于 1500）',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'read_file', description: '${SHORT_DESC}' } }`,
    },
    {
      name: '低风险工具描述合规（low-risk 400 ≤ 500）',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'todo_write', description: '${LOW_RISK_OK}' } }`,
    },

    // — 未登记工具：跳过（不抢 audit.test.ts 反向校验的活）—
    {
      name: '未登记的工具 name：跳过',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'never_registered_xyz', description: '${HIGH_RISK_OVER_LIMIT}' } }`,
    },

    // — 含动态部分：跳过（让 audit P2 实际渲染时再拦）—
    {
      name: 'description 含变量引用：跳过',
      filename: TOOLS_FILE,
      code: `const SOME_VAR = 'x'; export function f() { return { name: 'read_file', description: SOME_VAR } }`,
    },
    {
      name: 'description 含函数调用：跳过',
      filename: TOOLS_FILE,
      code: `function fmt() { return 'x' } export function f() { return { name: 'read_file', description: fmt() } }`,
    },
    {
      name: 'description 模板含 ${} 表达式：跳过',
      filename: TOOLS_FILE,
      code: 'const name = "x"; export function f() { return { name: "read_file", description: `prefix ${name}` } }',
    },

    // — inputSchema 子对象没有 name 字段：不会被误判 —
    {
      name: 'inputSchema 子段 { type, description } 无 name 字段：不触发',
      filename: TOOLS_FILE,
      code: `const schema = { type: 'object', properties: { command: { type: 'string', description: '${HIGH_RISK_OVER_LIMIT}' } } }`,
    },

    // — BinaryExpression 拼接合规 —
    {
      name: 'description 字面量拼接但总长 ≤ tier budget：不触发',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'todo_write', description: '前缀' + '后缀' } }`,
    },
  ],

  invalid: [
    {
      name: 'high-risk 工具 description 超 1500：触发',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'read_file', description: '${HIGH_RISK_OVER_LIMIT}' } }`,
      errors: [{ messageId: 'tooLong', data: { name: 'read_file', actual: '1600', tier: 'high-risk', budget: '1500' } }],
    },
    {
      name: 'medium 工具 description 超 1200：触发',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'web_search', description: '${MEDIUM_OVER_LIMIT}' } }`,
      errors: [{ messageId: 'tooLong', data: { name: 'web_search', actual: '1300', tier: 'medium', budget: '1200' } }],
    },
    {
      name: 'low-risk 工具 description 超 500：触发',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'todo_write', description: '${LOW_RISK_OVER_LIMIT}' } }`,
      errors: [{ messageId: 'tooLong', data: { name: 'todo_write', actual: '600', tier: 'low-risk', budget: '500' } }],
    },
    {
      name: 'shell.ts 内的工具同样受规则约束',
      filename: SHELL_FILE,
      code: `export function f() { return { name: 'run_terminal_command', description: '${HIGH_RISK_OVER_LIMIT}' } }`,
      errors: [{ messageId: 'tooLong', data: { name: 'run_terminal_command', actual: '1600', tier: 'high-risk', budget: '1500' } }],
    },
    {
      name: 'BinaryExpression 拼接后总长超 tier budget：触发',
      filename: TOOLS_FILE,
      code: `export function f() { return { name: 'todo_write', description: '${repeat('p', 300)}' + '${repeat('q', 300)}' } }`,
      errors: [{ messageId: 'tooLong', data: { name: 'todo_write', actual: '600', tier: 'low-risk', budget: '500' } }],
    },
  ],
})

console.log('tool-description-length: all tests passed')
