/**
 * ToolErrorCode 现阶段 SSoT 契约：
 *   - SSoT = `packages/browser-core/src/types/errors.ts`
 *   - action-tools 必须 re-export / 消费同一份 enum（同一对象引用）
 *   - `@tabtin/contracts/tool` 已删除死镜像，不再导出 ToolErrorCode /
 *     ToolError / StandardToolOutput / ToolResult
 *
 * 不得在本测试里再维护第二份 enum 值快照；P2 将改为生成式单源。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { ToolErrorCode as BrowserCoreToolErrorCode } from '@tabtin/browser-core';
import { ToolErrorCode as ActionToolsToolErrorCode } from '@tabtin/action-tools/errors';

const CONTRACTS_TOOL_SOURCE_PATH = fileURLToPath(
  new URL('../../contracts/src/tool/index.ts', import.meta.url),
);
const CONTRACTS_ROOT_SOURCE_PATH = fileURLToPath(
  new URL('../../contracts/src/index.ts', import.meta.url),
);

const FORBIDDEN_CONTRACT_EXPORTS = new Set([
  'ToolErrorCode',
  'ToolError',
  'StandardToolOutput',
  'ToolResult',
]);

function findForbiddenExportsFromEntry(entryPath: string): string[] {
  const program = ts.createProgram({
    rootNames: [entryPath],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  const unresolvedModules = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.code === 2307);
  if (unresolvedModules.length > 0) {
    throw new Error(
      unresolvedModules
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('\n'),
    );
  }

  const sourceFile = program.getSourceFile(entryPath);
  if (!sourceFile) throw new Error(`Source entry not loaded: ${entryPath}`);

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol)
    throw new Error(`Source entry has no module symbol: ${entryPath}`);

  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .filter((name) => FORBIDDEN_CONTRACT_EXPORTS.has(name))
    .sort();
}

function findForbiddenExportsInFixture(
  files: Readonly<Record<string, string>>,
): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'contracts-source-guard-'));
  try {
    for (const [filename, sourceText] of Object.entries(files)) {
      writeFileSync(join(dir, filename), sourceText);
    }
    return findForbiddenExportsFromEntry(join(dir, 'index.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ToolErrorCode SSoT (browser-core → action-tools)', () => {
  // 运行时 identity 有意走包入口，验证发布面确实指向同一 enum；执行前需有
  // browser-core / action-tools 构建产物。contracts 防回潮不依赖此路径，见下方 src 守卫。
  it('action-tools re-exports the same ToolErrorCode enum object as browser-core', () => {
    expect(ActionToolsToolErrorCode).toBe(BrowserCoreToolErrorCode);
  });

  it('action-tools consumers see browser-core enum values (smoke, no snapshot)', () => {
    expect(ActionToolsToolErrorCode.TIMEOUT).toBe(
      BrowserCoreToolErrorCode.TIMEOUT,
    );
    expect(ActionToolsToolErrorCode.STALE_READ).toBe(
      BrowserCoreToolErrorCode.STALE_READ,
    );
    expect(typeof ActionToolsToolErrorCode.UNKNOWN_ERROR).toBe('string');
  });

  it('source guard detects declarations and aliased re-exports', () => {
    expect(
      findForbiddenExportsInFixture({
        'index.ts': `
          export enum ToolErrorCode { TIMEOUT = 'timeout' }
          export interface ToolError {}
          export type StandardToolOutput = { success: boolean };
          interface InternalToolResult {}
          export { InternalToolResult as ToolResult };
        `,
      }),
    ).toEqual([
      'StandardToolOutput',
      'ToolError',
      'ToolErrorCode',
      'ToolResult',
    ]);
  });

  it('source guard allows comments that document deleted exports', () => {
    expect(
      findForbiddenExportsInFixture({
        'index.ts': `
          // export enum ToolErrorCode { TIMEOUT = 'timeout' }
          /* export interface ToolError {}
             export type StandardToolOutput = unknown;
             export interface ToolResult {} */
          export interface AgentTool {}
        `,
      }),
    ).toEqual([]);
  });

  it('source guard resolves forbidden exports from a starred child module', () => {
    expect(
      findForbiddenExportsInFixture({
        'index.ts': `export * from './tool-errors.js';`,
        'tool-errors.ts': `
          export enum ToolErrorCode { TIMEOUT = 'timeout' }
          export interface ToolError {}
          export interface StandardToolOutput {}
          export interface ToolResult {}
        `,
      }),
    ).toEqual([
      'StandardToolOutput',
      'ToolError',
      'ToolErrorCode',
      'ToolResult',
    ]);
  });

  it('source guard resolves chained star exports with a cycle', () => {
    expect(
      findForbiddenExportsInFixture({
        'index.ts': `export * from './first.js';`,
        'first.ts': `
          export * from './second.js';
          export interface AgentTool {}
        `,
        'second.ts': `
          export * from './first.js';
          export interface ToolError {}
        `,
      }),
    ).toEqual(['ToolError']);
  });

  it('source guard allows legal star exports', () => {
    expect(
      findForbiddenExportsInFixture({
        'index.ts': `export * from './tools.js';`,
        'tools.ts': `
          export interface AgentTool {}
          export interface ToolManifest {}
        `,
      }),
    ).toEqual([]);
  });

  it('source guard resolves the contracts src files, never dist artifacts', () => {
    expect(CONTRACTS_TOOL_SOURCE_PATH).toMatch(
      /\/packages\/contracts\/src\/tool\/index\.ts$/,
    );
    expect(CONTRACTS_ROOT_SOURCE_PATH).toMatch(
      /\/packages\/contracts\/src\/index\.ts$/,
    );
    expect(CONTRACTS_TOOL_SOURCE_PATH).not.toContain('/dist/');
    expect(CONTRACTS_ROOT_SOURCE_PATH).not.toContain('/dist/');
    expect(readFileSync(CONTRACTS_TOOL_SOURCE_PATH, 'utf8')).toContain(
      'export interface AgentTool',
    );
  });

  it.each([
    ['contracts tool source', CONTRACTS_TOOL_SOURCE_PATH],
    ['contracts root source', CONTRACTS_ROOT_SOURCE_PATH],
  ])(
    '%s does not export the deleted tool error mirror',
    (_label, sourcePath) => {
      expect(findForbiddenExportsFromEntry(sourcePath)).toEqual([]);
    },
  );
});
