import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error audit-packaged-artifact is a Node ESM build script without TS declarations.
import {
  classifyMacNativeAsset,
  evaluateMacNativeArchAssets,
  evaluateWindowsNativeAssets,
  extractEsmImportSpecifiers,
  extractLiteralRuntimeSpecifiers,
  extractRelativeEsmImports,
  extractRelativeJsImports,
  findBundledMcpRemoteHostIssues,
  findUnresolvedPackagedRuntimeImports,
  findUnresolvedTabtinDistRelativeImports,
  resolveRelativeSpecifier,
  findMissingRequiredArtifactSignals,
  hasForbiddenDirectory,
  hasPublicSourceMapReference,
  isEmittedSourceMapComment,
  isNestedBuildOutputPath,
  isNodeBuiltinSpecifier,
  MAC_NATIVE_ARCH_ASSET_SPECS,
  machoArchOf,
  evaluateMacPackagedFilegen,
  normalizeTargetArch,
  scanMacLaunchSmokeWithDeps,
  findMissingPackagedPythonRuntime,
  packagedPythonRuntimePlatform,
  shouldBlockEmbeddedOfficeRuntime,
  shouldRequirePackagedPythonRuntime,
  shouldBlockMacNonDarwinNativePath,
  shouldBlockSourceMapReference,
  WINDOWS_NATIVE_ASSET_SPECS,
} from '../../scripts/audit-packaged-artifact.mjs';

