import assert from 'node:assert'
import { RuleTester, Linter } from 'eslint'
import rule from '../prefer-scoped-activity-effects.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('prefer-scoped-activity-effects', rule, {
  valid: [
    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 1：模块级（不在任何 useEffect 内）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '模块级 window.addEventListener (chatClientSingleton 模式)',
      code: `
        if (typeof window !== 'undefined') {
          window.addEventListener('beforeunload', () => {
            cleanup()
          })
        }
      `,
    },
    {
      name: '模块级 setInterval（heartbeat singleton）',
      code: `
        const id = setInterval(() => heartbeat(), 5000)
      `,
    },
    {
      name: '模块级 new ResizeObserver（全局观察器）',
      code: `
        const obs = new ResizeObserver(() => {})
        obs.observe(document.body)
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 2：组件 body 内但不在 useEffect callback（譬如 useCallback handler）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'useCallback 内的 document.addEventListener（drag handler 模式）',
      code: `
        function ResizeHandle() {
          const onMouseDown = useCallback(() => {
            const cleanup = () => {
              document.removeEventListener('mousemove', onMouseMove)
            }
            document.addEventListener('mousemove', onMouseMove)
            document.addEventListener('mouseup', cleanup, true)
          }, [])
          return <div onMouseDown={onMouseDown} />
        }
      `,
    },
    {
      name: '组件函数内 plain helper 函数中的 setInterval（不在 effect 内）',
      code: `
        function App() {
          const start = () => {
            const id = setInterval(tick, 1000)
            return id
          }
          return <button onClick={start}>start</button>
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 3：useScoped* 包装本身
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '调用 useScopedEventListener（包装 hook 本身）',
      code: `
        function MyComp() {
          useScopedEventListener(window, 'keydown', handler)
        }
      `,
    },
    {
      name: '调用 useScopedInterval',
      code: `
        function MyComp() {
          useScopedInterval(tick, 1000, { scope: 'hot' })
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 4：element.addEventListener（target 不是 window/document/globalThis/self）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'ref.current.addEventListener 不报告（DOM element 跟随挂载）',
      code: `
        function MyComp() {
          useEffect(() => {
            if (!ref.current) return
            ref.current.addEventListener('click', handler)
            return () => ref.current?.removeEventListener('click', handler)
          }, [])
        }
      `,
    },
    {
      name: 'el.addEventListener 不报告',
      code: `
        function MyComp() {
          useEffect(() => {
            const el = document.querySelector('.foo')
            el?.addEventListener('click', handler)
          }, [])
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 5：setTimeout 不在规则范围
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'setTimeout 在 useEffect 内不报告（一次性瞬时不在规则范围）',
      code: `
        function MyComp() {
          useEffect(() => {
            const id = setTimeout(() => focus(), 100)
            return () => clearTimeout(id)
          }, [])
        }
      `,
    },

    // ────────────────────────────────────────────────────────────────────────
    // 合法 case 6：return cleanup 内的 removeEventListener / clearInterval
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'cleanup 内的 removeEventListener / clearInterval 不视为新增副作用',
      code: `
        function MyComp() {
          useEffect(() => {
            return () => {
              window.removeEventListener('resize', handler)
              clearInterval(intervalId)
            }
          }, [])
        }
      `,
    },

    // 注：disable 注释相关的 valid/invalid 用例不能走 RuleTester——
    // RuleTester 把规则注册为 `rule-to-test/<name>`，跟仓库实际配置的
    // `tabtin/<name>` 不一致，会触发"Definition for rule X was not found"
    // 干扰断言。下方走 Linter 直接验证。
  ],

  invalid: [
    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 1：window.addEventListener 在 useEffect 内
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'window.addEventListener 在 useEffect 内裸用',
      code: `
        function MyComp() {
          useEffect(() => {
            window.addEventListener('keydown', handler)
            return () => window.removeEventListener('keydown', handler)
          }, [])
        }
      `,
      errors: [{ messageId: 'windowEventListener', data: { global: 'window' } }],
    },
    {
      name: 'document.addEventListener 在 useLayoutEffect 内裸用',
      code: `
        function MyComp() {
          useLayoutEffect(() => {
            document.addEventListener('click', handler)
          }, [])
        }
      `,
      errors: [{ messageId: 'windowEventListener', data: { global: 'document' } }],
    },
    {
      name: 'globalThis.addEventListener 在 useEffect 内裸用（罕见但同款风险）',
      code: `
        function MyComp() {
          useEffect(() => {
            globalThis.addEventListener('error', handler)
          }, [])
        }
      `,
      errors: [{ messageId: 'windowEventListener', data: { global: 'globalThis' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 2：setInterval 在 useEffect 内
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'setInterval 在 useEffect 内裸用',
      code: `
        function MyComp() {
          useEffect(() => {
            const id = setInterval(tick, 1000)
            return () => clearInterval(id)
          }, [])
        }
      `,
      errors: [{ messageId: 'setInterval' }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 3：new ResizeObserver / MutationObserver / IntersectionObserver
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'new ResizeObserver 在 useEffect 内裸用',
      code: `
        function MyComp() {
          useEffect(() => {
            const obs = new ResizeObserver(() => {})
            obs.observe(target)
            return () => obs.disconnect()
          }, [])
        }
      `,
      errors: [{ messageId: 'observerCtor', data: { ctor: 'ResizeObserver' } }],
    },
    {
      name: 'new MutationObserver 在 useEffect 内裸用',
      code: `
        function MyComp() {
          useEffect(() => {
            const obs = new MutationObserver(() => {})
            obs.observe(target, { childList: true })
            return () => obs.disconnect()
          }, [])
        }
      `,
      errors: [{ messageId: 'observerCtor', data: { ctor: 'MutationObserver' } }],
    },
    {
      name: 'new IntersectionObserver 在 useEffect 内裸用',
      code: `
        function MyComp() {
          useEffect(() => {
            const obs = new IntersectionObserver(() => {})
            obs.observe(target)
            return () => obs.disconnect()
          }, [])
        }
      `,
      errors: [{ messageId: 'observerCtor', data: { ctor: 'IntersectionObserver' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 4：嵌套 inner function 内的裸用（仍然在 useEffect 链路上）
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'useEffect → inner function → window.addEventListener',
      code: `
        function MyComp() {
          useEffect(() => {
            const setupLater = () => {
              window.addEventListener('resize', handler)
            }
            setupLater()
          }, [])
        }
      `,
      errors: [{ messageId: 'windowEventListener', data: { global: 'window' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 5：useInsertionEffect 同样命中
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'useInsertionEffect 内 setInterval',
      code: `
        function MyComp() {
          useInsertionEffect(() => {
            const id = setInterval(tick, 1000)
            return () => clearInterval(id)
          }, [])
        }
      `,
      errors: [{ messageId: 'setInterval' }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 6：React.useEffect 命名空间形态
    // ────────────────────────────────────────────────────────────────────────
    {
      name: 'React.useEffect 命名空间形态',
      code: `
        import * as React from 'react'
        function MyComp() {
          React.useEffect(() => {
            window.addEventListener('keydown', handler)
          }, [])
        }
      `,
      errors: [{ messageId: 'windowEventListener', data: { global: 'window' } }],
    },

    // ────────────────────────────────────────────────────────────────────────
    // 违例 case 7：多个违例同 effect 全部命中
    // ────────────────────────────────────────────────────────────────────────
    {
      name: '一个 useEffect 内多类违例并发命中',
      code: `
        function MyComp() {
          useEffect(() => {
            window.addEventListener('resize', handler)
            const id = setInterval(tick, 1000)
            const obs = new ResizeObserver(() => {})
          }, [])
        }
      `,
      errors: [
        { messageId: 'windowEventListener', data: { global: 'window' } },
        { messageId: 'setInterval' },
        { messageId: 'observerCtor', data: { ctor: 'ResizeObserver' } },
      ],
    },

    // 注：disable-with-reason 校验走下方 Linter 直测。
  ],
})

// ────────────────────────────────────────────────────────────────────────────
// disable 注释 + -- 理由 校验：用 Linter 直跑（绕过 RuleTester 的规则名前缀差异）
// ────────────────────────────────────────────────────────────────────────────

const linter = new Linter()

function lintWithRule(code, ruleName = 'tabtin/prefer-scoped-activity-effects') {
  return linter.verify(code, {
    plugins: {
      tabtin: { rules: { 'prefer-scoped-activity-effects': rule } },
    },
    rules: { [ruleName]: 'warn' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  })
}

const disableCases = [
  // ─── 合法：带非空理由 ────────────────────────────────────────────────
  {
    name: 'disable 注释 + -- 理由 不触发 disableMissingReason',
    code: `function MyComp() {
      useEffect(() => {
        // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 级 hotkey 注册器
        window.addEventListener('keydown', handler)
      }, [])
    }`,
    expect: 'no-disable-warning',
  },
  {
    name: 'disable 注释带多规则名 + 共享理由',
    code: `function MyComp() {
      useEffect(() => {
        // eslint-disable-next-line tabtin/prefer-scoped-activity-effects, react-hooks/exhaustive-deps -- 整段例外
        window.addEventListener('keydown', handler)
      }, [])
    }`,
    expect: 'no-disable-warning',
  },

  // ─── 非法：缺理由 ─────────────────────────────────────────────────────
  {
    name: 'disable-next-line 没带 -- 理由',
    code: `function MyComp() {
      useEffect(() => {
        // eslint-disable-next-line tabtin/prefer-scoped-activity-effects
        window.addEventListener('keydown', handler)
      }, [])
    }`,
    expect: 'has-disable-warning',
  },
  {
    name: 'disable-next-line 带 -- 但理由是空白',
    code: `function MyComp() {
      useEffect(() => {
        // eslint-disable-next-line tabtin/prefer-scoped-activity-effects --
        window.addEventListener('keydown', handler)
      }, [])
    }`,
    expect: 'has-disable-warning',
  },
  // 注：块级 `/* eslint-disable tabtin/prefer-scoped-activity-effects */` 会
  // 静默整个文件（包括本规则自身的 Program:exit 上报），所以 disableMissingReason
  // 在块级 disable 场景下**无法触发**——这是 ESLint disable 指令的语义所限，
  // 不是 bug。仓库内出现整文件 disable 时由 PR review 兜底（罕见反模式）。

  // ─── 合法：其他规则的 disable 注释不被本规则关心 ──────────────────
  {
    name: '其他规则的 disable 注释不被本规则关心',
    code: `// eslint-disable-next-line react-hooks/exhaustive-deps
const x = useMemo(() => compute(), [a, b])`,
    expect: 'no-disable-warning',
  },
]

for (const tc of disableCases) {
  const messages = lintWithRule(tc.code)
  const disableWarnings = messages.filter(
    (m) => m.messageId === 'disableMissingReason',
  )
  if (tc.expect === 'has-disable-warning') {
    assert.ok(
      disableWarnings.length >= 1,
      `[${tc.name}] expected disableMissingReason but got messages=${JSON.stringify(messages)}`,
    )
  } else {
    assert.strictEqual(
      disableWarnings.length,
      0,
      `[${tc.name}] expected no disableMissingReason but got ${JSON.stringify(disableWarnings)}`,
    )
  }
}

console.log('prefer-scoped-activity-effects rule tests passed ✓')
console.log(`  RuleTester: ${ruleTester ? 'OK' : 'FAIL'} | disable comment cases: ${disableCases.length}/${disableCases.length} OK`)
