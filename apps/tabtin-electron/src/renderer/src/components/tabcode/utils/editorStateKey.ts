import type { TextEditorState } from '@components/shared/file-preview/TextFileEditor';

export function editorStateKey(
  sessionKey: string,
  groupId: string,
  filePath: string,
): string {
  return JSON.stringify([sessionKey, groupId, filePath]);
}

export function editorStateKeyParts(key: string): {
  sessionKey: string;
  groupId: string;
  filePath: string;
} | null {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) &&
      parts.length === 3 &&
      parts.every((part) => typeof part === 'string')
      ? { sessionKey: parts[0], groupId: parts[1], filePath: parts[2] }
      : null;
  } catch {
    return null;
  }
}

export function dirtyEditorStatesForFile(
  states: ReadonlyMap<string, TextEditorState> | undefined,
  sessionKey: string,
  filePath: string,
): Array<[string, TextEditorState]> {
  return Array.from(states?.entries() ?? []).filter(([key, state]) => {
    const parts = editorStateKeyParts(key);
    return (
      parts?.sessionKey === sessionKey &&
      parts.filePath === filePath &&
      state.dirty
    );
  });
}