describe('audit-packaged-artifact content checks', () => {
  it('allows skill Tier-3 examples but still blocks other examples directories', () => {
    expect(
      hasForbiddenDirectory(
        'app.asar.unpacked/packages/apps/tabslide/skills/html-spec/examples/page-templates.md',
      ),
    ).toBe(false);
    expect(
      hasForbiddenDirectory(
        'app.asar.unpacked/bundled-skills/platform/visualization/tabtin-widget/examples/html-stepper.md',
      ),
    ).toBe(false);
    expect(
      hasForbiddenDirectory(
        'app.asar.unpacked/package-skills/tabtracker/examples/walkthrough.md',
      ),
    ).toBe(false);
    expect(
      hasForbiddenDirectory('tabsite-templates/react-starter/examples/demo/index.html'),
    ).toBe(true);
    expect(
      hasForbiddenDirectory(
        'app.asar.unpacked/packages/apps/tabslide/skills/html-spec/examples/__tests__/x.md',
      ),
    ).toBe(true);
  });

  it('detects duplicated electron-vite out directories inside app.asar', () => {
    expect(isNestedBuildOutputPath('app.asar/out/out/main/index.mjs')).toBe(true);
    expect(isNestedBuildOutputPath('app.asar\\out\\out\\renderer\\index.html')).toBe(true);
    expect(isNestedBuildOutputPath('app.asar/out/renderer/index.html')).toBe(false);
    expect(isNestedBuildOutputPath('app.asar/out/main/index.mjs')).toBe(false);
  });

  it('extracts relative ESM import specifiers from bundled worker output ', () => {
    const text = [
      `import { parentPort } from "node:worker_threads";`,
      `import { s as serializeWorkerError } from "./protocol-DHc-TGQQ.mjs";`,
      `import { c as computeTextLayerQuality } from './text-layer-quality-SvyEb_eA.mjs';`,
      `import "../shared/side-effect.mjs";`,
      `const lazy = await import("./lazy-chunk-Abc123.mjs");`,
      `import * as pty from "node-pty";`,
      `import path from "node:path";`,
    ].join('\n');

    expect(extractRelativeEsmImports(text).sort()).toEqual([
      '../shared/side-effect.mjs',
      './lazy-chunk-Abc123.mjs',
      './protocol-DHc-TGQQ.mjs',
      './text-layer-quality-SvyEb_eA.mjs',
    ].sort());
  });

  it('requires Stripe OAuth runtime to be fully bundled for clean user machines', () => {
    const entry = 'out/main/mcp-remote-host-process.mjs';
    const proxy = 'out/main/proxy-Abc123.mjs';
    const helper = 'out/main/_commonjsHelpers-Xyz789.mjs';
    const files = new Map([
      [entry, `import { parentPort } from 'node:process'; await import('./proxy-Abc123.mjs');`],
      [proxy, `import path from 'path'; import './_commonjsHelpers-Xyz789.mjs';`],
      [helper, `import { createRequire } from 'node:module';`],
    ]);

    expect(findBundledMcpRemoteHostIssues([...files.keys()], (path) => files.get(path) || '')).toEqual([]);
    expect(isNodeBuiltinSpecifier('node:fs')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true);
    expect(isNodeBuiltinSpecifier('mcp-remote')).toBe(false);
    expect(extractEsmImportSpecifiers(files.get(entry))).toEqual([
      'node:process',
      './proxy-Abc123.mjs',
    ]);
  });

  it('accepts Electron runtime built-ins missing from the packaging host Node', () => {
    const oldHostBuiltinSpecifiers = new Set<string>();
    const entry = 'out/main/mcp-remote-host-process.mjs';
    const proxy = 'out/main/proxy-Abc123.mjs';
    const files = new Map([
      [entry, `import './proxy-Abc123.mjs';`],
      [proxy, `import { DatabaseSync } from 'node:sqlite';`],
    ]);

    expect(isNodeBuiltinSpecifier('node:sqlite', oldHostBuiltinSpecifiers)).toBe(true);
    expect(isNodeBuiltinSpecifier('sqlite', oldHostBuiltinSpecifiers)).toBe(true);
    expect(isNodeBuiltinSpecifier('mcp-remote', oldHostBuiltinSpecifiers)).toBe(false);
    expect(findBundledMcpRemoteHostIssues([...files.keys()], (path) => files.get(path) || '')).toEqual([]);
  });

  it('blocks unresolved bare imports in packaged main and preload code', () => {
    const files = [
      {
        path: 'app.asar.unpacked/out/main/index.mjs',
        text: `import 'electron'; import 'node:fs'; import 'node-pty'; import '@scope/runtime/subpath';`,
      },
      {
        path: 'app.asar/out/preload/index.cjs',
        text: `const electron = require('electron'); require('missing-runtime');`,
      },
    ];
    const available = [
      'node_modules/node-pty/package.json',
      'node_modules/@scope/runtime/package.json',
    ];

    expect(extractLiteralRuntimeSpecifiers(files[1].text)).toEqual([
      'electron',
      'missing-runtime',
    ]);
    expect(findUnresolvedPackagedRuntimeImports(files, available)).toEqual([
      'app.asar/out/preload/index.cjs → missing runtime package "missing-runtime" (missing-runtime)',
    ]);
  });

  it('blocks missing or externally resolved Stripe OAuth runtime dependencies', () => {
    const entry = 'out/main/mcp-remote-host-process.mjs';

    expect(findBundledMcpRemoteHostIssues([], () => '')).toEqual([
      `missing app.asar.unpacked/${entry}`,
    ]);
    expect(
      findBundledMcpRemoteHostIssues(
        [entry],
        () => `await import('mcp-remote/dist/proxy.js'); import './missing-chunk.mjs';`,
      ),
    ).toEqual([
      `${entry} → bare runtime import "mcp-remote/dist/proxy.js"`,
      `${entry} → missing ./missing-chunk.mjs`,
    ]);
  });

  it('detects missing @tabtin dist relative chunks in asar ', () => {
    const indexText = 'import { matchSensitivePath } from "./chunk-E3XO57H6.js";\n';
    const paths = [
      'node_modules/@tabtin/terminal-core/dist/index.js',
      'node_modules/@tabtin/terminal-core/dist/chunk-AHNSL3UH.js',
    ];
    const textByPath = new Map([
      ['node_modules/@tabtin/terminal-core/dist/index.js', indexText],
    ]);
    expect(
      findUnresolvedTabtinDistRelativeImports(paths, (p) => textByPath.get(p) || ''),
    ).toEqual([
      'node_modules/@tabtin/terminal-core/dist/index.js → ./chunk-E3XO57H6.js',
    ]);

    const okPaths = [
      'node_modules/@tabtin/terminal-core/dist/index.js',
      'node_modules/@tabtin/terminal-core/dist/chunk-E3XO57H6.js',
    ];
    expect(
      findUnresolvedTabtinDistRelativeImports(okPaths, (p) => textByPath.get(p) || ''),
    ).toEqual([]);

    expect(extractRelativeJsImports(indexText)).toEqual(['./chunk-E3XO57H6.js']);
    expect(
      resolveRelativeSpecifier(
        'node_modules/@tabtin/terminal-core/dist/index.js',
        './chunk-E3XO57H6.js',
      ),
    ).toBe('node_modules/@tabtin/terminal-core/dist/chunk-E3XO57H6.js');
  });

  it('fails when a packaged main bundle loads a runtime module absent from the artifact ', () => {
    const bundlePath = 'out/main/main-app-BkuH4jC8.mjs';
    const bundleText = [
      `import { createRequire as Z } from 'node:module';`,
      `const require$1 = Z(import.meta.url);`,
      `require$1('@tabtin/terminal-core');`,
      `require$1('electron');`,
      `require$1('node:path');`,
    ].join('\n');

    expect(extractLiteralRuntimeSpecifiers(bundleText)).toEqual([
      'node:module',
      '@tabtin/terminal-core',
      'electron',
      'node:path',
    ]);
    expect(
      findUnresolvedPackagedRuntimeImports([{ path: bundlePath, text: bundleText }], [bundlePath]),
    ).toEqual([
      `${bundlePath} → missing runtime package "@tabtin/terminal-core" (@tabtin/terminal-core)`,
    ]);
    expect(
      findUnresolvedPackagedRuntimeImports(
        [{ path: bundlePath, text: bundleText }],
        [bundlePath, 'node_modules/@tabtin/terminal-core/package.json'],
      ),
    ).toEqual([]);
  });

  it('accepts react-pdf path fallback when the primary pdfjs package is present', () => {
    const bundlePath = 'out/main/doc-parser-worker.mjs';
    const bundleText = [
      `import { createRequire } from 'node:module';`,
      `const runtimeRequire = createRequire(import.meta.url);`,
      `runtimeRequire.resolve('pdfjs-dist/package.json');`,
      `runtimeRequire.resolve('react-pdf/package.json');`,
    ].join('\n');

    expect(
      findUnresolvedPackagedRuntimeImports(
        [{ path: bundlePath, text: bundleText }],
        ['node_modules/pdfjs-dist/package.json'],
      ),
    ).toEqual([]);
  });

  it('blocks first-party sourceMappingURL references but ignores third-party node_modules', () => {
    expect(shouldBlockSourceMapReference('app.asar/out/main/index.mjs')).toBe(true);
    expect(shouldBlockSourceMapReference('app.asar/out/renderer/assets/app.js')).toBe(true);
    expect(shouldBlockSourceMapReference('app.asar/node_modules/some-lib/index.js')).toBe(false);
    expect(shouldBlockSourceMapReference('app.asar.unpacked/node_modules/native-wrapper/index.js')).toBe(false);
  });

  it('distinguishes emitted sourcemap comments from sourceMappingURL string literals', () => {
    expect(hasPublicSourceMapReference('const value = 1;\n//# sourceMappingURL=app.js.map')).toBe(true);
    expect(hasPublicSourceMapReference('const value = 1;//# sourceMappingURL=app.js.map')).toBe(true);
    expect(hasPublicSourceMapReference('body{}/*# sourceMappingURL=app.css.map */')).toBe(true);
    expect(
      hasPublicSourceMapReference('writer.writeComment(`//# sourceMappingURL=${url}`);'),
    ).toBe(false);
    expect(hasPublicSourceMapReference('const marker = "//# sourceMappingURL=fake.map";')).toBe(false);
    // Minified Monaco/TS worker : earlier backtick desyncs naive scanners.
    expect(
      hasPublicSourceMapReference(
        'const noise=`unclosed;R.writeComment(`//# sourceMappingURL=${ce}`)),fe){const Re=be.toString()',
      ),
    ).toBe(false);
    // After a closed template, a real trailing map comment must still fail the audit.
    expect(
      hasPublicSourceMapReference(
        'const noise=`closed`;code;//# sourceMappingURL=app.js.map',
      ),
    ).toBe(true);
    expect(isEmittedSourceMapComment('//# sourceMappingURL=app.js.map')).toBe(true);
    expect(isEmittedSourceMapComment('//# sourceMappingURL=${ce}`)),fe){')).toBe(false);
  });

  it('blocks embedded Office runtime archives in distributable builds by default', () => {
    const previous = process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME;
    delete process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME;

    try {
      expect(shouldBlockEmbeddedOfficeRuntime('mac', 'preprod')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('darwin', 'production')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('win', 'preprod')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('win32', 'production')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('linux', 'preprod')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('linux', 'production')).toBe(true);
      expect(shouldBlockEmbeddedOfficeRuntime('mac', 'local')).toBe(false);
      expect(shouldBlockEmbeddedOfficeRuntime('win', 'local')).toBe(false);
      expect(shouldBlockEmbeddedOfficeRuntime('linux', 'local')).toBe(false);

      process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME = '1';
      expect(shouldBlockEmbeddedOfficeRuntime('mac', 'preprod')).toBe(false);
      expect(shouldBlockEmbeddedOfficeRuntime('win', 'preprod')).toBe(false);
      expect(shouldBlockEmbeddedOfficeRuntime('linux', 'preprod')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME;
      else process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME = previous;
    }
  });

  it('requires packaged python runtime archive for official profiles only', () => {
    expect(shouldRequirePackagedPythonRuntime('preprod')).toBe(true);
    expect(shouldRequirePackagedPythonRuntime('production')).toBe(true);
    expect(shouldRequirePackagedPythonRuntime('local')).toBe(false);
    expect(packagedPythonRuntimePlatform('mac', 'arm64')).toBe('darwin-arm64');
    expect(packagedPythonRuntimePlatform('win', 'x64')).toBe('win32-x64');

    const manifest = JSON.stringify({
      schemaVersion: 2,
      platforms: {
        'darwin-arm64': { archiveName: 'tabtin-python-runtime.tar.gz' },
      },
    });
    const readText = () => manifest;

    expect(
      findMissingPackagedPythonRuntime(
        ['native/tabtin-python-runtime/manifest.json', 'native/tabtin-python-runtime/tabtin-python-runtime.tar.gz'],
        { target: 'mac', arch: 'arm64', readText },
      ),
    ).toEqual([]);
    expect(
      findMissingPackagedPythonRuntime(['native/tabtin-python-runtime/manifest.json'], {
        target: 'mac',
        arch: 'arm64',
        readText,
      }),
    ).toEqual(['native/tabtin-python-runtime/tabtin-python-runtime.tar.gz']);
    expect(findMissingPackagedPythonRuntime(['native/office-preview-runtime/manifest.json'])).toEqual([
      'native/tabtin-python-runtime/manifest.json',
    ]);
  });

  it('blocks non-darwin native binaries from mac distributable packages', () => {
    expect(
      shouldBlockMacNonDarwinNativePath(
        'app.asar.unpacked/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node',
      ),
    ).toBe(true);
    expect(
      shouldBlockMacNonDarwinNativePath(
        'app.asar.unpacked/node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.node',
      ),
    ).toBe(true);
    expect(
      shouldBlockMacNonDarwinNativePath(
        'app.asar.unpacked/node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.dll',
      ),
    ).toBe(true);
    expect(
      shouldBlockMacNonDarwinNativePath(
        'app.asar.unpacked/node_modules/@nut-tree-fork/libnut-darwin/build/Release/libnut.node',
      ),
    ).toBe(false);
    expect(shouldBlockMacNonDarwinNativePath('app.asar/node_modules/node-pty/lib/windowsTerminal.js')).toBe(false);
  });

  it('requires packaged overlay and TabDoc cover crop signals', () => {
    expect(
      findMissingRequiredArtifactSignals([
        'body{--glass-bg-overlay:0 0% 100%}.overlay-backdrop-blur{backdrop-filter:blur(16px)}',
        'const titleKey="coverCropTitle";const dragKey="coverCropDragLabel"',
      ]),
    ).toEqual([]);

    expect(findMissingRequiredArtifactSignals('body{--glass-bg-overlay:0 0% 100%}')).toEqual([
      'overlay backdrop blur utility: expected one of overlay-backdrop-blur',
      'TabDoc cover crop artifact signal : expected one of coverCropTitle, coverCropDragLabel, 调整封面取景, 拖动封面调整取景, coverPositionX',
    ]);
  });
});

function makeThinMacho(cputype: number, options: { bigEndian?: boolean } = {}): Buffer {
  const buffer = Buffer.alloc(32);
  if (options.bigEndian) {
    buffer.writeUInt32BE(0xfeedfacf, 0);
    buffer.writeUInt32BE(cputype, 4);
  } else {
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(cputype, 4);
  }
  return buffer;
}

function makeFatMacho(cigam = false): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(cigam ? 0xbebafeca : 0xcafebabe, 0);
  return buffer;
}

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

