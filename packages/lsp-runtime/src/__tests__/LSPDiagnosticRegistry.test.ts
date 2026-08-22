/**
 * LSPDiagnosticRegistry 单测。
 *
 * 覆盖：
 *   - registerPendingLSPDiagnostic + checkForLSPDiagnostics 基本流
 *   - batch 内 dedup（同 batch 里同条诊断只发一次）
 *   - 跨 turn dedup（delivered LRU）—— 关键
 *   - clearDeliveredDiagnosticsForFile：编辑文件后让新诊断能通过 dedup
 *   - 按 severity 排序（Error 优先）
 *   - 每文件 cap (10)
 *   - 全局 cap (30)
 *   - 多 server 合并到单 result
 *   - 空 / 无 diagnostic 文件被过滤
 *   - 五元组 dedup：相同 message + severity + range + source + code 视为重复
 *   - clearAllLSPDiagnostics 清 pending 不清 delivered
 *   - resetAllLSPDiagnosticState 全清
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerPendingLSPDiagnostic,
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
} from '../diagnostics/LSPDiagnosticRegistry.js';
import type { Diagnostic, DiagnosticFile } from '../diagnostics/types.js';

function makeDiagnostic(
  overrides: Partial<Diagnostic> = {},
): Diagnostic {
  return {
    message: 'something is wrong',
    severity: 'Error',
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    source: 'mock-lsp',
    code: 'E001',
    ...overrides,
  };
}

function makeFile(uri: string, diagnostics: Diagnostic[]): DiagnosticFile {
  return { uri, diagnostics };
}

describe('LSPDiagnosticRegistry', () => {
  beforeEach(() => {
    resetAllLSPDiagnosticState();
  });

  it('register + check 基本流：单 server / 单文件 / 单 diag', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [makeDiagnostic()])],
    });
    expect(getPendingLSPDiagnosticCount()).toBe(1);

    const result = checkForLSPDiagnostics();
    expect(result).toHaveLength(1);
    expect(result[0]!.serverName).toBe('mock');
    expect(result[0]!.files).toHaveLength(1);
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(1);

    // 取出后 pending 清空
    expect(getPendingLSPDiagnosticCount()).toBe(0);
  });

  it('check 第二次 → 空（无新 pending）', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [makeDiagnostic()])],
    });
    checkForLSPDiagnostics();
    expect(checkForLSPDiagnostics()).toEqual([]);
  });

  it('batch 内 dedup：同 batch 里同条诊断只发一次', () => {
    const diag = makeDiagnostic();
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag, diag, diag])],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(1);
  });

  it('跨 turn dedup：第二轮收到相同诊断不重复发（delivered LRU）', () => {
    const diag = makeDiagnostic();

    // Turn 1
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    const r1 = checkForLSPDiagnostics();
    expect(r1[0]!.files[0]!.diagnostics).toHaveLength(1);

    // Turn 2: 同样诊断再次 register → delivered LRU 命中，不发
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    const r2 = checkForLSPDiagnostics();
    expect(r2).toEqual([]);
  });

  it('clearDeliveredDiagnosticsForFile 后同条诊断能再次通过 dedup', () => {
    const diag = makeDiagnostic();

    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    checkForLSPDiagnostics();

    // 模拟"文件被编辑了"，清单一文件 delivered LRU
    clearDeliveredDiagnosticsForFile('file:///a.ts');

    // 再 register 同条诊断 → 应该能通过 dedup
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    const r2 = checkForLSPDiagnostics();
    expect(r2[0]!.files[0]!.diagnostics).toHaveLength(1);
  });

  it('按 severity 排序：Error < Warning < Info < Hint', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [
        makeFile('file:///a.ts', [
          makeDiagnostic({ message: 'd1', severity: 'Hint' }),
          makeDiagnostic({ message: 'd2', severity: 'Warning' }),
          makeDiagnostic({ message: 'd3', severity: 'Info' }),
          makeDiagnostic({ message: 'd4', severity: 'Error' }),
        ]),
      ],
    });
    const result = checkForLSPDiagnostics();
    const sorted = result[0]!.files[0]!.diagnostics.map((d) => d.severity);
    expect(sorted).toEqual(['Error', 'Warning', 'Info', 'Hint']);
  });

  it('每文件 cap 10：超过 10 条只保留前 10（按 sev 排序后）', () => {
    const diags: Diagnostic[] = [];
    for (let i = 0; i < 20; i++) {
      diags.push(
        makeDiagnostic({ message: `msg-${i}`, severity: 'Warning' }),
      );
    }
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', diags)],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(10);
  });

  it('全局 cap 30：跨多个文件超过 30 条总量后截断', () => {
    const files: DiagnosticFile[] = [];
    for (let f = 0; f < 5; f++) {
      const diags: Diagnostic[] = [];
      for (let i = 0; i < 10; i++) {
        diags.push(
          makeDiagnostic({
            message: `f${f}-msg${i}`,
            severity: 'Warning',
          }),
        );
      }
      files.push(makeFile(`file:///f${f}.ts`, diags));
    }
    registerPendingLSPDiagnostic({ serverName: 'mock', files });

    const result = checkForLSPDiagnostics();
    const total = result[0]!.files.reduce(
      (sum, f) => sum + f.diagnostics.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(30);
  });

  it('多 server 合并到单 result', () => {
    registerPendingLSPDiagnostic({
      serverName: 'ts',
      files: [
        makeFile('file:///a.ts', [makeDiagnostic({ message: 'ts-err' })]),
      ],
    });
    registerPendingLSPDiagnostic({
      serverName: 'py',
      files: [
        makeFile('file:///b.py', [makeDiagnostic({ message: 'py-err' })]),
      ],
    });
    const result = checkForLSPDiagnostics();
    expect(result).toHaveLength(1); // 单 result
    expect(result[0]!.serverName).toContain('ts');
    expect(result[0]!.serverName).toContain('py');
    expect(result[0]!.files).toHaveLength(2);
  });

  it('五元组 dedup：source 不同视为不同诊断', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [
        makeFile('file:///a.ts', [
          makeDiagnostic({ source: 'tsc' }),
          makeDiagnostic({ source: 'eslint' }), // 其他字段一样，仅 source 不同
        ]),
      ],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(2);
  });

  it('五元组 dedup：range 不同视为不同诊断', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [
        makeFile('file:///a.ts', [
          makeDiagnostic({
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          }),
          makeDiagnostic({
            range: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 1 },
            },
          }),
        ]),
      ],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(2);
  });

  it('空 / 无 diagnostic 文件被过滤掉', () => {
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [
        makeFile('file:///a.ts', [makeDiagnostic()]),
        makeFile('file:///b.ts', []), // 空 diagnostics
      ],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files).toHaveLength(1);
    expect(result[0]!.files[0]!.uri).toBe('file:///a.ts');
  });

  it('clearAllLSPDiagnostics 清 pending 不清 delivered LRU', () => {
    const diag = makeDiagnostic();

    // Turn 1: register + check → 进 delivered LRU
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    checkForLSPDiagnostics();

    // Turn 2: 又 register（还没 check 取出）
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///b.ts', [makeDiagnostic({ message: 'new' })])],
    });
    expect(getPendingLSPDiagnosticCount()).toBe(1);

    clearAllLSPDiagnostics();
    expect(getPendingLSPDiagnosticCount()).toBe(0);

    // delivered LRU 仍保留：再 register 旧诊断不会被发
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    expect(checkForLSPDiagnostics()).toEqual([]);
  });

  it('resetAllLSPDiagnosticState 全清（pending + delivered）', () => {
    const diag = makeDiagnostic();
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    checkForLSPDiagnostics();

    resetAllLSPDiagnosticState();

    // 再 register 同条诊断 → 能再次发（delivered LRU 已清）
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    const result = checkForLSPDiagnostics();
    expect(result[0]!.files[0]!.diagnostics).toHaveLength(1);
  });

  it('all pending 都标 sent / 全部被 dedup 时返回空', () => {
    const diag = makeDiagnostic();

    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    checkForLSPDiagnostics();

    // 再 register 完全相同的诊断 → check 返回空
    registerPendingLSPDiagnostic({
      serverName: 'mock',
      files: [makeFile('file:///a.ts', [diag])],
    });
    expect(checkForLSPDiagnostics()).toEqual([]);
  });
});
