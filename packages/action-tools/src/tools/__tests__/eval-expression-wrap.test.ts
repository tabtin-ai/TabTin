import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evalTool } from '../eval';
import { setCrawlViewAPI } from '../../utils/runtime-bridge';

/**
 *  回归：evalTool 的表达式判定必须是语法级的。
 *
 * 旧正则启发式把「嵌套函数体内含 `;` 的表达式」（async IIFE、Promise 链）误判成
 * 多语句函数体，不补 `return`，求值结果被静默丢弃（resultType: "undefined"）。
 *
 * 这里注册一个真实求值的 executeScript mock（Node 侧 eval 构建出的页面脚本），
 * 端到端锁定各代码形态的返回值。
 */

beforeEach(() => {
  setCrawlViewAPI({
    // 构建出的页面脚本是一个 async IIFE 表达式语句，eval 返回其 Promise。
    executeScript: (script: string) => Promise.resolve((0, eval)(script)),
  });
});

afterEach(() => {
  setCrawlViewAPI(null);
});

async function runEval(code: string) {
  return evalTool.execute({ code, crawlTabId: 'test-tab' });
}

describe('evalTool 表达式判定', () => {
  it('async IIFE（内部含 ; 与 return）返回求值结果而非 undefined', async () => {
    const out = await runEval(
      '(async () => { const r = []; r.push(1); r.push(2); return JSON.stringify(r); })()',
    );
    expect(out.success).toBe(true);
    expect(out.result).toBe('[1,2]');
  });

  it('Promise 链（回调体含 ; 与 return）返回链尾结果', async () => {
    const out = await runEval(
      'Promise.resolve({ len: 3 }).then(d => { const x = d.len; return x * 2; })',
    );
    expect(out.success).toBe(true);
    expect(out.result).toBe(6);
  });

  it('单表达式维持原契约', async () => {
    const out = await runEval('1 + 2');
    expect(out.success).toBe(true);
    expect(out.result).toBe(3);
  });

  it('多语句 + 显式 return 维持原契约', async () => {
    const out = await runEval('const a = 10; const b = 5; return a - b;');
    expect(out.success).toBe(true);
    expect(out.result).toBe(5);
  });

  it('多语句无显式 return 仍返回 undefined（函数体契约不变），但信封带可自愈 hint', async () => {
    const out = await runEval('const a = 1; a + 1;');
    expect(out.success).toBe(true);
    expect(out.result).toBeUndefined();
    expect((out as any).data?.hint).toContain('显式 return');
  });

  it('以 if/else 块收尾且无 return 时返回 undefined + hint（ 变体取证场景）', async () => {
    const out = await runEval(
      "const el = null;\nif (!el) {\n  JSON.stringify({ found: false });\n} else {\n  JSON.stringify({ found: true });\n}",
    );
    expect(out.success).toBe(true);
    expect(out.result).toBeUndefined();
    expect((out as any).data?.hint).toContain('undefined');
  });

  it('有返回值时不附带 hint', async () => {
    const out = await runEval('1 + 2');
    expect((out as any).data?.hint).toBeUndefined();
  });

  it('带行尾注释的表达式不被注释吞掉收尾括号', async () => {
    const out = await runEval('2 * 21 // the answer');
    expect(out.success).toBe(true);
    expect(out.result).toBe(42);
  });

  it('语法错误返回可诊断错误而非静默 undefined', async () => {
    const out = await runEval('const = broken(');
    expect(out.success).toBe(false);
  });
});