describe('machoArchOf', () => {
  it('identifies thin x86_64 and arm64 binaries', () => {
    expect(machoArchOf(makeThinMacho(CPU_TYPE_X86_64))).toBe('x64');
    expect(machoArchOf(makeThinMacho(CPU_TYPE_ARM64))).toBe('arm64');
  });

  it('handles big-endian (swapped) Mach-O headers', () => {
    expect(machoArchOf(makeThinMacho(CPU_TYPE_X86_64, { bigEndian: true }))).toBe('x64');
    expect(machoArchOf(makeThinMacho(CPU_TYPE_ARM64, { bigEndian: true }))).toBe('arm64');
  });

  it('accepts fat/universal magic in both byte orders', () => {
    expect(machoArchOf(makeFatMacho(false))).toBe('universal');
    expect(machoArchOf(makeFatMacho(true))).toBe('universal');
  });

  it('returns unknown for non-Mach-O or truncated buffers', () => {
    expect(machoArchOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]))).toBe('unknown'); // ELF
    expect(machoArchOf(Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]))).toBe('unknown'); // PE (MZ)
    expect(machoArchOf(Buffer.alloc(0))).toBe('unknown');
    expect(machoArchOf(Buffer.from([0xcf, 0xfa]))).toBe('unknown');
    expect(machoArchOf(undefined)).toBe('unknown');
  });

  it('returns unknown for a recognized Mach-O with an unexpected cputype', () => {
    expect(machoArchOf(makeThinMacho(0x0000000c))).toBe('unknown'); // 32-bit ARM cputype
  });
});

