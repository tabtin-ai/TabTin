/**
 * Phase 2 path-aware plan draft guard — 单元测试矩阵。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  evaluateAgentModeToolAccess,
  isPlanDraftPath,
  extractToolPath,
  hasSuspiciousWindowsPathPattern,
  buildModeDisallowedPathError,
} from '@tabtin/agent-modes';

const writeFile = { name: 'write_file', isReadOnly: false };
const editFile = { name: 'edit_file', isReadOnly: false };
const deleteFile = { name: 'delete_file', isReadOnly: false };

describe('isPlanDraftPath / permission-path', () => {
  let tmpDir: string;
  let wsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-path-'));
    wsRoot = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows .md absolute and relative paths', () => {
    expect(isPlanDraftPath('/tmp/notes/draft.md', wsRoot)).toBe(true);
    expect(isPlanDraftPath('notes/draft.md', wsRoot)).toBe(true);
  });

  it('allows .canvas.tsx paths', () => {
    expect(isPlanDraftPath('viz/board.canvas.tsx', wsRoot)).toBe(true);
  });

  it('denies .ts / .json / no extension', () => {
    expect(isPlanDraftPath('src/index.ts', wsRoot)).toBe(false);
    expect(isPlanDraftPath('package.json', wsRoot)).toBe(false);
    expect(isPlanDraftPath('Makefile', wsRoot)).toBe(false);
  });

  it('denies empty / null path', () => {
    expect(isPlanDraftPath('', wsRoot)).toBe(false);
    expect(isPlanDraftPath(null, wsRoot)).toBe(false);
    expect(isPlanDraftPath(undefined, wsRoot)).toBe(false);
  });

  it('denies symlink chain when target is non-draft extension', () => {
    const secret = path.join(wsRoot, 'secret.ts');
    fs.writeFileSync(secret, '// ts');
    const linkMd = path.join(wsRoot, 'link.md');
    fs.symlinkSync(secret, linkMd);
    expect(isPlanDraftPath(linkMd, wsRoot)).toBe(false);
  });

  it('allows symlink chain when target is .md', () => {
    const realMd = path.join(wsRoot, 'real.md');
    fs.writeFileSync(realMd, '# ok');
    const linkMd = path.join(wsRoot, 'link.md');
    fs.symlinkSync(realMd, linkMd);
    expect(isPlanDraftPath(linkMd, wsRoot)).toBe(true);
  });

  it('denies dangling symlink when ancestor resolves to non-draft', () => {
    const dangling = path.join(wsRoot, 'data', 'evil.md');
    fs.mkdirSync(path.join(wsRoot, 'data'), { recursive: true });
    fs.symlinkSync(path.join(wsRoot, 'missing.ts'), dangling);
    expect(isPlanDraftPath(dangling, wsRoot)).toBe(false);
  });

  it('denies Windows ADS pattern on win32', () => {
    if (process.platform !== 'win32') {
      expect(hasSuspiciousWindowsPathPattern('foo.md:hidden')).toBe(false);
      return;
    }
    expect(isPlanDraftPath('foo.md:hidden', wsRoot)).toBe(false);
  });

  it('denies UNC paths', () => {
    expect(isPlanDraftPath('\\\\server\\share\\foo.md', wsRoot)).toBe(false);
    expect(isPlanDraftPath('//server/share/foo.md', wsRoot)).toBe(false);
  });

  it('denies 8.3 short filename pattern', () => {
    expect(isPlanDraftPath('DRAFT~1.MD', wsRoot)).toBe(false);
  });

  it('denies .. traversal target outside draft semantics when resolved path is .ts', () => {
    const outside = path.join(wsRoot, '..', 'outside.ts');
    expect(isPlanDraftPath(outside, wsRoot)).toBe(false);
  });

  it('denies directory symlink escape to outside workspace (dir-link → /etc)', () => {
    if (process.platform === 'win32') return;
    const etcDir = '/etc';
    if (!fs.existsSync(etcDir)) return;
    const dirLink = path.join(wsRoot, 'dir-link');
    fs.symlinkSync(etcDir, dirLink);
    expect(isPlanDraftPath('dir-link/foo.md', wsRoot)).toBe(false);
  });

  it('allows directory symlink within workspace (dir-link → workspace/sub)', () => {
    const subDir = path.join(wsRoot, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const dirLink = path.join(wsRoot, 'dir-link');
    fs.symlinkSync(subDir, dirLink);
    expect(isPlanDraftPath('dir-link/foo.md', wsRoot)).toBe(true);
  });
});

describe('evaluateAgentModeToolAccess path-aware (plan/study)', () => {
  const mdPath = '/workspace/draft.md';
  const tsPath = '/workspace/src/a.ts';

  it('plan + write_file(draft.md) → allow', () => {
    const r = evaluateAgentModeToolAccess({
      tool: writeFile,
      toolInput: { path: mdPath },
      agentMode: 'plan',
      workspaceRoot: '/workspace',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('plan + write_file(a.ts) → deny mode_disallowed_path', () => {
    const r = evaluateAgentModeToolAccess({
      tool: writeFile,
      toolInput: { path: tsPath },
      agentMode: 'plan',
      workspaceRoot: '/workspace',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('mode_disallowed_path');
      expect(r.error.remediation.action).toBe('change_path');
    }
  });

  it('buildModeDisallowedPathError remediation uses change_path', () => {
    const err = buildModeDisallowedPathError({
      agentMode: 'plan',
      toolName: 'write_file',
      path: 'src/a.ts',
      pathExtension: '.ts',
    });
    expect(err.remediation.action).toBe('change_path');
    expect(err.remediation.suggested_extension).toBe('.md');
  });

  it('study + edit_file(draft.canvas.tsx) → allow', () => {
    const r = evaluateAgentModeToolAccess({
      tool: editFile,
      toolInput: { path: 'board.canvas.tsx' },
      agentMode: 'study',
      workspaceRoot: '/workspace',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('plan + delete_file(draft.md) → deny (delete never allowed)', () => {
    const r = evaluateAgentModeToolAccess({
      tool: deleteFile,
      toolInput: { path: mdPath },
      agentMode: 'plan',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('mode_disallowed_tool');
    }
  });

  it('ask + write_file(draft.md) → deny mode_disallowed_tool', () => {
    const r = evaluateAgentModeToolAccess({
      tool: writeFile,
      toolInput: { path: mdPath },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('mode_disallowed_tool');
    }
  });

  it('plan + tabdoc_update_document without active plan → no_active_plan (target gate)', () => {
    const r = evaluateAgentModeToolAccess({
      tool: { name: 'tabdoc_update_document', isReadOnly: false },
      toolInput: { document_id: 'doc-1' },
      agentMode: 'plan',
      sessionId: 's1',
      activePlanTracker: { getActivePlan: () => null },
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('no_active_plan');
    }
  });

  it('extractToolPath reads path / file_path / file', () => {
    expect(extractToolPath(writeFile, { path: ' a.md ' })).toBe('a.md');
    expect(extractToolPath(writeFile, { file_path: 'b.md' })).toBe('b.md');
    expect(extractToolPath(writeFile, { file: 'c.md' })).toBe('c.md');
    expect(extractToolPath(writeFile, { path: '' })).toBeUndefined();
    expect(extractToolPath(writeFile, null)).toBeUndefined();
  });

  it('plan + write_file when path resolution fails → path_resolution_failed (fail-closed)', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw new Error('EACCES simulated');
    });
    try {
      const r = evaluateAgentModeToolAccess({
        tool: writeFile,
        toolInput: { path: 'notes/draft.md' },
        agentMode: 'plan',
        workspaceRoot: '/workspace',
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) {
        expect(r.error.deny_code).toBe('path_resolution_failed');
      }
    } finally {
      existsSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it('plan + write_file via dir symlink to /etc → deny (workspace escape)', () => {
    if (process.platform === 'win32') return;
    const etcDir = '/etc';
    if (!fs.existsSync(etcDir)) return;
    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-judge-'));
      const ws = fs.realpathSync(tmpDir);
      fs.symlinkSync(etcDir, path.join(ws, 'dir-link'));
      const r = evaluateAgentModeToolAccess({
        tool: writeFile,
        toolInput: { path: 'dir-link/foo.md' },
        agentMode: 'plan',
        workspaceRoot: ws,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) {
        expect(r.error.deny_code).toBe('mode_disallowed_path');
      }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
