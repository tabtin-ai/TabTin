/**
 * LH2-D1 / LH2-D2：sync-account 工具单测。
 *
 * 覆盖：
 *   - buildSyncAccountDir 路径合成 + sanitize
 *   - clearSyncAccountDir 清理 / 幂等 / 范围限定
 *   - listSyncAccountOwners 扫描 + 容错跳过非法目录
 *   - assertValidOwner 字符校验 + agentId 宽松校验
 *   - ownersMatch 比对语义
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildSyncAccountDir,
  clearSyncAccountDir,
  listSyncAccountOwners,
  assertValidOwner,
  ownersMatch,
} from '../src/session/sync-account.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-sync-account-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('buildSyncAccountDir', () => {
  it('合成二级路径 <root>/<userId>/<organizationId>', () => {
    expect(
      buildSyncAccountDir('/tmp/sync', { userId: 'user-A', organizationId: 'wt-1' }),
    ).toBe(path.join('/tmp/sync', 'user-A', 'wt-1'));
  });

  it('支持下划线 + 数字混合 ID', () => {
    expect(
      buildSyncAccountDir('/tmp/s', { userId: 'u_42', organizationId: 'team_99' }),
    ).toBe(path.join('/tmp/s', 'u_42', 'team_99'));
  });

  it.each([
    ['含 /', { userId: 'u/x', organizationId: 'wt' }],
    ['含 ..', { userId: '..', organizationId: 'wt' }],
    ['含 .', { userId: 'a.b', organizationId: 'wt' }],
    ['含空格', { userId: 'a b', organizationId: 'wt' }],
    ['含中文', { userId: '用户', organizationId: 'wt' }],
    ['空字符串', { userId: '', organizationId: 'wt' }],
    ['超长', { userId: 'x'.repeat(129), organizationId: 'wt' }],
    ['organization 含 \\', { userId: 'u', organizationId: 'wt\\x' }],
  ])('拒绝非法 segment: %s', (_label, owner) => {
    expect(() => buildSyncAccountDir('/tmp', owner)).toThrow();
  });
});

describe('clearSyncAccountDir', () => {
  it('目录不存在：no-op，返回 false', async () => {
    const owner = { userId: 'ghost', organizationId: 'gone' };
    const removed = await clearSyncAccountDir(tmpRoot, owner);
    expect(removed).toBe(false);
  });

  it('删除指定账号目录及全部内容，返回 true', async () => {
    const owner = { userId: 'user-A', organizationId: 'wt-1' };
    const dir = buildSyncAccountDir(tmpRoot, owner);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending.jsonl'), '{"id":"x"}\n');
    fs.writeFileSync(path.join(dir, 'archive.jsonl'), '{"id":"y"}\n');

    const removed = await clearSyncAccountDir(tmpRoot, owner);
    expect(removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('只删指定账号目录，不动其他账号目录（LH2-D2 关键约束）', async () => {
    const ownerA = { userId: 'user-A', organizationId: 'wt-1' };
    const ownerB = { userId: 'user-B', organizationId: 'wt-2' };
    const dirA = buildSyncAccountDir(tmpRoot, ownerA);
    const dirB = buildSyncAccountDir(tmpRoot, ownerB);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'pending.jsonl'), 'A');
    fs.writeFileSync(path.join(dirB, 'pending.jsonl'), 'B');

    await clearSyncAccountDir(tmpRoot, ownerA);
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);
    expect(fs.readFileSync(path.join(dirB, 'pending.jsonl'), 'utf-8')).toBe('B');
  });

  it('不联动清理空的 user 父目录（同用户的其他 organization 数据保留）', async () => {
    const owner1 = { userId: 'user-X', organizationId: 'wt-A' };
    const owner2 = { userId: 'user-X', organizationId: 'wt-B' };
    const dir1 = buildSyncAccountDir(tmpRoot, owner1);
    const dir2 = buildSyncAccountDir(tmpRoot, owner2);
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'pending.jsonl'), 'keep');

    await clearSyncAccountDir(tmpRoot, owner1);
    // user-X 父目录还在
    expect(fs.existsSync(path.join(tmpRoot, 'user-X'))).toBe(true);
    // 兄弟 organization 数据保留
    expect(fs.existsSync(dir2)).toBe(true);
    expect(fs.readFileSync(path.join(dir2, 'pending.jsonl'), 'utf-8')).toBe('keep');
  });

  it('非法 owner：抛错（与 build 一致的 sanitize 路径）', async () => {
    await expect(
      clearSyncAccountDir(tmpRoot, { userId: '../escape', organizationId: 'wt' }),
    ).rejects.toThrow();
  });
});

describe('listSyncAccountOwners', () => {
  it('syncRoot 不存在：返回空数组（不抛错）', async () => {
    const owners = await listSyncAccountOwners(path.join(tmpRoot, 'never-created'));
    expect(owners).toEqual([]);
  });

  it('扫描所有 (userId, organizationId) 二元组', async () => {
    const owners = [
      { userId: 'user-A', organizationId: 'wt-1' },
      { userId: 'user-A', organizationId: 'wt-2' },
      { userId: 'user-B', organizationId: 'wt-3' },
    ];
    for (const o of owners) {
      fs.mkdirSync(buildSyncAccountDir(tmpRoot, o), { recursive: true });
    }

    const found = await listSyncAccountOwners(tmpRoot);
    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining(owners.map((o) => expect.objectContaining(o))),
    );
  });

  it('跳过非目录条目（防御历史脏文件 / `.DS_Store` 等）', async () => {
    fs.mkdirSync(buildSyncAccountDir(tmpRoot, { userId: 'real', organizationId: 'wt' }), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tmpRoot, '.DS_Store'), 'mac garbage');
    fs.writeFileSync(path.join(tmpRoot, 'README.txt'), 'docs');

    const found = await listSyncAccountOwners(tmpRoot);
    expect(found).toEqual([{ userId: 'real', organizationId: 'wt' }]);
  });

  it('跳过含非法字符的目录（防御旧版本写入的脏目录）', async () => {
    // 直接 mkdir 一个含 `.` 的目录（绕过 sanitize）
    fs.mkdirSync(path.join(tmpRoot, 'bad.user'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'bad.user', 'wt-1'), { recursive: true });
    // 一个合法的
    fs.mkdirSync(buildSyncAccountDir(tmpRoot, { userId: 'good', organizationId: 'ok' }), {
      recursive: true,
    });

    const found = await listSyncAccountOwners(tmpRoot);
    expect(found).toEqual([{ userId: 'good', organizationId: 'ok' }]);
  });

  it('user 桶下含非目录条目：跳过', async () => {
    const userDir = path.join(tmpRoot, 'user-A');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'misplaced.txt'), 'x');
    fs.mkdirSync(path.join(userDir, 'wt-1'), { recursive: true });

    const found = await listSyncAccountOwners(tmpRoot);
    expect(found).toEqual([{ userId: 'user-A', organizationId: 'wt-1' }]);
  });
});

describe('assertValidOwner', () => {
  it('有效 owner（仅 user/organization）：通过', () => {
    expect(() => assertValidOwner({ userId: 'u-1', organizationId: 'wt-1' })).not.toThrow();
  });

  it('有效 owner（含 agentId）：通过', () => {
    expect(() =>
      assertValidOwner({ userId: 'u-1', organizationId: 'wt-1', agentId: 'agent-x' }),
    ).not.toThrow();
  });

  it('非法 userId：抛错', () => {
    expect(() => assertValidOwner({ userId: '', organizationId: 'wt-1' })).toThrow(/userId/);
  });

  it('非法 organizationId：抛错', () => {
    expect(() => assertValidOwner({ userId: 'u', organizationId: '/etc' })).toThrow(/organizationId/);
  });

  it('agentId 含路径分隔符：抛错', () => {
    expect(() =>
      assertValidOwner({ userId: 'u', organizationId: 'wt', agentId: 'a/b' }),
    ).toThrow(/agentId/);
  });

  it('agentId 含点号：通过（agentId 比 segment 宽松，未来命名空间预留）', () => {
    expect(() =>
      assertValidOwner({ userId: 'u', organizationId: 'wt', agentId: 'agent.tin@1.0' }),
    ).not.toThrow();
  });
});

describe('ownersMatch', () => {
  it('相同 (user, organization)：true，agentId 不影响', () => {
    expect(
      ownersMatch(
        { userId: 'u', organizationId: 'wt', agentId: 'a' },
        { userId: 'u', organizationId: 'wt' },
      ),
    ).toBe(true);
    expect(
      ownersMatch(
        { userId: 'u', organizationId: 'wt', agentId: 'a' },
        { userId: 'u', organizationId: 'wt', agentId: 'b' } as never,
      ),
    ).toBe(true);
  });

  it('userId 不同：false', () => {
    expect(
      ownersMatch({ userId: 'u1', organizationId: 'wt' }, { userId: 'u2', organizationId: 'wt' }),
    ).toBe(false);
  });

  it('organizationId 不同：false', () => {
    expect(
      ownersMatch({ userId: 'u', organizationId: 'wt1' }, { userId: 'u', organizationId: 'wt2' }),
    ).toBe(false);
  });
});
