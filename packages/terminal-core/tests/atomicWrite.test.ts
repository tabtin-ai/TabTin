import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync, atomicWriteFile } from '../src/atomicWrite';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `atomic-write-test-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('atomicWriteFileSync', () => {
  let dir: string;
  afterEach(() => { if (dir) cleanup(dir); });

  it('writes a file with string data (no options)', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'test.txt');
    atomicWriteFileSync(fp, 'hello');
    expect(fs.readFileSync(fp, 'utf8')).toBe('hello');
  });

  it('accepts positional mode number (daemon pattern)', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'secret.txt');
    atomicWriteFileSync(fp, 'secret', 0o600);
    expect(fs.readFileSync(fp, 'utf8')).toBe('secret');
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('accepts options object with mode (electron pattern)', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'config.json');
    atomicWriteFileSync(fp, '{"ok":true}', { mode: 0o644 });
    expect(fs.readFileSync(fp, 'utf8')).toBe('{"ok":true}');
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it('accepts options object with encoding', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'enc.txt');
    atomicWriteFileSync(fp, 'utf8-data', { encoding: 'utf8' });
    expect(fs.readFileSync(fp, 'utf8')).toBe('utf8-data');
  });

  it('accepts Buffer data', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'buf.bin');
    const buf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    atomicWriteFileSync(fp, buf);
    expect(Buffer.compare(fs.readFileSync(fp), buf)).toBe(0);
  });

  it('creates parent dirs when mkdirSync is true', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'nested', 'deep', 'file.txt');
    atomicWriteFileSync(fp, 'nested', { mkdirSync: true });
    expect(fs.readFileSync(fp, 'utf8')).toBe('nested');
  });

  it('throws when parent dir missing and mkdirSync is false', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'no-exist', 'file.txt');
    expect(() => atomicWriteFileSync(fp, 'fail')).toThrow();
  });

  it('cleans up temp file on write error', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'no-exist-dir', 'file.txt');
    try { atomicWriteFileSync(fp, 'fail'); } catch {}
    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('overwrites existing file atomically', () => {
    dir = tmpDir();
    const fp = path.join(dir, 'overwrite.txt');
    fs.writeFileSync(fp, 'old');
    atomicWriteFileSync(fp, 'new');
    expect(fs.readFileSync(fp, 'utf8')).toBe('new');
  });
});

describe('atomicWriteFile (async)', () => {
  let dir: string;
  afterEach(() => { if (dir) cleanup(dir); });

  it('writes a file with string data', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'async.txt');
    await atomicWriteFile(fp, 'async-hello');
    expect(fs.readFileSync(fp, 'utf8')).toBe('async-hello');
  });

  it('accepts positional mode number', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'async-mode.txt');
    await atomicWriteFile(fp, 'data', 0o600);
    expect(fs.readFileSync(fp, 'utf8')).toBe('data');
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('accepts options object', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'async-opts.txt');
    await atomicWriteFile(fp, 'opts', { encoding: 'utf8', mode: 0o644 });
    expect(fs.readFileSync(fp, 'utf8')).toBe('opts');
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it('creates parent dirs when mkdirSync is true', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'async-nested', 'file.txt');
    await atomicWriteFile(fp, 'nested', { mkdirSync: true });
    expect(fs.readFileSync(fp, 'utf8')).toBe('nested');
  });

  it('throws when parent dir missing and mkdirSync is false', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'no-dir', 'file.txt');
    await expect(atomicWriteFile(fp, 'fail')).rejects.toThrow();
  });

  it('cleans up temp file on error', async () => {
    dir = tmpDir();
    const fp = path.join(dir, 'no-dir', 'file.txt');
    try { await atomicWriteFile(fp, 'fail'); } catch {}
    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
