import { RuleTester } from 'eslint'
import rule from '../use-virtualizer-stable-callbacks.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('use-virtualizer-stable-callbacks', rule, {
  valid: [
    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 1：useCallback / useMemo / useEvent / useEffectEvent 包装
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'getItemKey 用 useCallback 包装（最常见的合法形态）',
      code: `
        function MyList() {
          const getItemKey = useCallback((i) => itemsRef.current[i].id, [])
          const estimateSize = useCallback(() => 56, [])
          const getScrollElement = useCallback(() => parentRef.current, [])
          useVirtualizer({ count, getScrollElement, estimateSize, getItemKey })
        }
      `,
    },
    {
      name: 'estimateSize 用 useMemo 返回函数（罕见但合法）',
      code: `
        function MyList() {
          const estimateSize = useMemo(() => (i) => 56, [])
          useVirtualizer({ count: 10, estimateSize })
        }
      `,
    },
    {
      name: 'React 19 useEvent 包装',
      code: `
        function MyList() {
          const getItemKey = useEvent((i) => items[i].id)
          useVirtualizer({ count: 10, getItemKey })
        }
      `,
    },
    {
      name: 'React 19 useEffectEvent 包装',
      code: `
        function MyList() {
          const getItemKey = useEffectEvent((i) => items[i].id)
          useVirtualizer({ count: 10, getItemKey })
        }
      `,
    },
    {
      name: '命名空间化的 React.useCallback',
      code: `
        import * as React from 'react'
        function MyList() {
          const getItemKey = React.useCallback((i) => items[i].id, [])
          useVirtualizer({ count: 10, getItemKey })
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 2：模块作用域稳定函数
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '模块级 const 箭头函数（永久稳定引用）',
      code: `
        const getRowKey = (i) => i
        function MyList() {
          useVirtualizer({ count: 10, getItemKey: getRowKey })
        }
      `,
    },
    {
      name: '模块级 function declaration',
      code: `
        function getRowKey(i) { return i }
        function MyList() {
          useVirtualizer({ count: 10, getItemKey: getRowKey })
        }
      `,
    },
    {
      name: 'import 进来的稳定函数',
      code: `
        import { defaultEstimate } from './utils'
        function MyList() {
          useVirtualizer({ count: 10, estimateSize: defaultEstimate })
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 3：不在规则范围
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '只传非 measurement-affecting 字段（count / overscan / paddingStart）',
      code: `
        function MyList() {
          useVirtualizer({ count: 10, overscan: 5, paddingStart: 8 })
        }
      `,
    },
    {
      name: '同名属性但不是 useVirtualizer hook（其他 API 巧合用了 getItemKey 名）',
      code: `
        function MyList() {
          someOtherApi({ getItemKey: (i) => i, estimateSize: () => 56 })
        }
      `,
    },
    {
      name: 'spread 形态跳过（静态分析不可达，留 PR review 兜底）',
      code: `
        function MyList(opts) {
          useVirtualizer({ count: 10, ...opts })
        }
      `,
    },
    {
      name: '无法解析的 Identifier（来自 global）保守不报',
      code: `
        function MyList() {
          useVirtualizer({ count: 10, getItemKey: someUnresolvedGlobal })
        }
      `,
    },
    {
      name: 'MemberExpression 引用（如 fnRef.current）保守不报',
      code: `
        function MyList() {
          const fnRef = useRef((i) => i)
          useVirtualizer({ count: 10, getItemKey: fnRef.current })
        }
      `,
    },
    {
      name: 'CallExpression 返回值（无法判定）保守不报',
      code: `
        function MyList() {
          const fn = createCustomKeyFactory()
          useVirtualizer({ count: 10, getItemKey: fn })
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 4：一层别名追溯
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '一层别名指向 useCallback（链式合法）',
      code: `
        function MyList() {
          const memoized = useCallback((i) => i, [])
          const getItemKey = memoized
          useVirtualizer({ count: 10, getItemKey })
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 5：useWindowVirtualizer 同样应识别（但合法形态不报）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'useWindowVirtualizer 用 useCallback 包装（合法）',
      code: `
        function MyList() {
          const getItemKey = useCallback((i) => i, [])
          useWindowVirtualizer({ count: 10, getItemKey })
        }
      `,
    },
  ],

  invalid: [
    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 1：inline 函数（最直接最危险）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'inline arrow getItemKey（这就是触发 MessageList 死循环的原始 bug）',
      code: `
        function MyList() {
          useVirtualizer({
            count: 10,
            getItemKey: (i) => items[i].id,
          })
        }
      `,
      errors: [{ messageId: 'inlineFunction', data: { option: 'getItemKey' } }],
    },
    {
      name: 'inline function expression estimateSize',
      code: `
        function MyList() {
          useVirtualizer({
            count: 10,
            estimateSize: function (i) { return 56 },
          })
        }
      `,
      errors: [{ messageId: 'inlineFunction', data: { option: 'estimateSize' } }],
    },
    {
      name: 'inline arrow getScrollElement',
      code: `
        function MyList() {
          useVirtualizer({
            count: 10,
            getScrollElement: () => parentRef.current,
          })
        }
      `,
      errors: [{ messageId: 'inlineFunction', data: { option: 'getScrollElement' } }],
    },
    {
      name: '所有四个 measurement-affecting 选项同时 inline，应分别报四次',
      code: `
        function MyList() {
          useVirtualizer({
            count: 10,
            getScrollElement: () => parentRef.current,
            estimateSize: (i) => 56,
            getItemKey: (i) => i,
            rangeExtractor: (range) => range,
          })
        }
      `,
      errors: [
        { messageId: 'inlineFunction', data: { option: 'getScrollElement' } },
        { messageId: 'inlineFunction', data: { option: 'estimateSize' } },
        { messageId: 'inlineFunction', data: { option: 'getItemKey' } },
        { messageId: 'inlineFunction', data: { option: 'rangeExtractor' } },
      ],
    },
    {
      name: 'observeElementRect inline（罕见但同样危险）',
      code: `
        function MyList() {
          useVirtualizer({
            count: 10,
            observeElementRect: (instance, cb) => {},
          })
        }
      `,
      errors: [{ messageId: 'inlineFunction', data: { option: 'observeElementRect' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 2：组件 body 内的 inline 函数赋给变量（绕过规则的常见反模式）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '组件内 const fn = arrow（被赋值绕过 inline 检查，但本质还是 inline）',
      code: `
        function MyList() {
          const getKey = (i) => items[i].id
          useVirtualizer({ count: 10, getItemKey: getKey })
        }
      `,
      errors: [{ messageId: 'unstableIdentifier', data: { option: 'getItemKey', name: 'getKey' } }],
    },
    {
      name: '组件内 function declaration 同样不稳定',
      code: `
        function MyList() {
          function getKey(i) { return items[i].id }
          useVirtualizer({ count: 10, getItemKey: getKey })
        }
      `,
      errors: [{ messageId: 'unstableIdentifier', data: { option: 'getItemKey', name: 'getKey' } }],
    },
    {
      name: '一层别名指向不稳定函数（链式不稳定）',
      code: `
        function MyList() {
          const original = (i) => items[i].id
          const aliased = original
          useVirtualizer({ count: 10, getItemKey: aliased })
        }
      `,
      errors: [{ messageId: 'unstableIdentifier', data: { option: 'getItemKey', name: 'aliased' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 3：useWindowVirtualizer 同样命中
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'useWindowVirtualizer 同样命中 inline 检查',
      code: `
        function MyList() {
          useWindowVirtualizer({
            count: 10,
            getItemKey: (i) => items[i].id,
          })
        }
      `,
      errors: [{ messageId: 'inlineFunction', data: { option: 'getItemKey' } }],
    },
  ],
})

console.log('use-virtualizer-stable-callbacks: all tests passed')
