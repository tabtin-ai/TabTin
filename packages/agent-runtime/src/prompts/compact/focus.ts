/**
 * 手动 /compact 的用户自定义侧重，追加到摘要 user 指令尾部。
 * 语言：中文，与同目录 user.ts / system.ts 的全中文化约定一致（2026-05-20 决策 4）。
 */
export function buildCompactFocusInstruction(focus: string | undefined): string {
  const trimmed = focus?.trim();
  if (!trimmed) return '';

  return [
    '',
    '本次压缩的用户额外侧重：',
    trimmed,
    '',
    '在保持上述结构化摘要格式的同时，请优先满足这个侧重。',
  ].join('\n');
}
