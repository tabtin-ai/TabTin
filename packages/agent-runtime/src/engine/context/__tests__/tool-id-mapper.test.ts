import { describe, expect, it } from 'vitest';

import {
  ToolIdMapper,
  allocateTabtinToolUseId,
  isTabtinToolUseId,
} from '../tool-id-mapper.js';

describe('ToolIdMapper ', () => {
  it('maps the same model id to one tabtin id within a mapper', () => {
    const mapper = new ToolIdMapper();
    const a = mapper.allocate('run_terminal_command_41');
    const b = mapper.allocate('run_terminal_command_41');
    expect(isTabtinToolUseId(a)).toBe(true);
    expect(a).toBe(b);
    expect(mapper.size).toBe(1);
  });

  it('gives different tabtin ids across independent mappers for the same model id', () => {
    const first = new ToolIdMapper().allocate('run_terminal_command_41');
    const second = new ToolIdMapper().allocate('run_terminal_command_41');
    expect(first).not.toBe(second);
    expect(isTabtinToolUseId(first)).toBe(true);
    expect(isTabtinToolUseId(second)).toBe(true);
  });

  it('preserves already-tabtin ids', () => {
    const existing = allocateTabtinToolUseId();
    const mapper = new ToolIdMapper();
    expect(mapper.allocate(existing)).toBe(existing);
  });

  it('allocates a fresh id for empty model id', () => {
    const mapper = new ToolIdMapper();
    const a = mapper.allocate('');
    const b = mapper.allocate(null);
    expect(isTabtinToolUseId(a)).toBe(true);
    expect(isTabtinToolUseId(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(mapper.size).toBe(0);
  });
});
