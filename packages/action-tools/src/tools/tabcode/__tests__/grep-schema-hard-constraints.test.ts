/**
 * Wave3：grep_search schema 硬约束（output_mode enum + additionalProperties:false）。
 */
import { describe, expect, it } from 'vitest';
import { codeGrepTool, GREP_OUTPUT_MODES } from '../index.js';
import { ToolErrorCode } from '../../../types/errors.js';

describe('grep_search schema hard constraints', () => {
  it('output_mode enum 仅真实支持值，且 object 关闭 additionalProperties', () => {
    const schema = codeGrepTool.parameters as {
      properties: Record<string, { enum?: string[] }>;
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.required).toEqual(['pattern']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.output_mode?.enum).toEqual([...GREP_OUTPUT_MODES]);
  });

  it('execute 硬拒绝非法 output_mode，不把它静默当作 content', async () => {
    const result = await codeGrepTool.execute({
      pattern: 'needle',
      output_mode: 'Count',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.INVALID_PARAMETER);
  });
});
