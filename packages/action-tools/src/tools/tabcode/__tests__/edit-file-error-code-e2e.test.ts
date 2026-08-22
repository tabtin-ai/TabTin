/**
 * 2026-05-10 R1 复核第二轮（W1-LL-8/9 fix-of-fix）：
 *
 * fileEditTool 设的 error_code 必须能**端到端透传**到工具 envelope output——
 * 不被 standardizeLegacyResult → mapToToolErrorCode 的 message phrase 兜底
 * 压成"看起来近似"的其他 code（例如 'old_string_not_found' 因 message 含
 * 'not found' 字面量被误判为 'element_not_found'）。
 *
 * 第一轮 R1 测试 (`edit-file-match.test.ts`) 在文件级 vi.mock 了
 * standardizeLegacyResult，断言 fileEditTool **直接** return 的 raw error_code，
 * 跳过了生产路径的关键 normalize 层——validator 第二轮抓到这个测试方法论问题。
 *
 * 本测试**故意不 mock** standardizeLegacyResult，调用 fileEditTool 后
 * 检查最终 envelope 的 `error_code` 字段是否真等于 fileEditTool 设的字符串。
 *
 * 修复点：`packages/action-tools/src/utils/error.ts:mapToToolErrorCode`
 * 加 SSoT short-circuit——任何 valid ToolErrorCode value 直接透传，不再
 * 进 phrase 兜底。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileEditTool } from '../index';
import { ToolErrorCode } from '../../../types/errors';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'edit-e2e-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fsPromises.writeFile(p, content, 'utf8');
  return p;
}

// 端到端：fileEditTool 失败 → standardizeLegacyResult 真实跑 → 检查 envelope code
async function runAndGetEnvelopeCode(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<string | undefined> {
  const res = await fileEditTool.execute({
    path: filePath,
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  });
  expect(res.success).toBe(false);
  // standardizeLegacyResult 真实 normalize 后的字段；envelope 协议是
  // `{ success, error: ToolError, ... }`，error 是 ToolError 对象（含 code 字段）
  const err = (res as { error?: { code?: string } }).error;
  return err?.code;
}

describe('fileEditTool error_code 端到端透传（不 mock standardizeLegacyResult）', () => {
  it('单次替换 not found → envelope code = "old_string_not_found"（不被 phrase mangle 成 element_not_found）', async () => {
    const file = await writeFile('e2e1.txt', 'hello world\n');
    const code = await runAndGetEnvelopeCode(file, 'NONEXISTENT', 'x');
    expect(code).toBe(ToolErrorCode.OLD_STRING_NOT_FOUND);
    expect(code).not.toBe(ToolErrorCode.ELEMENT_NOT_FOUND); // 防漂移：必须不是 phrase 兜底命中的近似 code
  });

  it('单次替换 exact 多匹配 → envelope code = "old_string_not_unique"', async () => {
    const file = await writeFile('e2e2.txt', 'foo\nfoo\n');
    const code = await runAndGetEnvelopeCode(file, 'foo', 'bar');
    expect(code).toBe(ToolErrorCode.OLD_STRING_NOT_UNIQUE);
  });

  it('单次替换 line_trimmed 多匹配 → envelope code = "old_string_not_unique"', async () => {
    const file = await writeFile(
      'e2e3.txt',
      'function a() {\n  let x = 1;\n}\nfunction b() {\n  let x = 1;\n}\n',
    );
    const code = await runAndGetEnvelopeCode(file, 'let x = 1;', 'let x = 2;');
    expect(code).toBe(ToolErrorCode.OLD_STRING_NOT_UNIQUE);
  });

  it('replace_all=true not found → envelope code = "old_string_not_found"', async () => {
    const file = await writeFile('e2e4.txt', 'hello world\n');
    const code = await runAndGetEnvelopeCode(file, 'NONEXISTENT_IN_REPLACE_ALL', 'x', true);
    expect(code).toBe(ToolErrorCode.OLD_STRING_NOT_FOUND);
  });

  it('单次替换 newContent === content (line_trimmed 命中后 LLM 复制原文) → envelope code = "old_string_not_found"', async () => {
    const file = await writeFile(
      'e2e5.txt',
      '  function foo() {\n    return 1;\n  }\n',
    );
    const matchedText = '  function foo() {\n    return 1;\n  }\n';
    const code = await runAndGetEnvelopeCode(
      file,
      'function foo() {\nreturn 1;\n}', // 全无缩进 → exact miss → line_trimmed 命中
      matchedText, // 复制 matchedText（含缩进 + 末尾 \n）
    );
    expect(code).toBe(ToolErrorCode.OLD_STRING_NOT_FOUND);
    expect(code).not.toBe(ToolErrorCode.ELEMENT_NOT_FOUND);
  });
});

// SSoT short-circuit 单测：mapToToolErrorCode 任何 valid ToolErrorCode value
// 都应直接透传（不进 phrase 兜底）。
describe('mapToToolErrorCode SSoT short-circuit', () => {
  it('R1 fix-of-fix：valid ToolErrorCode value 直接透传不被 phrase mangle', async () => {
    const { mapToToolErrorCode } = await import('../../../utils/error');

    // 关键回归：R1 设的新 code，message 故意含 'not found' phrase（以前会被
    // mangle 成 ELEMENT_NOT_FOUND）→ 现在应该直接透传 OLD_STRING_NOT_FOUND
    expect(
      mapToToolErrorCode('old_string_not_found', 'String to replace not found in file.'),
    ).toBe(ToolErrorCode.OLD_STRING_NOT_FOUND);

    expect(
      mapToToolErrorCode('old_string_not_unique', 'Found 3 matches of the string to replace'),
    ).toBe(ToolErrorCode.OLD_STRING_NOT_UNIQUE);

    // 历史 code 不破：browser 工具仍走 phrase 检测兜底
    expect(mapToToolErrorCode(undefined, '404 not found')).toBe(ToolErrorCode.ELEMENT_NOT_FOUND);
    expect(mapToToolErrorCode('', 'request timeout')).toBe(ToolErrorCode.TIMEOUT);

    // unknown code + unknown message → UNKNOWN_ERROR
    expect(mapToToolErrorCode('totally_made_up_code', 'totally unrelated msg')).toBe(
      ToolErrorCode.UNKNOWN_ERROR,
    );
  });
});
