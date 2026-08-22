/**
 * prompt-contract/no-inline-llm-prompt 规则单元测试
 *
 * 走 ESLint 内置 RuleTester，跟 root eslint-rules/__tests__/ 一致风格。
 * 通过：终端打印 "no-inline-llm-prompt: all tests passed"
 * 失败：RuleTester 抛异常并 non-zero exit
 */

import { RuleTester } from 'eslint'
import rule from '../no-inline-llm-prompt.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

// 30 个中文字（≥ 阈值）
const LONG_ZH = '这是一个非常长的中文提示词必须达到三十字否则规则不会触发请仔细计算字符数'
// 短中文（< 30 字）
const SHORT_ZH = '简短文案不会触发'

const APPS_FILE = '/repo/apps/tabtin-electron/src/main/some-feature.ts'
const APPS_TEST_FILE = '/repo/apps/tabtin-electron/src/main/__tests__/foo.test.ts'
const APPS_I18N_FILE = '/repo/apps/tabtin-electron/src/renderer/i18n/zh.ts'
const PACKAGES_FILE = '/repo/packages/agent-runtime/src/foo.ts'

ruleTester.run('no-inline-llm-prompt', rule, {
  valid: [
    // — 路径例外 —
    {
      name: '不在 apps/ 下：不触发',
      filename: PACKAGES_FILE,
      code: `const prompt = '${LONG_ZH}'`,
    },
    {
      name: 'apps/ 下但测试文件：跳过',
      filename: APPS_TEST_FILE,
      code: `const prompt = '${LONG_ZH}'`,
    },
    {
      name: 'apps/ 下但 i18n 路径：跳过',
      filename: APPS_I18N_FILE,
      code: `const prompt = '${LONG_ZH}'`,
    },

    // — 字符数不够 —
    {
      name: 'apps/ 下但 CJK < 30：不触发',
      filename: APPS_FILE,
      code: `const prompt = '${SHORT_ZH}'`,
    },
    {
      name: 'apps/ 下纯英文长字符串：不触发（无 CJK）',
      filename: APPS_FILE,
      code: `const prompt = 'this is a long english string but not chinese at all'`,
    },

    // — 变量名 / 函数名不在 LLM 关键字 —
    {
      name: 'apps/ 下变量名不含 LLM 关键字：不触发',
      filename: APPS_FILE,
      code: `const greeting = '${LONG_ZH}'`,
    },
    {
      name: 'apps/ 下普通函数调用名不在清单：不触发',
      filename: APPS_FILE,
      code: `showToast('${LONG_ZH}')`,
    },

    // — 含动态部分的模板：跳过 —
    {
      name: 'apps/ 下模板含 ${} 表达式：跳过（动态拼装由 audit 兜底）',
      filename: APPS_FILE,
      code: 'const prompt = `头部前缀 ${name} 后续内容超过三十个中文字符的占位文本说明这是一段动态拼接`',
    },
  ],

  invalid: [
    {
      name: 'apps/ 下 const prompt = 长中文：触发',
      filename: APPS_FILE,
      code: `const prompt = '${LONG_ZH}'`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下 const systemPrompt = 长中文：触发',
      filename: APPS_FILE,
      code: `const systemPrompt = '${LONG_ZH}'`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下对象属性 message: 长中文：触发',
      filename: APPS_FILE,
      code: `const x = { message: '${LONG_ZH}' }`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下 obj.content = 长中文：触发',
      filename: APPS_FILE,
      code: `obj.content = '${LONG_ZH}'`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下 addMessage(长中文)：触发',
      filename: APPS_FILE,
      code: `addMessage('${LONG_ZH}')`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下 someClient.sendPrompt(长中文)：触发（MemberExpression callee）',
      filename: APPS_FILE,
      code: `someClient.sendPrompt('${LONG_ZH}')`,
      errors: [{ messageId: 'inlinePrompt' }],
    },
    {
      name: 'apps/ 下模板字面量无表达式 + 长中文：触发',
      filename: APPS_FILE,
      code: 'const prompt = `' + LONG_ZH + '`',
      errors: [{ messageId: 'inlinePrompt' }],
    },
  ],
})

console.log('no-inline-llm-prompt: all tests passed')
