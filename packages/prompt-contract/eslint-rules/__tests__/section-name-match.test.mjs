/**
 * prompt-contract/section-name-match 规则单元测试
 *
 * 走 ESLint 内置 RuleTester + 真实 REGISTRY id 集合。已知存在的 id：
 *   - principle_section / environment_section / shell_runtime_section
 *   - read_file_tool / web_search_tool / todo_write_tool
 * 已知不存在的 id：
 *   - never_existed_section_xyz
 *
 * 通过：终端打印 "section-name-match: all tests passed"
 */

import { RuleTester } from 'eslint'
import rule from '../section-name-match.js'
import { getSectionIdSet } from '../_load-registry.js'

// Sanity check：registry id 集合非空、已知 id 命中
{
  const idSet = getSectionIdSet()
  if (idSet.size === 0) {
    console.error('FATAL: registry 加载为空，请先 rerun extract_renderers.py 生成 registry-entries.generated.ts')
    process.exit(1)
  }
  if (!idSet.has('principle_section')) {
    console.error('FATAL: principle_section 不在注册表（数据形态不符合预期）')
    process.exit(1)
  }
  if (idSet.has('never_existed_section_xyz')) {
    console.error('FATAL: never_existed_section_xyz 居然在注册表里（用例失效）')
    process.exit(1)
  }
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const APP_FILE = '/repo/packages/agent-prompt/src/some-feature.ts'
const TEST_FILE = '/repo/packages/agent-prompt/src/__tests__/foo.test.ts'
const GENERATED_FILE = '/repo/packages/prompt-contract/src/registry-entries.generated.ts'
const REGISTRY_FILE = '/repo/packages/prompt-contract/src/registry.ts'

ruleTester.run('section-name-match', rule, {
  valid: [
    // — 形态 1：appendSection 用真实 id —
    {
      name: "appendSection('principle_section', ...) 命中：合法",
      filename: APP_FILE,
      code: `appendSection('principle_section', {})`,
    },
    {
      name: "obj.appendSection('environment_section', ...) MemberExpression callee：合法",
      filename: APP_FILE,
      code: `builder.appendSection('environment_section', {})`,
    },

    // — 形态 2：SYSTEM_SECTION_NAMES.xxx 用真实 id —
    {
      name: 'SYSTEM_SECTION_NAMES.principle_section：合法',
      filename: APP_FILE,
      code: `const x = SYSTEM_SECTION_NAMES.principle_section`,
    },

    // — 形态 3：SECTION_REGISTRY[real_id]：合法 —
    {
      name: "SECTION_REGISTRY['read_file_tool']：合法",
      filename: APP_FILE,
      code: `const x = SECTION_REGISTRY['read_file_tool']`,
    },
    {
      name: 'SECTION_REGISTRY.web_search_tool：合法',
      filename: APP_FILE,
      code: `const x = SECTION_REGISTRY.web_search_tool`,
    },

    // — 路径例外 —
    {
      name: '测试文件：无论 id 是否存在都跳过',
      filename: TEST_FILE,
      code: `appendSection('never_existed_section_xyz', {})`,
    },
    {
      name: 'registry-entries.generated.ts 自身：跳过（避免循环依赖）',
      filename: GENERATED_FILE,
      code: `appendSection('never_existed_section_xyz', {})`,
    },
    {
      name: 'registry.ts SECTION_REGISTRY 自定义点：跳过',
      filename: REGISTRY_FILE,
      code: `appendSection('never_existed_section_xyz', {})`,
    },

    // — 动态参数：跳过 —
    {
      name: 'appendSection(dynamicVar)：跳过（无法静态判定 name）',
      filename: APP_FILE,
      code: `const name = 'principle_section'; appendSection(name, {})`,
    },
    {
      name: 'SECTION_REGISTRY[dynamicVar]：跳过',
      filename: APP_FILE,
      code: `const name = 'principle_section'; const x = SECTION_REGISTRY[name]`,
    },

    // — 不属于本规则关心的调用 —
    {
      name: '调用名不是 appendSection / 不是受关注的 object 访问：跳过',
      filename: APP_FILE,
      code: `someOtherFn('never_existed_section_xyz')`,
    },
    {
      name: 'OtherObject.never_existed_section_xyz：不是 SYSTEM_SECTION_NAMES / SECTION_REGISTRY 不触发',
      filename: APP_FILE,
      code: `const x = OtherObject.never_existed_section_xyz`,
    },
  ],

  invalid: [
    {
      name: "appendSection('never_existed_section_xyz', ...)：触发",
      filename: APP_FILE,
      code: `appendSection('never_existed_section_xyz', {})`,
      errors: [{ messageId: 'notFound', data: { name: 'never_existed_section_xyz' } }],
    },
    {
      name: "MemberExpression callee appendSection('typo_id', ...)：触发",
      filename: APP_FILE,
      code: `builder.appendSection('typo_section_id', {})`,
      errors: [{ messageId: 'notFound', data: { name: 'typo_section_id' } }],
    },
    {
      name: 'SYSTEM_SECTION_NAMES.never_existed_xxx：触发',
      filename: APP_FILE,
      code: `const x = SYSTEM_SECTION_NAMES.never_existed_xxx`,
      errors: [{ messageId: 'notFound', data: { name: 'never_existed_xxx' } }],
    },
    {
      name: "SECTION_REGISTRY['never_existed_xxx']：触发",
      filename: APP_FILE,
      code: `const x = SECTION_REGISTRY['never_existed_xxx']`,
      errors: [{ messageId: 'notFound', data: { name: 'never_existed_xxx' } }],
    },
    {
      name: 'SECTION_REGISTRY.never_existed_xxx（property access）：触发',
      filename: APP_FILE,
      code: `const x = SECTION_REGISTRY.never_existed_xxx`,
      errors: [{ messageId: 'notFound', data: { name: 'never_existed_xxx' } }],
    },
  ],
})

console.log('section-name-match: all tests passed')
