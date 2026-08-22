import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  guardLocalFile,
  planLocalCloudFolderUpload,
} from './local-file-guard.js';

describe('local-file-guard', () => {
  it('rejects paths outside home/tmp', () => {
    const result = guardLocalFile('/etc/passwd');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'PATH_FORBIDDEN');
    }
  });

  it('plans first-level whitelist files and skips nested/unsupported/empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-folder-'));
    writeFileSync(join(root, 'notes.md'), '# hi');
    writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(root, 'empty.txt'), '');
    writeFileSync(join(root, 'script.js'), 'console.log(1)');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'deep.md'), 'nested');

    const plan = planLocalCloudFolderUpload(root);
    assert.ok('accepted' in plan);
    if (!('accepted' in plan)) return;

    assert.equal(plan.folderName, root.split(/[/\\]/).filter(Boolean).at(-1));
    assert.deepEqual(
      plan.accepted.map((f) => f.fileName).sort(),
      ['data.csv', 'notes.md'],
    );
    assert.ok(plan.skipped.some((s) => s.reason === 'nested'));
    assert.ok(plan.skipped.some((s) => s.reason === 'unsupported_type' && s.fileName === 'script.js'));
    assert.ok(plan.skipped.some((s) => s.reason === 'empty' && s.fileName === 'empty.txt'));
  });

  it('rejects symlink files', () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-symlink-'));
    const target = join(root, 'real.md');
    const link = join(root, 'link.md');
    writeFileSync(target, 'x');
    try {
      symlinkSync(target, link);
    } catch {
      // Windows 无管理员权限时可能失败，跳过
      return;
    }
    const result = guardLocalFile(link);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'SYMLINK_FORBIDDEN');
    }
  });
});
