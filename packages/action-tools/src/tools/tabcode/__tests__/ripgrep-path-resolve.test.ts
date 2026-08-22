/**
 * ：grep_search / glob_search 的 bundled rg 路径解析。
 * - packaged Electron：app.asar → app.asar.unpacked，避免 spawn ENOTDIR
 * - 开发态：能解析到 @vscode/ripgrep 平台二进制
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  __resetRipgrepStateForTests,
  mapAppAsarPathToUnpacked,
  resolveBundledRipgrepPath,
} from '../index';

describe('mapAppAsarPathToUnpacked ', () => {
  it('maps macOS/Linux app.asar segment to app.asar.unpacked', () => {
    const asar =
      '/Applications/TabTin.app/Contents/Resources/app.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg';
    expect(mapAppAsarPathToUnpacked(asar)).toBe(
      '/Applications/TabTin.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
    );
  });

  it('maps Windows app.asar\\ segment to app.asar.unpacked', () => {
    const asar =
      'C:\\Program Files\\TabTin\\resources\\app.asar\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe';
    expect(mapAppAsarPathToUnpacked(asar)).toBe(
      'C:\\Program Files\\TabTin\\resources\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe',
    );
  });

  it('does not double-rewrite app.asar.unpacked', () => {
    const unpacked =
      '/Applications/TabTin.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg';
    expect(mapAppAsarPathToUnpacked(unpacked)).toBe(unpacked);
  });

  it('leaves non-asar paths unchanged', () => {
    const local = '/Users/dev/proj/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg';
    expect(mapAppAsarPathToUnpacked(local)).toBe(local);
  });
});

describe('resolveBundledRipgrepPath', () => {
  afterEach(() => {
    __resetRipgrepStateForTests();
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  it('resolves a real bundled rg binary in the monorepo install', () => {
    const resolved = resolveBundledRipgrepPath();
    expect(resolved).toBeTruthy();
    expect(fs.existsSync(resolved!)).toBe(true);
    expect(path.basename(resolved!)).toMatch(/^rg(\.exe)?$/);
    expect(resolved!).not.toMatch(/app\.asar(?!\.unpacked)/);
  });

  it('prefers resourcesPath app.asar.unpacked candidate when present', () => {
    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'tabtin-rg-'));
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const unpackedBin = path.join(
      tmpRoot,
      'app.asar.unpacked',
      'node_modules',
      platformPkg,
      'bin',
      binaryName,
    );
    fs.mkdirSync(path.dirname(unpackedBin), { recursive: true });
    fs.writeFileSync(unpackedBin, 'fake-rg');

    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = tmpRoot;

    try {
      expect(resolveBundledRipgrepPath()).toBe(unpackedBin);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
