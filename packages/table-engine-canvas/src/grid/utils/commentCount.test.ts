import { describe, expect, it } from 'vitest';
import {
  getCommentCountBounds,
  getRowDetailButtonBounds,
  resolveCellCommentCount,
} from './commentCount';

describe('comment count tag', () => {
  it('resolves UUID record ids without truncating at hyphens', () => {
    expect(
      resolveCellCommentCount(
        { id: 'record-1234-field-title' },
        { id: 'field-title', name: 'Title', isPrimary: true },
        { 'record-1234': 3 },
      ),
    ).toEqual({ recordId: 'record-1234', count: 3 });
  });

  it('places the tag at the end of the primary cell', () => {
    expect(
      getCommentCountBounds({ x: 50, y: 20, width: 200, height: 32 }),
    ).toEqual({
      x: 226,
      y: 28,
      width: 18,
      height: 16,
    });
  });

  it('moves the detail button before the comment tag', () => {
    const cellBounds = { x: 50, y: 20, width: 200, height: 32 };

    expect(getRowDetailButtonBounds(cellBounds, true)).toEqual({
      x: 206,
      y: 28,
      width: 16,
      height: 16,
    });
    expect(getRowDetailButtonBounds(cellBounds, false).x).toBe(230);
  });
});
