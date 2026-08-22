import { describe, expect, it } from 'vitest';

import { buildRecordResourceLink } from './recordResourceLink';

describe('buildRecordResourceLink', () => {
  it('builds a stable context-free production TabData record link', () => {
    const link = buildRecordResourceLink(
      '529c0808-44c2-489f-baf2-71732bb7d76b',
      '1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa',
      { apiBaseUrl: 'https://api.example.com/api', buildProfile: 'production' },
    );

    expect(link).toBe(
      'tabtin://resource/table/529c0808-44c2-489f-baf2-71732bb7d76b?hint=tabdata&recordIds=1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa',
    );
    expect(link).not.toContain('spaceId');
    expect(link).not.toContain('workspaceId');
  });

  it.each([
    ['https://api.example.com/api', 'production', 'tabtin://'],
    ['https://api-test.example.com/api', 'preprod', 'tabtin-preprod://'],
    ['https://api-test.example.com/api', 'development', 'tabtin-preprod://'],
    ['http://127.0.0.1:6060/api', 'development', 'tabtin-dev://'],
    ['http://localhost:6060/api', 'development', 'tabtin-dev://'],
    ['http://192.168.1.20:6060/api', 'local', 'tabtin-dev://'],
  ])(
    'maps API data source %s to %s record links',
    (apiBaseUrl, buildProfile, expectedPrefix) => {
      const link = buildRecordResourceLink('table-id', 'record-id', {
        apiBaseUrl,
        buildProfile,
      });

      expect(link.startsWith(expectedPrefix)).toBe(true);
      expect(link.startsWith('tabtin-local://')).toBe(false);
    },
  );
});
