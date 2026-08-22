/**
 * Schema helper (`src/tools/schema.ts`) — builder output contracts.
 *
 * Locks that `num({ minimum, maximum })` emits the same keys the validator
 * enforces, without writing them by hand at each tool call site.
 */

import { describe, it, expect } from 'vitest';
import { int, num, obj, str } from '../src/tools/schema.js';

describe('schema helpers — num minimum / maximum', () => {
  it('omits bounds when options are absent', () => {
    expect(num()).toEqual({ type: 'number' });
    expect(num({ description: 'score' })).toEqual({
      type: 'number',
      description: 'score',
    });
  });

  it('emits minimum and maximum when provided', () => {
    expect(num({ minimum: 0, maximum: 1 })).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 1,
    });
  });

  it('preserves default / description alongside bounds', () => {
    expect(
      num({
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'timeout seconds',
      }),
    ).toEqual({
      type: 'number',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'timeout seconds',
    });
  });
});

describe('schema helpers — int minimum / maximum', () => {
  it('emits integer type while preserving numeric options', () => {
    expect(
      int({
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'timeout milliseconds',
      }),
    ).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'timeout milliseconds',
    });
  });
});

describe('schema helpers — str enum / obj additionalProperties', () => {
  it('emits string enum when provided', () => {
    expect(str({ enum: ['a', 'b'] as const })).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
  });

  it('emits allowlisted string format when provided', () => {
    expect(str({ format: 'web-search-freshness' })).toEqual({
      type: 'string',
      format: 'web-search-freshness',
    });
  });

  it('emits additionalProperties schema object when provided', () => {
    expect(
      obj({
        additionalProperties: str(),
      }),
    ).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('still emits additionalProperties boolean false', () => {
    expect(obj({ additionalProperties: false })).toEqual({
      type: 'object',
      additionalProperties: false,
    });
  });
});
