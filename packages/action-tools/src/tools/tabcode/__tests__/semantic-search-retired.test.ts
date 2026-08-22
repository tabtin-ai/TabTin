import { describe, expect, it, vi } from 'vitest';

import { codeSemanticSearchTool } from '../index';

describe('retired semantic_search compatibility export', () => {
  it('returns capability unavailable without making a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await codeSemanticSearchTool.execute({ query: 'where is auth' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('capability_unavailable');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
