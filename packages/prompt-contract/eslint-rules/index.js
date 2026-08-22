/**
 * @tabtin/prompt-contract ESLint plugin barrel
 *
 * 三条阶段 1.5 自定义规则，作为"加 prompt 的人写代码时立即被拦"的最前线护栏，
 * 跟 SectionDescriptor 类型层、extract_renderers.py 抽取层、audit.test.ts
 * 单元测试层四层联动。
 *
 * 在 eslint flat config 里：
 *   import promptContractPlugin from './packages/prompt-contract/eslint-rules/index.js'
 *
 *   export default [
 *     { plugins: { 'prompt-contract': promptContractPlugin } },
 *
 *     // 规则 1：禁 apps/ 下硬编码长中文 prompt（赋值给名含 prompt/message/...）
 *     {
 *       files: ['apps/** /*.{ts,tsx}'],
 *       rules: { 'prompt-contract/no-inline-llm-prompt': 'error' },
 *     },
 *
 *     // 规则 2：工具 description 按 tier 上限拦截
 *     {
 *       files: [
 *         'packages/agent-runtime/src/tools/** /*.ts',
 *         'packages/agent-runtime/src/capability/core/shell.ts',
 *       ],
 *       rules: { 'prompt-contract/tool-description-length': 'error' },
 *     },
 *
 *     // 规则 3：按字符串名引用 section 必须命中 SECTION_REGISTRY
 *     {
 *       files: [
 *         'packages/agent-prompt/** /*.ts',
 *         'packages/agent-runtime/** /*.ts',
 *         'apps/** /*.{ts,tsx}',
 *       ],
 *       rules: { 'prompt-contract/section-name-match': 'error' },
 *     },
 *   ]
 *
 * 详见 ./README.md。
 */

import noInlineLlmPrompt from './no-inline-llm-prompt.js'
import toolDescriptionLength from './tool-description-length.js'
import sectionNameMatch from './section-name-match.js'

const plugin = {
  meta: {
    name: '@tabtin/prompt-contract/eslint-plugin',
    version: '0.1.0',
  },
  rules: {
    'no-inline-llm-prompt': noInlineLlmPrompt,
    'tool-description-length': toolDescriptionLength,
    'section-name-match': sectionNameMatch,
  },
}

export default plugin
