/**
 * System prompt text helpers live with context/prompt assembly, not the run
 * state machine. Core code may consume these helpers but should not own them.
 */
import type {
  SystemBlock,
} from '../contracts/conversation.js';

export function flattenSystemPrompt(input: string | SystemBlock[] | undefined): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  return input.map((block) => block.text).join('\n\n');
}