describe('evaluateMacPackagedFilegen', () => {
  const relPath = 'tabtin-filegen-python/dist/tabtin-filegen';

  it('treats a missing binary as critical for preprod/production and warning for local', () => {
    expect(
      evaluateMacPackagedFilegen({
        exists: false,
        executable: false,
        actualArch: 'unknown',
        targetArch: 'x64',
        relPath,
        profile: 'production',
      }),
    ).toEqual({
      level: 'critical',
      hits: [`缺少内置 tabtin-filegen：${relPath}`],
    });
    expect(
      evaluateMacPackagedFilegen({
        exists: false,
        executable: false,
        actualArch: 'unknown',
        targetArch: 'x64',
        relPath,
        profile: 'local',
      }),
    ).toEqual({
      level: 'warning',
      hits: [`缺少内置 tabtin-filegen：${relPath}`],
    });
  });

  it('fails when an arm64 binary is staged into an x64 package ', () => {
    expect(
      evaluateMacPackagedFilegen({
        exists: true,
        executable: true,
        actualArch: 'arm64',
        targetArch: 'x64',
        relPath,
        profile: 'local',
      }),
    ).toEqual({
      level: 'critical',
      hits: [`tabtin-filegen 架构不匹配：${relPath} 期望 x64 实为 arm64`],
    });
  });

  it('accepts matching thin arch and universal binaries', () => {
    expect(
      evaluateMacPackagedFilegen({
        exists: true,
        executable: true,
        actualArch: 'x64',
        targetArch: 'x64',
        relPath,
        profile: 'production',
      }),
    ).toEqual({ level: 'critical', hits: [] });
    expect(
      evaluateMacPackagedFilegen({
        exists: true,
        executable: true,
        actualArch: 'universal',
        targetArch: 'x64',
        relPath,
        profile: 'production',
      }),
    ).toEqual({ level: 'critical', hits: [] });
  });
});

