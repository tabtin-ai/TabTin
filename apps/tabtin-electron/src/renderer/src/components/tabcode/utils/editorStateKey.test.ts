import { describe, expect, it } from 'vitest';
import {
  editorStateKey,
  editorStateKeyParts,
  dirtyEditorStatesForFile,
} from './editorStateKey';

describe('editorStateKey', () => {
  it('keeps split-pane instances distinct and round-trippable', () => {
    const left = editorStateKey('session', 'left', '/workspace/source.ts');
    const right = editorStateKey('session', 'right', '/workspace/source.ts');

    expect(left).not.toBe(right);
    expect(editorStateKeyParts(left)).toEqual({
      sessionKey: 'session',
      groupId: 'left',
      filePath: '/workspace/source.ts',
    });
  });

  it('retains two dirty buffers for the same file as a conflict', () => {
    const filePath = '/workspace/source.ts';
    const state = {
      dirty: true,
      status: 'idle' as const,
      saveError: null,
      save: async () => true,
    };
    const states = new Map([
      [editorStateKey('session', 'left', filePath), state],
      [editorStateKey('session', 'right', filePath), state],
    ]);

    expect(dirtyEditorStatesForFile(states, 'session', filePath)).toHaveLength(
      2,
    );
  });
});
