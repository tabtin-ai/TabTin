export type ProjectionQuality = 'complete' | 'partial' | 'failed';

export interface TerminalToolProjectionInput {
  toolCallId: string;
  command?: string;
  output: unknown;
  isError?: boolean;
  sessionId?: string;
}

export interface TerminalToolProjectionBlock {
  type: 'metadata';
  kind: 'model_projection';
  projection_type: 'tool';
  tool_call_id: string;
  tool_name: 'run_terminal_command';
  quality: ProjectionQuality;
  raw_ref: string;
  text: string;
  payload: {
    status: string;
    command?: string;
    facts: string[];
    output_refs: string[];
  };
}

const MAX_FACTS = 12;
const MAX_VALUE_CHARS = 120;
const MAX_PREVIEW_CHARS = 400;

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : undefined;
}

function parseJsonRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== 'string') return undefined;
  try {
    return readRecord(JSON.parse(input));
  } catch {
    return undefined;
  }
}

function buildRawRef(sessionId: string | undefined, toolCallId: string): string {
  return sessionId
    ? `tool-log://${sessionId}/${toolCallId}`
    : `tool-log://current-session/${toolCallId}`;
}

function shortenValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_VALUE_CHARS
      ? `${trimmed.slice(0, MAX_VALUE_CHARS)}...`
      : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return undefined;
}

function collectScalarFacts(record: Record<string, unknown>, prefix = ''): string[] {
  const facts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (facts.length >= MAX_FACTS) break;
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = readRecord(value);
    if (nested) {
      const nestedFacts = collectScalarFacts(nested, path);
      for (const fact of nestedFacts) {
        if (facts.length >= MAX_FACTS) break;
        facts.push(fact);
      }
      continue;
    }
    const short = shortenValue(value);
    if (short) facts.push(`${path}=${short}`);
  }
  return facts;
}

function collectOutputRefs(envelope: Record<string, unknown>): string[] {
  const refs = [
    readString(envelope.full_output_path),
    readString(envelope.output_file),
    readString(envelope.persisted_output_path),
  ].filter((ref): ref is string => !!ref);
  return Array.from(new Set(refs));
}

function parseStdoutFacts(envelope: Record<string, unknown>): string[] {
  const stdout = readString(envelope.stdout);
  if (!stdout) return [];

  const parsedStdout = parseJsonRecord(stdout);
  if (parsedStdout) return collectScalarFacts(parsedStdout);

  const truncated = envelope.stdout_truncated === true || stdout.length > MAX_PREVIEW_CHARS;
  if (truncated) return ['stdout=omitted; use raw_ref for exact evidence'];
  return [`stdout_preview=${stdout.slice(0, MAX_PREVIEW_CHARS)}`];
}

function determineQuality(
  envelope: Record<string, unknown> | undefined,
  isError: boolean | undefined,
): ProjectionQuality {
  if (isError) return 'failed';
  const status = readString(envelope?.status);
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'running' || envelope?.stdout_truncated === true) return 'partial';
  return 'complete';
}

export function projectTerminalToolResult(
  input: TerminalToolProjectionInput,
): TerminalToolProjectionBlock {
  const envelope = parseJsonRecord(input.output);
  const rawRef = buildRawRef(input.sessionId, input.toolCallId);
  const status = readString(envelope?.status) ?? (input.isError ? 'failed' : 'completed');
  const quality = determineQuality(envelope, input.isError);
  const outputRefs = envelope ? collectOutputRefs(envelope) : [];

  const facts = [
    envelope?.exit_code !== undefined ? `exit_code=${String(envelope.exit_code)}` : undefined,
    envelope?.pattern_matched !== undefined ? `pattern_matched=${String(envelope.pattern_matched)}` : undefined,
    ...parseStdoutFacts(envelope ?? {}),
  ].filter((fact): fact is string => !!fact).slice(0, MAX_FACTS);

  const text = [
    'Tool Projection (run_terminal_command)',
    `Status: ${status}.`,
    `Quality: ${quality}.`,
    input.command ? `Command: ${input.command}` : undefined,
    facts.length > 0 ? `Facts: ${facts.join('; ')}.` : 'Facts: no structured facts extracted.',
    outputRefs.length > 0 ? `Output refs: ${outputRefs.join(', ')}.` : undefined,
    `raw_ref=${rawRef}`,
  ].filter((part): part is string => !!part).join('\n');

  return {
    type: 'metadata',
    kind: 'model_projection',
    projection_type: 'tool',
    tool_call_id: input.toolCallId,
    tool_name: 'run_terminal_command',
    quality,
    raw_ref: rawRef,
    text,
    payload: {
      status,
      command: input.command,
      facts,
      output_refs: outputRefs,
    },
  };
}
