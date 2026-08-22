import { describe, expect, it } from 'vitest';
import { getSharedOSErrorBlacklist } from '../src/permissions/os-error-blacklist.js';

describe('Organization-scoped OSErrorBlacklist store', () => {
  it('同一 Organization 复用同一个进程内 store', () => {
    const first = getSharedOSErrorBlacklist('wt-os-error-store-same');
    const second = getSharedOSErrorBlacklist('wt-os-error-store-same');
    first.clear();

    first.block('/Users/test/Desktop', 'OS_PERMISSION_DENIED', 'cached message');

    expect(second).toBe(first);
    expect(second.isBlocked('/Users/test/Desktop', 'OS_PERMISSION_DENIED')?.cachedToolErrorMessage)
      .toBe('cached message');
  });

  it('同 Organization 已存在 runtime handle 在 clear 后立即看到解封', () => {
    const parentHandle = getSharedOSErrorBlacklist('wt-os-error-store-clear-broadcast');
    const childHandle = getSharedOSErrorBlacklist('wt-os-error-store-clear-broadcast');
    parentHandle.clear();

    parentHandle.blockToolCall(
      'read_file',
      { path: '/Users/test/Desktop/a.txt' },
      'OS_PERMISSION_DENIED',
      'cached message',
      undefined,
      '/Users/test/Desktop/a.txt',
    );

    expect(childHandle.isToolCallBlocked(
      'read_file',
      { path: '/Users/test/Desktop/a.txt' },
    )).not.toBeNull();
    expect(childHandle.clearByOriginalPath('/Users/test/Desktop')).toBe(1);
    expect(parentHandle.isToolCallBlocked(
      'read_file',
      { path: '/Users/test/Desktop/a.txt' },
    )).toBeNull();
  });

  it('不同 Organization 使用不同 store，避免跨租户短路泄漏', () => {
    const organizationA = getSharedOSErrorBlacklist('wt-os-error-store-a');
    const organizationB = getSharedOSErrorBlacklist('wt-os-error-store-b');
    organizationA.clear();
    organizationB.clear();

    organizationA.block('/Users/test/Desktop', 'OS_PERMISSION_DENIED', 'cached message');

    expect(organizationB).not.toBe(organizationA);
    expect(organizationB.isBlocked('/Users/test/Desktop', 'OS_PERMISSION_DENIED')).toBeNull();
  });

  it('缺少 Organization 时退回独立实例，不进入公共共享桶', () => {
    const first = getSharedOSErrorBlacklist(undefined);
    const second = getSharedOSErrorBlacklist(undefined);

    first.block('/Users/test/Desktop', 'OS_PERMISSION_DENIED', 'cached message');

    expect(second).not.toBe(first);
    expect(second.isBlocked('/Users/test/Desktop', 'OS_PERMISSION_DENIED')).toBeNull();
  });
});
