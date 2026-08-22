/**
 * shell-bridge-contract ↔ @tabtin/terminal-core 关键常量/行为 parity（ /  Stage 6e）。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS as WireTimeout,
  DEDUP_WINDOW_MS as WireDedup,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER as WireMarker,
  detectUnquotedWorkspacePath as wireDetect,
  resolveAgentShellInfo as wireResolveShell,
} from '@tabtin/terminal-core';

import {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  DEDUP_WINDOW_MS,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER,
  detectUnquotedWorkspacePath,
  resolveAgentShellInfo,
} from '../shell-bridge-contract.js';

describe('shell-bridge-contract parity with terminal-core', () => {
  it('timeout / dedup / credential marker constants match', () => {
    expect(DEFAULT_AGENT_COMMAND_TIMEOUT_MS).toBe(WireTimeout);
    expect(DEDUP_WINDOW_MS).toBe(WireDedup);
    expect(SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER).toBe(WireMarker);
  });

  it('resolveAgentShellInfo matches for current platform', () => {
    const local = resolveAgentShellInfo();
    const wire = wireResolveShell();
    expect(local.shell).toBe(wire.shell);
    expect(local.kind).toBe(wire.kind);
    expect(local.platform).toBe(wire.platform);
  });

  it('detectUnquotedWorkspacePath matches on spaced workspace paths', () => {
    const command = 'cat /Users/me/My Project/readme.md';
    const protectedPaths = ['/Users/me/My Project'];
    expect(detectUnquotedWorkspacePath(command, protectedPaths, 'bash')).toEqual(
      wireDetect(command, protectedPaths, 'bash'),
    );
    expect(detectUnquotedWorkspacePath(`cat '${protectedPaths[0]}/readme.md'`, protectedPaths, 'bash')).toEqual(
      wireDetect(`cat '${protectedPaths[0]}/readme.md'`, protectedPaths, 'bash'),
    );
  });
});
