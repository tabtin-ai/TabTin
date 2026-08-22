import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installSkillFromBundle,
  replaceDirAtomically,
  type ReplaceDirFs,
} from '../../src/skills/skill-installer.js';
import {
  resolveDataRoot,
  resolveOrganizationSkillDir,
  resolvePlatformDataRoot,
  resolveSpaceSkillDir,
  resolveUserSkillDir,
} from '@tabtin/terminal-core';

describe('skill installer target roots', () => {
  it('rejects legacy global target by default', async () => {
    const result = await installSkillFromBundle({
      skillKey: 'demo',
      files: [],
      targetDir: join(homedir(), '.tabtin', 'skills', 'demo'),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('targetDir outside safe root');
  });

  it('accepts legacy global target only for explicit migration/import callers', async () => {
    const result = await installSkillFromBundle({
      skillKey: 'demo',
      files: [],
      targetDir: join(homedir(), '.tabtin', 'skills', 'demo'),
      allowLegacyGlobalForMigration: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No files provided for installation');
  });

  it('accepts per-Space platform-data targets by default (legacy compat)', async () => {
    const result = await installSkillFromBundle({
      skillKey: 'demo',
      files: [],
      targetDir: resolveSpaceSkillDir(resolvePlatformDataRoot(), 'wt-1', 'space-1', 'demo'),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No files provided for installation');
  });

  it('accepts new user-scoped dataRoot targets ()', async () => {
    const result = await installSkillFromBundle({
      skillKey: 'demo',
      files: [],
      targetDir: resolveUserSkillDir(resolveDataRoot(), 'u1', 'demo'),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No files provided for installation');
  });

  it('accepts new organization-scoped dataRoot targets ()', async () => {
    const result = await installSkillFromBundle({
      skillKey: 'demo',
      files: [],
      targetDir: resolveOrganizationSkillDir(resolveDataRoot(), 'u1', 'org-a', 'demo'),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No files provided for installation');
  });
});

describe('replaceDirAtomically ( Windows EPERM)', () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeScratch(): Promise<{ root: string; tmpDir: string; targetDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'skill-install-'));
    scratchDirs.push(root);
    const tmpDir = join(root, '.tmp-demo-1');
    const targetDir = join(root, 'demo');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, 'SKILL.md'), '# new content\n', 'utf-8');
    return { root, tmpDir, targetDir };
  }

  function eperm(op: string, pathHint: string): NodeJS.ErrnoException {
    const err = new Error(`EPERM: operation not permitted, ${op} '${pathHint}'`) as NodeJS.ErrnoException;
    err.code = 'EPERM';
    return err;
  }

  it('falls back to cp when rename(tmp→target) keeps returning EPERM', async () => {
    const { tmpDir, targetDir } = await makeScratch();
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# old content\n', 'utf-8');

    const realFs = await import('node:fs/promises');
    let renameCalls = 0;
    const fs: ReplaceDirFs = {
      rename: async (from, to) => {
        renameCalls += 1;
        // First call parks old target aside (allow). Subsequent tmp→target all EPERM.
        if (String(from) === targetDir) {
          return realFs.rename(from, to);
        }
        throw eperm('rename', `${from} -> ${to}`);
      },
      rm: realFs.rm.bind(realFs),
      cp: realFs.cp.bind(realFs),
      access: realFs.access.bind(realFs),
      sleep: async () => {},
    };

    await replaceDirAtomically(tmpDir, targetDir, 'demo', fs);

    const content = await readFile(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('# new content\n');
    // 1 park-aside + 3 failed tmp→target retries
    expect(renameCalls).toBeGreaterThanOrEqual(4);

    await expect(realFs.access(tmpDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('succeeds via rename when no lock (happy path)', async () => {
    const { tmpDir, targetDir } = await makeScratch();
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# old\n', 'utf-8');

    await replaceDirAtomically(tmpDir, targetDir, 'demo');

    const content = await readFile(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('# new content\n');
  });

  it('surfaces code + paths when rename and cp both fail', async () => {
    const { tmpDir, targetDir } = await makeScratch();

    const fs: ReplaceDirFs = {
      rename: async () => {
        throw eperm('rename', `${tmpDir} -> ${targetDir}`);
      },
      rm: async () => {},
      cp: async () => {
        throw eperm('cp', `${tmpDir} -> ${targetDir}`);
      },
      access: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      sleep: async () => {},
    };

    await expect(replaceDirAtomically(tmpDir, targetDir, 'demo', fs)).rejects.toThrow(
      /rename failed \[EPERM\].*cp-fallback failed \[EPERM\]/,
    );
  });

  it('retries transient EPERM then succeeds on rename', async () => {
    const { tmpDir, targetDir } = await makeScratch();
    const realFs = await import('node:fs/promises');
    let failuresLeft = 2;
    const sleepSpy = vi.fn(async () => {});

    const fs: ReplaceDirFs = {
      rename: async (from, to) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw eperm('rename', `${from}`);
        }
        return realFs.rename(from, to);
      },
      rm: realFs.rm.bind(realFs),
      cp: realFs.cp.bind(realFs),
      access: realFs.access.bind(realFs),
      sleep: sleepSpy,
    };

    await replaceDirAtomically(tmpDir, targetDir, 'demo', fs);

    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf-8')).toBe('# new content\n');
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it('restores parked .old-* when rename and cp both fail', async () => {
    const { tmpDir, targetDir } = await makeScratch();
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# old content\n', 'utf-8');

    const realFs = await import('node:fs/promises');
    let parkedAside = false;
    const fs: ReplaceDirFs = {
      rename: async (from, to) => {
        // Allow park-aside once, then block tmp→target; allow restore (.old-* → target).
        if (!parkedAside && String(from) === targetDir) {
          parkedAside = true;
          return realFs.rename(from, to);
        }
        if (parkedAside && String(to) === targetDir && String(from) !== tmpDir) {
          return realFs.rename(from, to);
        }
        throw eperm('rename', `${from} -> ${to}`);
      },
      rm: realFs.rm.bind(realFs),
      cp: async () => {
        throw eperm('cp', `${tmpDir} -> ${targetDir}`);
      },
      access: realFs.access.bind(realFs),
      sleep: async () => {},
    };

    await expect(replaceDirAtomically(tmpDir, targetDir, 'demo', fs)).rejects.toThrow(/EPERM/);
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf-8')).toBe('# old content\n');
  });
});
