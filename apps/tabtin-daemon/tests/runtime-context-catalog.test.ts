import { describe, expect, it } from 'vitest';

import { RuntimeContextCatalog } from '../src/application/agent/runtime/daemon-runtime-assembly.js';

describe('RuntimeContextCatalog', () => {
  it('keeps organization portraits isolated and supports scoped invalidation', () => {
    const catalog = new RuntimeContextCatalog();
    catalog.setUserPortrait('org-a', 'A');
    catalog.setUserPortrait('org-b', 'B');

    catalog.invalidateUserPortrait('org-a');

    expect(catalog.getUserPortrait('org-a')).toBeUndefined();
    expect(catalog.getUserPortrait('org-b')?.value).toBe('B');
  });

  it('resolves a session template view without mutating the shared space catalog', () => {
    const catalog = new RuntimeContextCatalog();
    catalog.commitTemplates('space-1', [
      { id: 'role-a' },
      { id: 'role-b' },
    ] as never);
    catalog.setGroupRoleIds('session-1', new Set(['role-b']));

    expect([...catalog.resolveTemplates('session-1', 'space-1')!.keys()]).toEqual(['role-b']);
    expect([...catalog.resolveTemplates('session-2', 'space-1')!.keys()]).toEqual(['role-a', 'role-b']);
  });

  it('owns CLI cache invalidation independently for reference and risk schemas', () => {
    const catalog = new RuntimeContextCatalog();
    catalog.setCliReference('commands');
    catalog.setCliCommands([]);

    catalog.invalidateCliReference();

    expect(catalog.getCliReference()).toBeNull();
    expect(catalog.getCliCommands()?.value).toEqual([]);
  });
});
