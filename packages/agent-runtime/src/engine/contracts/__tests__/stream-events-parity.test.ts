/**
 * Runtime StreamEvents ↔ @tabtin/agent-wire 常量 parity（ /  Stage 5b）。
 */

import { describe, expect, it } from 'vitest';
import {
  ContentBlockEvents as WireContentBlockEvents,
  PROTOCOL_VERSION_V2 as WireProtocolV2,
  StreamEvents as WireStreamEvents,
} from '@tabtin/agent-wire';

import {
  ContentBlockEvents,
  PROTOCOL_VERSION_V2,
  StreamEvents,
} from '../stream-events.js';

describe('stream-events parity with agent-wire', () => {
  it('StreamEvents key/value sets are byte-equal', () => {
    expect(Object.keys(StreamEvents).sort()).toEqual(Object.keys(WireStreamEvents).sort());
    for (const key of Object.keys(StreamEvents) as Array<keyof typeof StreamEvents>) {
      expect(StreamEvents[key]).toBe(WireStreamEvents[key]);
    }
  });

  it('ContentBlockEvents key/value sets are byte-equal', () => {
    expect(Object.keys(ContentBlockEvents).sort()).toEqual(
      Object.keys(WireContentBlockEvents).sort(),
    );
    for (const key of Object.keys(ContentBlockEvents) as Array<
      keyof typeof ContentBlockEvents
    >) {
      expect(ContentBlockEvents[key]).toBe(WireContentBlockEvents[key]);
    }
  });

  it('PROTOCOL_VERSION_V2 matches', () => {
    expect(PROTOCOL_VERSION_V2).toBe(WireProtocolV2);
  });
});