describe('normalizeTargetArch', () => {
  it('normalizes common arch aliases', () => {
    expect(normalizeTargetArch('x64')).toBe('x64');
    expect(normalizeTargetArch('x86_64')).toBe('x64');
    expect(normalizeTargetArch('Intel')).toBe('x64');
    expect(normalizeTargetArch('arm64')).toBe('arm64');
    expect(normalizeTargetArch('aarch64')).toBe('arm64');
    expect(normalizeTargetArch('apple-silicon')).toBe('arm64');
    expect(normalizeTargetArch('')).toBeUndefined();
    expect(normalizeTargetArch('mips')).toBeUndefined();
  });
});

describe('classifyMacNativeAsset', () => {
  const requiredSpec = {
    id: 'required-pkg',
    required: true,
    pkgDir: (arch: string) => `required-darwin-${arch}`,
  };
  const optionalSpec = {
    id: 'optional-pkg',
    required: false,
    pkgDir: (arch: string) => `optional-darwin-${arch}`,
    scan: true,
    scanMustFind: true,
  };
  const archDirSpec = {
    id: 'archdir-pkg',
    required: false,
    pkgDir: () => 'archdir-pkg',
    archDir: (arch: string) => `prebuilds/darwin-${arch}`,
    scan: true,
    scanMustFind: false,
  };

  it('passes when the required asset exists with a matching arch', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'x64', {
      installed: true,
      machoFiles: [{ path: 'required-darwin-x64/bin/rg', arch: 'x64' }],
      missingFiles: [],
      nonExecutable: [],
    });
    expect(result.level).toBe('ok');
    expect(result.messages).toEqual([]);
  });

  it('accepts universal binaries against any target arch', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'arm64', {
      installed: true,
      machoFiles: [{ path: 'required-darwin-arm64/bin/rg', arch: 'universal' }],
    });
    expect(result.level).toBe('ok');
  });

  it('flags an arch mismatch as critical', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'x64', {
      installed: true,
      machoFiles: [{ path: 'required-darwin-x64/bin/rg', arch: 'arm64' }],
    });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('架构不匹配');
    expect(result.messages[0]).toContain('期望 x64 实为 arm64');
  });

  it('treats a missing required dependency as critical', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'x64', { installed: false });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('缺少必需原生依赖');
  });

  it('treats a missing optional dependency as a warning', () => {
    const result = classifyMacNativeAsset(optionalSpec, 'x64', { installed: false });
    expect(result.level).toBe('warning');
    expect(result.messages[0]).toContain('未打入可选原生依赖');
  });

  it('fails when an installed asset is missing its expected file', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'x64', {
      installed: true,
      machoFiles: [],
      missingFiles: ['required-darwin-x64/bin/rg'],
      nonExecutable: [],
    });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('缺少关键资产');
  });

  it('fails when the arch-specific payload directory is absent for an installed dependency', () => {
    const result = classifyMacNativeAsset(archDirSpec, 'x64', {
      installed: true,
      archPayloadPresent: false,
      machoFiles: [],
    });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('已安装但缺目标架构目录');
  });

  it('fails when an installed scan target contains no native binaries', () => {
    const result = classifyMacNativeAsset(optionalSpec, 'x64', {
      installed: true,
      machoFiles: [],
      missingFiles: [],
    });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('未找到任何原生二进制');
  });

  it('flags an unrecognized Mach-O header as critical', () => {
    const result = classifyMacNativeAsset(requiredSpec, 'x64', {
      installed: true,
      machoFiles: [{ path: 'required-darwin-x64/bin/rg', arch: 'unknown' }],
    });
    expect(result.level).toBe('critical');
    expect(result.messages[0]).toContain('无法识别 Mach-O 架构');
  });
});

