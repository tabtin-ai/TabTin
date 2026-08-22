import { describe, expect, it } from 'vitest';

import {
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
} from '../src/browser';

describe('terminal-core browser entry', () => {
  it('exports browser-safe conversation path helpers', () => {
    expect(resolveSpaceConversationsRoot('/platform-data', 'org-1', 'space-1'))
      .toBe('/platform-data/org-1/spaces/space-1/conversations');
    expect(resolveSpaceSessionArchiveDir('/platform-data', 'org-1', 'space-1'))
      .toBe('/platform-data/org-1/spaces/space-1/conversations/sessions');
    expect(resolveSpaceToolLogsDir('/platform-data', 'org-1', 'space-1'))
      .toBe('/platform-data/org-1/spaces/space-1/conversations/tool-logs');
  });
});
