import { RuleTester } from 'eslint'
import rule from '../no-empty-catch.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('no-empty-catch', rule, {
  valid: [
    {
      name: 'catch with body',
      code: `try { foo() } catch (err) { console.error(err) }`,
    },
    {
      name: 'catch (err) {} 不在本规则范围内（baseline 历史代码，独立 wave 治理）',
      code: `try { foo() } catch (err) {}`,
    },
    {
      name: 'catch (_xxx) {} 不在本规则范围内',
      code: `try { foo() } catch (_err) {}`,
    },
    {
      name: 'catch {} 上方有 fail-soft 注释',
      code: `try { foo() }\n// fail-soft: 后台同步失败不打扰用户\ncatch {}`,
    },
    {
      name: 'catch (_) {} 上方有 fail-soft 注释',
      code: `try { foo() }\n// fail-soft: 一次性快照失败可降级\ncatch (_) {}`,
    },
    {
      name: 'catch {} body 内部有任意注释（视为已说明）',
      code: `try { foo() } catch { /* expected when offline */ }`,
    },
    {
      name: 'try 块上方有 fail-soft 注释（适合整段降级）',
      code: `// fail-soft: 整段功能可选\ntry { foo() } catch {}`,
    },
    {
      name: 'fail-soft 注释支持中文冒号',
      code: `try { foo() }\n// fail-soft：中文标点也算\ncatch {}`,
    },
    {
      name: 'fail-soft 注释支持破折号',
      code: `try { foo() }\n// fail-soft - 整段降级\ncatch {}`,
    },
    {
      name: 'async function 内部 catch 有 fail-soft 注释',
      code:
        `async function f() {\n` +
        `  try { await x() }\n` +
        `  // fail-soft: 网络抖动可重试\n` +
        `  catch {}\n` +
        `}`,
    },
    {
      name: 'arrow function 内部 catch (_) 有 fail-soft 注释',
      code:
        `const f = async () => {\n` +
        `  try { await x() }\n` +
        `  // fail-soft: 不影响用户路径\n` +
        `  catch (_) {}\n` +
        `}`,
    },
  ],

  invalid: [
    {
      name: '裸 catch {} 静默吞错',
      code: `try { foo() } catch {}`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: 'catch (_) {} 静默吞错',
      code: `try { foo() } catch (_) {}`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: '上方注释非 fail-soft 标识不算放行',
      code: `try { foo() }\n// TODO 后续处理\ncatch {}`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: '空 fail-soft 标记（无理由）不算放行',
      code: `try { foo() }\n// fail-soft:\ncatch {}`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: '空 fail-soft 标记（理由全空白）不算放行',
      code: `try { foo() }\n// fail-soft:    \ncatch {}`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: 'async function 内部裸 catch {} 同样命中',
      code: `async function f() { try { await x() } catch {} }`,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: 'arrow function 内部 catch (_) {} 同样命中',
      code: `const f = async () => { try { await x() } catch (_) {} }`,
      errors: [{ messageId: 'emptyCatch' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// 已知规则局限：以下用例**应该不命中**（限制；登记 §五遗留池后续治理）。
// ---------------------------------------------------------------------------

const ruleTesterLimitations = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

ruleTesterLimitations.run('no-empty-catch (known limitations)', rule, {
  valid: [
    {
      name: '【局限 1】catch (err) {} 带 named param 的空 catch（baseline 上千处历史代码，独立 wave 治理）',
      code: `try { foo() } catch (err) {}`,
    },
    {
      name: '【局限 2】catch { return null } 语义吞错走降级（body 不空，规则只看字面是否空）',
      code: `function f() { try { return foo() } catch { return null } }`,
    },
    {
      name: '【局限 2】catch (e) { console.warn(e) } 软静默形态（baseline 数百处，独立 wave 治理）',
      code: `try { foo() } catch (e) { console.warn(e) }`,
    },
  ],
  invalid: [],
})

console.log('no-empty-catch: all tests passed')