interface FakeEntryDir {
  type: 'dir';
}
interface FakeEntryFile {
  type: 'file';
  head?: Buffer;
  exec?: boolean;
}
type FakeEntry = FakeEntryDir | FakeEntryFile;

function makeFakeIo(fsMap: Record<string, FakeEntry>) {
  const isMacho = (rel: string) => {
    const base = rel.split('/').pop() ?? '';
    return base === 'rg' || base.endsWith('.node') || base.endsWith('.dylib');
  };
  return {
    dirExists: (rel: string) => fsMap[rel]?.type === 'dir',
    fileExists: (rel: string) => fsMap[rel]?.type === 'file',
    isExecutable: (rel: string) =>
      fsMap[rel]?.type === 'file' && Boolean((fsMap[rel] as FakeEntryFile).exec),
    readHead: (rel: string) => (fsMap[rel] as FakeEntryFile | undefined)?.head ?? Buffer.alloc(0),
    resolveArchDirs: (pkgDir: string, pattern: string) => {
      const target = `${pkgDir}/${pattern}`;
      return Object.keys(fsMap).filter((key) => key === target && fsMap[key].type === 'dir');
    },
    listMachoFiles: (relDir: string) =>
      Object.keys(fsMap).filter(
        (key) => key.startsWith(`${relDir}/`) && fsMap[key].type === 'file' && isMacho(key),
      ),
  };
}

