import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBulkImportResultPayload } from './bulk-import-result.js';
import { buildBulkFieldPayload, coerceUrlFieldTypeByName, validateFieldDefinitions } from './field-contract.js';
import { coerceJSONValue, inferFieldType } from './helpers.js';

describe('buildBulkImportResultPayload', () => {
  it('marks all-created bulk imports as full_success', () => {
    const result = buildBulkImportResultPayload({
      data: {
        success_count: 2,
        failed_count: 0,
        total_count: 2,
        records: [{ id: 'r1' }, { id: 'r2' }],
        errors: [],
      },
    }, 2);

    assert.equal(result.operation_status, 'full_success');
    assert.equal(result.success_count, 2);
    assert.equal(result.failed_count, 0);
    assert.deepEqual(result.errors, []);
  });

  it('marks mixed bulk imports as partial_success', () => {
    const result = buildBulkImportResultPayload({
      data: {
        success_count: 1,
        failed_count: 1,
        total_count: 2,
        records: [{ id: 'r1' }],
        errors: ['第2条: 字段 "项目 ID" 格式不符：应为 text'],
      },
    }, 2);

    assert.equal(result.operation_status, 'partial_success');
    assert.equal(result.success_count, 1);
    assert.equal(result.failed_count, 1);
    assert.equal(result.error_summary.total, 1);
  });

  it('marks 36Kr-style long numeric project ID mismatches as complete_failure and summarizes duplicate row errors', () => {
    const longProjectId = 112233445566778899001122334455;
    const rowErrors = Array.from(
      { length: 100 },
      (_, index) => `第${index + 1}条: 字段 '项目 ID' 格式不符：text 类型不接受 number ${longProjectId}，请用字符串写入`,
    );

    const result = buildBulkImportResultPayload({
      data: {
        success_count: 0,
        failed_count: 100,
        total_count: 100,
        records: [],
        errors: rowErrors,
      },
    }, 100);

    assert.equal(result.operation_status, 'complete_failure');
    assert.equal(result.success_count, 0);
    assert.equal(result.failed_count, 100);
    assert.equal(result.total_count, 100);
    assert.equal(result.error_summary.total, 100);
    assert.equal(result.error_summary.unique_count, 1);
    assert.equal(result.error_summary.repeated_count, 99);
    assert.equal(result.error_summary.groups[0]?.count, 100);
    assert.equal(result.errors_truncated, true);
    assert.ok(result.errors.length < rowErrors.length);
    assert.match(result.errors[0] ?? '', /100 条/);
  });
});

describe('validateFieldDefinitions — CLI 可创建字段校验', () => {
  it('link 缺 options 报错', () => {
    const err = validateFieldDefinitions([{ name: '关联', field_type: 'link' }]);
    assert.match(err ?? '', /link 字段必须提供 options\.foreignTableId/);
  });

  it('link 缺 foreignTableId 报错', () => {
    const err = validateFieldDefinitions([{ name: '关联', field_type: 'link', options: {} }]);
    assert.match(err ?? '', /link 字段缺少 options\.foreignTableId/);
  });

  it('link 有 foreignTableId 通过', () => {
    const err = validateFieldDefinitions([{ name: '关联', field_type: 'link', options: { foreignTableId: 'tbl_x' } }]);
    assert.equal(err, null);
  });

  it('拒绝 UI 未开放的 lookup', () => {
    const err = validateFieldDefinitions([{ name: '引用', field_type: 'lookup' }]);
    assert.match(err ?? '', /尚未在 TabData UI 开放/);
  });

  it('text 字段仍通过（回归）', () => {
    const err = validateFieldDefinitions([{ name: '标题', field_type: 'text' }]);
    assert.equal(err, null);
  });
});

describe('coerceJSONValue', () => {
  it('parses BOM-prefixed JSON object/array strings', () => {
    assert.deepEqual(coerceJSONValue('\uFEFF{"标题":"123"}'), { 标题: '123' });
    assert.deepEqual(coerceJSONValue('\uFEFF[{"record_id":"r1"}]'), [{ record_id: 'r1' }]);
  });

  it('leaves non-JSON strings and objects untouched', () => {
    assert.equal(coerceJSONValue('not-json'), 'not-json');
    assert.deepEqual(coerceJSONValue({ a: 1 }), { a: 1 });
  });
});

describe('coerceUrlFieldTypeByName —  Agent 链接列纠偏', () => {
  it('coerces 文章链接 text → url', () => {
    const coerced = coerceUrlFieldTypeByName({ name: '文章链接', field_type: 'text' });
    assert.equal(coerced.field_type, 'url');
  });

  it('coerces project_url long_text → url via buildBulkFieldPayload', () => {
    const [field] = buildBulkFieldPayload([{ name: 'project_url', field_type: 'long_text' }]);
    assert.equal(field?.field_type, 'url');
    assert.equal(field?.description, '');
  });

  it('does not coerce non-link names or non-text types', () => {
    assert.equal(
      coerceUrlFieldTypeByName({ name: '标题', field_type: 'text' }).field_type,
      'text',
    );
    assert.equal(
      coerceUrlFieldTypeByName({ name: '文章链接', field_type: 'attachment' }).field_type,
      'attachment',
    );
  });
});

describe('inferFieldType', () => {
  it('recognizes trimmed https and bare domains as url', () => {
    assert.equal(inferFieldType(' https://www.36kr.com/p/1 '), 'url');
    assert.equal(inferFieldType('www.36kr.com/p/1'), 'url');
    assert.equal(inferFieldType('not a url'), 'text');
  });

  it('keeps ISO timestamps as text because datetime fields are retired', () => {
    assert.equal(inferFieldType('2026-08-20T12:30:00Z'), 'text');
  });
});
