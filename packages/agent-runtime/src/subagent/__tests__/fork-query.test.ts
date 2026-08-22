import { describe, expect, it } from 'vitest';

import {
  buildForkedMessages,
} from '../fork-query.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../../engine/contracts/conversation.js';

describe('buildForkedMessages', () => {
  it('preserves internal markers when cloning full fork history', () => {
    const parentMessages = [
      setInternalMarker(
        { role: 'user', content: 'parent context' },
        INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
      ),
    ];

    const forked = buildForkedMessages(parentMessages, 'task', {
      inheritMode: 'full',
    });

    expect(hasInternalMarker(forked[0]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
  });

  it('does not copy later markers into merged fork messages', () => {
    const parentMessages = [
      setInternalMarker(
        { role: 'user', content: 'before' },
        INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
      ),
      setInternalMarker(
        setInternalMarker(
          { role: 'user', content: 'after' },
          INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
        ),
        INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION,
      ),
    ];

    const forked = buildForkedMessages(parentMessages, 'task', {
      inheritMode: 'filtered',
    });

    expect(forked).toHaveLength(2);
    expect(hasInternalMarker(forked[0]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(hasInternalMarker(forked[0]!, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)).toBe(false);
  });
});
