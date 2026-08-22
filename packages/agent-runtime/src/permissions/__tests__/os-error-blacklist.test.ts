import { describe, expect, it, vi } from 'vitest';
import { OSErrorBlacklist } from '../os-error-blacklist.js';

describe('OSErrorBlacklist', () => {
  it('block + isBlocked 精确匹配 (path, code)', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/Volumes/X', 'OS_PERMISSION_DENIED', 'cached message');
    expect(bl.isBlocked('/Volumes/X', 'OS_PERMISSION_DENIED')).not.toBeNull();
    expect(bl.isBlocked('/Volumes/X', 'OTHER_CODE')).toBeNull();
    expect(bl.isBlocked('/Volumes/Y', 'OS_PERMISSION_DENIED')).toBeNull();
  });

  it('isBlocked 不带 code → 任何 code 命中即返回', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/x', 'OS_PERMISSION_DENIED', 'm');
    expect(bl.isBlocked('/x')).not.toBeNull();
    expect(bl.isBlocked('/y')).toBeNull();
  });

  it('cachedToolErrorMessage 在命中时回传', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/x', 'OS_PERMISSION_DENIED', 'go fix permissions');
    const hit = bl.isBlocked('/x', 'OS_PERMISSION_DENIED')!;
    expect(hit.cachedToolErrorMessage).toBe('go fix permissions');
  });

  it('TTL 过期自动清理', () => {
    vi.useFakeTimers();
    try {
      const bl = new OSErrorBlacklist();
      bl.block('/x', 'CLOUD_NOT_DOWNLOADED', 'msg', 1000);
      expect(bl.isBlocked('/x', 'CLOUD_NOT_DOWNLOADED')).not.toBeNull();
      vi.advanceTimersByTime(1500);
      expect(bl.isBlocked('/x', 'CLOUD_NOT_DOWNLOADED')).toBeNull();
      expect(bl.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear(path) 移除该 path 所有 code', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/x', 'OS_PERMISSION_DENIED', 'm');
    bl.block('/x', 'OS_AV_BLOCKED', 'm');
    bl.block('/y', 'OS_PERMISSION_DENIED', 'm');
    expect(bl.clear('/x')).toBe(2);
    expect(bl.isBlocked('/x')).toBeNull();
    expect(bl.isBlocked('/y')).not.toBeNull();
  });

  it('clear(path) 按路径子树移除 path 维度条目', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/Users/foo/Desktop', 'OS_PERMISSION_DENIED', 'root');
    bl.block('/Users/foo/Desktop/a.txt', 'OS_PERMISSION_DENIED', 'child');
    bl.block('/Users/foo/Desktop/sub/b.txt', 'OS_AV_BLOCKED', 'deep child');
    bl.block('/Users/foo/DesktopX', 'OS_PERMISSION_DENIED', 'sibling prefix');
    bl.block('/Users/foo', 'OS_PERMISSION_DENIED', 'parent');

    expect(bl.clear('/Users/foo/Desktop')).toBe(3);
    expect(bl.isBlocked('/Users/foo/Desktop')).toBeNull();
    expect(bl.isBlocked('/Users/foo/Desktop/a.txt')).toBeNull();
    expect(bl.isBlocked('/Users/foo/Desktop/sub/b.txt')).toBeNull();
    expect(bl.isBlocked('/Users/foo/DesktopX')).not.toBeNull();
    expect(bl.isBlocked('/Users/foo')).not.toBeNull();
  });

  it('clear() 全清', () => {
    const bl = new OSErrorBlacklist();
    bl.block('/x', 'A', 'm');
    bl.block('/y', 'B', 'm');
    expect(bl.clear()).toBe(2);
    expect(bl.size()).toBe(0);
  });

  it('list() 顺手清理过期条目', () => {
    vi.useFakeTimers();
    try {
      const bl = new OSErrorBlacklist();
      bl.block('/x', 'A', 'm', 100);
      bl.block('/y', 'B', 'm');
      vi.advanceTimersByTime(200);
      const list = bl.list();
      expect(list).toHaveLength(1);
      expect(list[0].path).toBe('/y');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('Tool 调用维度', () => {
    it('blockToolCall + isToolCallBlocked → 相同 (name, input) 命中', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('read_file', { path: '/Volumes/X' }, 'OS_PERMISSION_DENIED', 'msg');
      expect(bl.isToolCallBlocked('read_file', { path: '/Volumes/X' })).not.toBeNull();
    });

    it('不同 input → 不命中', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('read_file', { path: '/A' }, 'OS_PERMISSION_DENIED', 'm');
      expect(bl.isToolCallBlocked('read_file', { path: '/B' })).toBeNull();
    });

    it('不同 toolName → 不命中', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('read_file', { path: '/A' }, 'OS_PERMISSION_DENIED', 'm');
      expect(bl.isToolCallBlocked('write_file', { path: '/A' })).toBeNull();
    });

    it('JSON.stringify 失败的 input 仍能编 key', () => {
      const bl = new OSErrorBlacklist();
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      // 不应抛错
      bl.blockToolCall('t', circular, 'X', 'm');
      // 同一个对象再查应命中
      expect(bl.isToolCallBlocked('t', circular)).not.toBeNull();
    });

    it('clearToolCall 精确清掉某个 (name, input)', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('t', { p: 1 }, 'A', 'm');
      bl.blockToolCall('t', { p: 2 }, 'A', 'm');
      const cleared = bl.clearToolCall('t', { p: 1 });
      expect(cleared).toBe(1);
      expect(bl.isToolCallBlocked('t', { p: 1 })).toBeNull();
      expect(bl.isToolCallBlocked('t', { p: 2 })).not.toBeNull();
    });

    it('Tool 维度与 path 维度互不干扰', () => {
      const bl = new OSErrorBlacklist();
      bl.block('/Volumes/X', 'A', 'path-msg');
      bl.blockToolCall('read_file', { path: '/Volumes/X' }, 'A', 'tool-msg');
      // 都该命中
      expect(bl.isBlocked('/Volumes/X', 'A')!.cachedToolErrorMessage).toBe('path-msg');
      expect(bl.isToolCallBlocked('read_file', { path: '/Volumes/X' }, 'A')!.cachedToolErrorMessage).toBe('tool-msg');
    });
  });

  // ── 真实路径解封修复（P0-1）─────────────────────────────────────
  // 修复前：blockToolCall 内部 key 是 `__tool__:<name>:<hash>`，clear(path)
  // 按真实路径查找永远 0 命中，造成 "用户授权后 Agent 仍说没权限" 死循环。
  // 修复后：blockToolCall 接受 originalPath 参数；clearByOriginalPath
  // 按真实路径匹配 entry.originalPath；system.clear 工具同时跑两个清理方法。
  describe('真实路径解封（toolCall 维度的 OS 错误条目）', () => {
    it('blockToolCall 带 originalPath → clearByOriginalPath 命中', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall(
        'read_file',
        { path: '/Users/foo/Desktop/x.txt' },
        'OS_PERMISSION_DENIED',
        'cached llm message',
        undefined,
        '/Users/foo/Desktop/x.txt',
      );
      // toolCall 维度仍能命中
      expect(
        bl.isToolCallBlocked('read_file', { path: '/Users/foo/Desktop/x.txt' }),
      ).not.toBeNull();
      // 按真实路径解封 → 必须命中且清掉
      expect(bl.clearByOriginalPath('/Users/foo/Desktop/x.txt')).toBe(1);
      expect(
        bl.isToolCallBlocked('read_file', { path: '/Users/foo/Desktop/x.txt' }),
      ).toBeNull();
    });

    it('clearByOriginalPath 不命中无 originalPath 的旧条目', () => {
      const bl = new OSErrorBlacklist();
      // 没传 originalPath 的 toolCall 写入 → 解封路径自然 0 命中
      bl.blockToolCall('read_file', { path: '/x' }, 'OS_PERMISSION_DENIED', 'msg');
      expect(bl.clearByOriginalPath('/x')).toBe(0);
    });

    it('多个工具同一路径失败 → clearByOriginalPath 全部清掉', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall(
        'read_file',
        { path: '/Volumes/MyDisk' },
        'OS_PERMISSION_DENIED',
        'm',
        undefined,
        '/Volumes/MyDisk',
      );
      bl.blockToolCall(
        'list_directory',
        { path: '/Volumes/MyDisk' },
        'OS_PERMISSION_DENIED',
        'm',
        undefined,
        '/Volumes/MyDisk',
      );
      expect(bl.clearByOriginalPath('/Volumes/MyDisk')).toBe(2);
      expect(bl.size()).toBe(0);
    });

    it('clearByOriginalPath 不命中其他路径', () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall(
        'read_file',
        { path: '/A' },
        'C',
        'm',
        undefined,
        '/A',
      );
      expect(bl.clearByOriginalPath('/B')).toBe(0);
      expect(bl.size()).toBe(1);
    });
  });
});
