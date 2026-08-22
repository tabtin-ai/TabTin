/**
 * Tests for B-02, B-03, CE-P0-01 — package.json field fixes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const tsupConfigRaw = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf-8');

// ── B-02: main / exports / types 指向正确的构建产物 ─────────────

describe('B-02: main/exports/types point to actual build artifacts', () => {
  it('main points to ./dist/index.js', () => {
    expect(pkg.main).toBe('./dist/index.js');
  });

  it('types points to ./dist/index.d.ts', () => {
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  it('exports "." resolves to dist/index.js (import condition)', () => {
    const entry = pkg.exports?.['.'];
    const importPath =
      typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
    expect(importPath).toBe('./dist/index.js');
  });

  it('exports "." includes types condition pointing to dist/index.d.ts', () => {
    const entry = pkg.exports?.['.'];
    if (typeof entry === 'object' && entry !== null) {
      expect(entry.types).toBe('./dist/index.d.ts');
    }
  });

  it('bin still points to ./dist/index.js', () => {
    expect(pkg.bin?.['tabtin-daemon']).toBe('./dist/index.js');
  });

  it('dist/index.js exists on disk (build artifact)', () => {
    expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true);
  });

  it('dist/index.d.ts exists on disk (type declarations)', () => {
    expect(existsSync(join(ROOT, 'dist', 'index.d.ts'))).toBe(true);
  });

  it('dist/daemon.js does NOT exist (old wrong name)', () => {
    expect(existsSync(join(ROOT, 'dist', 'daemon.js'))).toBe(false);
  });
});

// ── B-03: build 脚本使用 tsup.config.ts 作为唯一配置源 ──────────

describe('B-03: build script delegates to tsup.config.ts', () => {
  it('build script typechecks before using the centralized tsup config', () => {
    expect(pkg.scripts.build).toBe('tsc --noEmit && tsup');
  });

  it('build script does not contain --format or --dts flags', () => {
    expect(pkg.scripts.build).not.toMatch(/--format/);
    expect(pkg.scripts.build).not.toMatch(/--dts/);
  });

  it('build script does not re-specify entry (src/index.ts)', () => {
    expect(pkg.scripts.build).not.toContain('src/index.ts');
  });

  it('tsup.config.ts defines format as esm', () => {
    expect(tsupConfigRaw).toContain("format: ['esm']");
  });

  it('tsup.config.ts defines dts: true', () => {
    expect(tsupConfigRaw).toContain('dts: true');
  });

  it('tsup.config.ts entry is src/index.ts', () => {
    expect(tsupConfigRaw).toContain("entry: ['src/index.ts']");
  });
});

// ── CE-P0-01: @tabtin/tabslide 在 dependencies 中声明 ──────────

describe('CE-P0-01: @tabtin/tabslide dependency declared', () => {
  it('@tabtin/tabslide is in dependencies', () => {
    expect(pkg.dependencies).toHaveProperty('@tabtin/tabslide');
  });

  it('@tabtin/tabslide uses workspace protocol', () => {
    expect(pkg.dependencies['@tabtin/tabslide']).toBe('workspace:*');
  });
});

// ── 总体完整性检查 ──────────────────────────────────────────────

describe('package.json overall integrity', () => {
  const requiredTabtinDeps = [
    '@tabtin/action-tools',
    '@tabtin/config',
    '@tabtin/agent-runtime',
    '@tabtin/agent-wire',
    '@tabtin/pty-core',
    '@tabtin/shared',
    '@tabtin/table-kernel',
    '@tabtin/table-kernel-pglite',
    '@tabtin/tabslide',
    '@tabtin/terminal-core',
    '@tabtin/ws-gateway-client',
  ];

  it.each(requiredTabtinDeps)('%s is in dependencies', (dep) => {
    expect(pkg.dependencies).toHaveProperty(dep);
    expect(pkg.dependencies[dep]).toBe('workspace:*');
  });

  it('type is module (ESM)', () => {
    expect(pkg.type).toBe('module');
  });

  it('main, bin, and exports all reference the same entry file', () => {
    const binPath = pkg.bin?.['tabtin-daemon'];
    const mainPath = pkg.main;
    const entry = pkg.exports?.['.'];
    const exportPath =
      typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
    expect(mainPath).toBe(binPath);
    expect(exportPath).toBe(binPath);
  });
});