describe('evaluateMacNativeArchAssets', () => {
  const ripgrepSpec = MAC_NATIVE_ARCH_ASSET_SPECS.find(
    (spec: { id: string }) => spec.id.startsWith('@vscode/ripgrep'),
  );

  it('passes ripgrep when present, executable and arch matches', () => {
    const io = makeFakeIo({
      '@vscode/ripgrep-darwin-x64': { type: 'dir' },
      '@vscode/ripgrep-darwin-x64/bin/rg': {
        type: 'file',
        exec: true,
        head: makeThinMacho(CPU_TYPE_X86_64),
      },
    });
    const { criticalHits, warningHits } = evaluateMacNativeArchAssets('x64', io, [ripgrepSpec]);
    expect(criticalHits).toEqual([]);
    expect(warningHits).toEqual([]);
  });

  it('fails ripgrep when the packaged binary is the wrong arch (cross-build regression )', () => {
    const io = makeFakeIo({
      '@vscode/ripgrep-darwin-x64': { type: 'dir' },
      '@vscode/ripgrep-darwin-x64/bin/rg': {
        type: 'file',
        exec: true,
        head: makeThinMacho(CPU_TYPE_ARM64),
      },
    });
    const { criticalHits } = evaluateMacNativeArchAssets('x64', io, [ripgrepSpec]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('架构不匹配');
  });

  it('fails ripgrep as critical when the darwin-x64 package is missing entirely', () => {
    const io = makeFakeIo({});
    const { criticalHits, warningHits } = evaluateMacNativeArchAssets('x64', io, [ripgrepSpec]);
    expect(warningHits).toEqual([]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('缺少必需原生依赖');
  });

  it('scans arch-specific subdirectories for node-pty style layouts', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64/spawn-helper': {
        type: 'file',
        exec: true,
        head: makeThinMacho(CPU_TYPE_ARM64),
      },
      'node-pty/prebuilds/darwin-arm64/node.napi.node': {
        type: 'file',
        head: makeThinMacho(CPU_TYPE_X86_64),
      },
    });
    const nodePtySpec = MAC_NATIVE_ARCH_ASSET_SPECS.find((spec: { id: string }) => spec.id === 'node-pty');
    const { criticalHits } = evaluateMacNativeArchAssets('arm64', io, [nodePtySpec]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('架构不匹配');
  });

  it('passes node-pty when spawn-helper is present, executable and arch matches ', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64/spawn-helper': {
        type: 'file',
        exec: true,
        head: makeThinMacho(CPU_TYPE_ARM64),
      },
      'node-pty/prebuilds/darwin-arm64/node.napi.node': {
        type: 'file',
        head: makeThinMacho(CPU_TYPE_ARM64),
      },
    });
    const nodePtySpec = MAC_NATIVE_ARCH_ASSET_SPECS.find((spec: { id: string }) => spec.id === 'node-pty');
    const { criticalHits, warningHits } = evaluateMacNativeArchAssets('arm64', io, [nodePtySpec]);
    expect(criticalHits).toEqual([]);
    expect(warningHits).toEqual([]);
  });

  it('fails node-pty as critical when spawn-helper lacks the executable bit ', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64/spawn-helper': {
        type: 'file',
        exec: false,
        head: makeThinMacho(CPU_TYPE_ARM64),
      },
    });
    const nodePtySpec = MAC_NATIVE_ARCH_ASSET_SPECS.find((spec: { id: string }) => spec.id === 'node-pty');
    const { criticalHits } = evaluateMacNativeArchAssets('arm64', io, [nodePtySpec]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('关键资产不可执行');
    expect(criticalHits[0]).toContain('spawn-helper');
  });

  it('fails node-pty as critical when spawn-helper is missing entirely ', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/darwin-arm64': { type: 'dir' },
    });
    const nodePtySpec = MAC_NATIVE_ARCH_ASSET_SPECS.find((spec: { id: string }) => spec.id === 'node-pty');
    const { criticalHits } = evaluateMacNativeArchAssets('arm64', io, [nodePtySpec]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('缺少关键资产');
    expect(criticalHits[0]).toContain('spawn-helper');
  });
});

