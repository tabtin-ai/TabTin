export const FENCE_OPEN_HEAD_RE = /^<tool_output(?:\s+[^>]*)?>\n/;
export const FENCE_TAIL = '\n</tool_output>';

export function splitToolOutputFence(
  s: string,
): { open: string; body: string; close: string } | null {
  const openMatch = FENCE_OPEN_HEAD_RE.exec(s);
  if (!openMatch) return null;
  if (!s.endsWith(FENCE_TAIL)) return null;
  const open = openMatch[0];
  if (s.length < open.length + FENCE_TAIL.length) return null;
  const body = s.slice(open.length, s.length - FENCE_TAIL.length);
  return { open, body, close: FENCE_TAIL };
}
