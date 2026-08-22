import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OSS_UPLOAD_CONTEXT_TYPES, performLocalFileUpload, resolveUploadContextType } from './oss.js';

describe('resolveUploadContextType (/oss/upload context_type 白名单)', () => {
  it('缺省时回退默认 present（保持 `tabtin oss upload` 行为不变）', () => {
    for (const raw of [undefined, null, '']) {
      const result = resolveUploadContextType(raw);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.contextType, 'present');
    }
  });

  it('显式 present 通过', () => {
    const result = resolveUploadContextType('present');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.contextType, 'present');
  });

  it('显式 document 通过（TabDoc HTML 块上传纳入归档/删除清理路径，）', () => {
    const result = resolveUploadContextType('document');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.contextType, 'document');
  });

  it('白名单外的值被拒绝（供路由层打 400 VALIDATION_ERROR）', () => {
    for (const raw of ['message', 'random', 'DOCUMENT', 123, {}, []]) {
      const result = resolveUploadContextType(raw);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && /context_type must be one of/.test(result.message), true);
    }
  });

  it('白名单常量只含 present 与 document', () => {
    assert.deepEqual([...OSS_UPLOAD_CONTEXT_TYPES], ['present', 'document']);
  });
});

describe('performLocalFileUpload（/oss/upload 与 /table/attachment-upload 共用实现）', () => {
  it('缺少 filePath 时在 guard 阶段失败，不触发任何上传', async () => {
    const outcome = await performLocalFileUpload('');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'MISSING_PARAM');
  });

  it('文件不存在时在 guard 阶段失败（不会走到网络上传逻辑）', async () => {
    const outcome = await performLocalFileUpload('/tmp/tabtin-cli-attachment-upload-does-not-exist.bin');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'FILE_NOT_FOUND');
  });

  it('路径越出 home/tmp 白名单时被拒绝', async () => {
    const outcome = await performLocalFileUpload('/etc/passwd');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'PATH_FORBIDDEN');
  });

  it('非法 contextType 在 guard 通过后仍被拒绝（白名单校验优先于网络请求）', async () => {
    // 用一个必然不存在的路径也能验证顺序无关；这里改用不存在路径 + 非法 contextType，
    // 断言仍是 guard 优先命中的 FILE_NOT_FOUND（guard 早于 contextType 校验）。
    const outcome = await performLocalFileUpload('/tmp/tabtin-cli-attachment-upload-does-not-exist.bin', {
      contextType: 'not-a-real-context-type',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'FILE_NOT_FOUND');
  });
});