describe('evaluateWindowsNativeAssets', () => {
  const nodePtySpec = WINDOWS_NATIVE_ASSET_SPECS.find((spec: { id: string }) => spec.id === 'node-pty');

  it('passes when node-pty conpty.node is present for the target arch', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/win32-x64/conpty.node': { type: 'file' },
    });

    const { criticalHits, warningHits } = evaluateWindowsNativeAssets('x64', io, [nodePtySpec]);

    expect(criticalHits).toEqual([]);
    expect(warningHits).toEqual([]);
  });

  it('fails when the packaged Windows node-pty prebuild is missing conpty.node', () => {
    const io = makeFakeIo({
      'node-pty': { type: 'dir' },
      'node-pty/prebuilds/win32-x64': { type: 'dir' },
    });

    const { criticalHits, warningHits } = evaluateWindowsNativeAssets('x64', io, [nodePtySpec]);

    expect(warningHits).toEqual([]);
    expect(criticalHits).toHaveLength(1);
    expect(criticalHits[0]).toContain('node-pty/prebuilds/win32-x64/conpty.node');
  });
});

describe('audit-packaged-artifact launch smoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a non-crashing timeout and kills the spawned process group', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const killProcessGroup = vi.fn();
    const spawn = vi.fn(() => child);
    const removeTempUserDataDir = vi.fn();

    const checksPromise = scanMacLaunchSmokeWithDeps(
      '/tmp/Fake.app',
      'preprod',
      {
        platform: 'darwin',
        timeoutMs: 100,
        findMacExecutable: () => '/tmp/Fake.app/Contents/MacOS/Fake',
        createTempUserDataDir: () => '/tmp/tabtin-packaged-smoke-test',
        removeTempUserDataDir,
        spawn,
        killProcessGroup,
      },
    );

    await vi.advanceTimersByTimeAsync(100);

    const checks = await checksPromise;

    expect(killProcessGroup).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(spawn).toHaveBeenCalledWith(
      '/tmp/Fake.app/Contents/MacOS/Fake',
      expect.arrayContaining(['--user-data-dir=/tmp/tabtin-packaged-smoke-test']),
      expect.any(Object),
    );
    expect(removeTempUserDataDir).toHaveBeenCalledWith('/tmp/tabtin-packaged-smoke-test');
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('macOS launch smoke');
    expect(checks[0].totalHits).toBe(0);
    expect(checks[0].details).toContain('超过 100ms');
  });

  it('fails when a still-running app reports a missing runtime package', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 12346;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const checksPromise = scanMacLaunchSmokeWithDeps(
      '/tmp/Fake.app',
      'local',
      {
        platform: 'darwin',
        timeoutMs: 100,
        findMacExecutable: () => '/tmp/Fake.app/Contents/MacOS/Fake',
        createTempUserDataDir: () => '/tmp/tabtin-packaged-smoke-test',
        removeTempUserDataDir: vi.fn(),
        spawn: vi.fn(() => child),
        killProcessGroup: vi.fn(),
      },
    );

    child.stderr.emit(
      'data',
      Buffer.from("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fix-path'"),
    );
    await vi.advanceTimersByTimeAsync(100);

    const checks = await checksPromise;

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('macOS launch smoke');
    expect(checks[0].totalHits).toBeGreaterThan(0);
  });
});
