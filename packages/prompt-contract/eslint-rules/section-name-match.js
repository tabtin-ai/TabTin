/**
 * prompt-contract/section-name-match
 *
 * 任何按字符串名引用 prompt section 的写法，必须命中 SECTION_REGISTRY。
 *
 * 触发形态：
 *   1) `appendSection('xxx', ...)` —— 一般函数调用，名为 appendSection 或
 *      MemberExpression `xxx.appendSection(...)`，第一个参数是字符串字面量
 *   2) `SYSTEM_SECTION_NAMES.xxx` —— MemberExpression，对象名 = SYSTEM_SECTION_NAMES，
 *      属性名 xxx 当作 section name 校验
 *   3) `SECTION_REGISTRY['xxx']` / `SECTION_REGISTRY.xxx` —— 直接按 string key
 *      访问注册表也走校验（任何一处拼错 key 拿到 undefined 都是治理事故）
 *
 * 例外：
 *   - 注释里出现的 section 名不算（ESLint 默认不把 comments 传给 visitor）
 *   - 测试文件中允许"故意写错的 name"做反例：路径含 `__tests__/` / `.test.` /
 *     `.spec.` 跳过本规则
 *   - 路径含 `extract_renderers.py` 输出物 `registry-entries.generated.ts`
 *     本身跳过（它就是 SSoT，校验循环依赖）
 *
 * 设计前置：
 *   - 目前代码里没有真的 `appendSection(name)` / `SYSTEM_SECTION_NAMES` 调用
 *     形态——builder.ts 走 `sections.push(buildXxxSection(...))` 静态 API。
 *     本规则定位是"未来护栏"：一旦有人引入按字符串名访问 section 的 API，
 *     立即开始反向校验，避免拼写漂移
 *   - 这条规则不替代 audit.test.ts 的反向 1:1 校验（那条管的是注册表 vs
 *     代码 writerLocations 全量对齐；本条只看"代码里出现的 string 拼写"）
 *
 */

import { getSectionIdSet } from './_load-registry.js'

const EXCLUDED_PATH_SEGMENTS = [
  '/__tests__/',
  '/__mocks__/',
  '/__fixtures__/',
  '/registry-entries.generated.ts',
  '/registry.ts', // SECTION_REGISTRY 自身定义点
  '/eslint-rules/', // 本规则自身的测试 / 元数据
]

/**
 * 不对应实际 hook 段的 marker name 白名单。
 * 它们是 sectionRegistry.push 的元数据 marker（标"基础 prompt"、"用户 persona"
 * 等），不对应可注入的 hook 段，无 registry id。Hard-coded 在这里防止 lint 误报。
 *
 * 阶段 2.2 (2026-05-20) 清理：移除 notes_hint / doom_loop_hint —— C.2 历史
 * 死路径已物理下线（字段 + 写入者 + 合并代码 + 枚举值全部删除），不再需要
 * 白名单跳过。
 */
const KNOWN_MARKER_NAMES = new Set([
  'base_prompt',
  'custom_rules',
])
const EXCLUDED_FILENAME_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i,
]

function isExcludedPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return true
  const normalized = filename.replace(/\\/g, '/')
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return true
  }
  for (const pat of EXCLUDED_FILENAME_PATTERNS) {
    if (pat.test(normalized)) return true
  }
  return false
}

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

function getStringLiteralValue(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw ?? '').join('')
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '按字符串名引用 prompt section 时（appendSection / SYSTEM_SECTION_NAMES / SECTION_REGISTRY[...]），name 必须命中 SECTION_REGISTRY。否则提示走 0_active_renderers.md 登记 + rerun extract_renderers.py。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/packages/prompt-contract/eslint-rules/README.md#section-name-match',
    },
    schema: [],
    messages: {
      notFound:
        'Section name "{{name}}" not in SECTION_REGISTRY.',
    },
  },

  create(context) {
    const filename = context.filename || (context.getFilename ? context.getFilename() : '')
    if (isExcludedPath(filename)) {
      return {}
    }

    const idSet = getSectionIdSet()
    if (idSet.size === 0) {
      // generated.ts 缺失：fail-open，让规则降级为 noop
      return {}
    }

    /** 报 name 不在注册表的错；用 reportNode 定位精确位置 */
    function reportUnknown(name, reportNode) {
      if (KNOWN_MARKER_NAMES.has(name)) return // 白名单：marker 类 + 历史死路径
      if (!idSet.has(name)) {
        context.report({
          node: reportNode,
          messageId: 'notFound',
          data: { name },
        })
      }
    }

    return {
      // 形态 1: appendSection('xxx', ...) / obj.appendSection('xxx', ...)
      CallExpression(node) {
        const calleeName = getCalleeName(node.callee)
        if (calleeName !== 'appendSection') return
        if (node.arguments.length === 0) return
        const first = node.arguments[0]
        const name = getStringLiteralValue(first)
        if (name == null) return // 动态参数，跳过
        reportUnknown(name, first)
      },

      // 形态 2: SYSTEM_SECTION_NAMES.xxx
      // 形态 3: SECTION_REGISTRY.xxx / SECTION_REGISTRY['xxx']
      MemberExpression(node) {
        let objectName = null
        if (node.object.type === 'Identifier') objectName = node.object.name
        if (objectName !== 'SYSTEM_SECTION_NAMES' && objectName !== 'SECTION_REGISTRY') return

        // 取属性名
        let propName = null
        let reportNode = node.property
        if (!node.computed && node.property.type === 'Identifier') {
          propName = node.property.name
        } else if (node.computed) {
          const v = getStringLiteralValue(node.property)
          if (v == null) return // 动态 key，跳过
          propName = v
        }
        if (propName == null) return
        reportUnknown(propName, reportNode)
      },
    }
  },
}

export default rule
