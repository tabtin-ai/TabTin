export interface AutoRespondRule {
  /** Case-insensitive substring to match in cleaned PTY output */
  pattern: string;
  /** Response to write back to the PTY (supports \\n, \\r, \\t escape sequences) */
  response: string;
}

export interface AutoRespondMatch {
  matched: boolean;
  response?: string;
}
