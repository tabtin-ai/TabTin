/**
 * Diagnostic 数据类型。
 */

export interface Diagnostic {
  message: string;
  /** Mapped from LSP severity 1-4 (Error/Warning/Info/Hint). Default 'Error'. */
  severity: 'Error' | 'Warning' | 'Info' | 'Hint';
  range: {
    /** 0-based line/character per LSP protocol. Renderer +1 → 1-based. */
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** LSP server name or rule source (e.g. 'typescript', 'eslint') */
  source?: string;
  /** LSP error code (TS2322 / E001 etc.). Always stringified. */
  code?: string;
}

export interface DiagnosticFile {
  /** Original LSP URI (e.g. `file:///path/to/foo.ts`) or path */
  uri: string;
  diagnostics: Diagnostic[];
}
