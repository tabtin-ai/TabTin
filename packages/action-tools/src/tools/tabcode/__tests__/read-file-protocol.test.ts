import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import { fileReadTool } from '../index';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'read-file-protocol-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string | Buffer): Promise<string> {
  const file = path.join(tmpDir, name);
  await fsPromises.writeFile(file, content);
  return file;
}

describe('read_file protocol alignment', () => {
  it('returns cat-n compact line numbers and strips BOM/CRLF', async () => {
    const file = await writeFile('crlf.txt', '\uFEFFalpha\r\nbeta\r\ngamma\r\n');

    const res = await fileReadTool.execute({ path: file, offset: 2, limit: 1 });

    expect(res.success).toBe(true);
    expect(res.data?.content).toBe('2\tbeta');
    expect(res.data?.contentRaw).toBe('beta');
    expect(res.data?.total_lines).toBe(4);
    expect(res.data?.num_lines).toBe(1);
  });

  it('rejects blocking device files without reading them', async () => {
    const res = await fileReadTool.execute({ path: '/dev/zero' });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('device file would block or produce infinite output');
  });

  it('returns Did you mean suggestion for same basename with different extension', async () => {
    await writeFile('sample.tsx', 'export const x = 1;\n');
    const missing = path.join(tmpDir, 'sample.ts');

    const res = await fileReadTool.execute({ path: missing });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('File does not exist');
    expect(String(res.error)).toContain('Did you mean sample.tsx?');
  });

  it('large text error guides offset/limit or grep_search', async () => {
    const file = await writeFile('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('Use a positive offset and limit');
    expect(String(res.error)).toContain('grep_search');
  });

  it('large text supports positive offset/limit windows', async () => {
    const file = await writeFile(
      'large-window.txt',
      `${Buffer.alloc(10 * 1024 * 1024 + 1, 'a').toString()}\nneedle\n`,
    );

    const res = await fileReadTool.execute({ path: file, offset: 2, limit: 1 });

    expect(res.success).toBe(true);
    expect(res.data?.content).toBe('2\tneedle');
    expect(res.data?.contentRaw).toBe('needle');
  });

  it('rejects non-regular files', async () => {
    const dir = path.join(tmpDir, 'dir');
    await fsPromises.mkdir(dir);
    const realStat = fsPromises.stat;
    vi.spyOn(fsPromises, 'stat').mockResolvedValueOnce({
      isDirectory: () => false,
      isFile: () => false,
      size: 0,
    } as fs.Stats);
    try {
      const res = await fileReadTool.execute({ path: dir });

      expect(res.success).toBe(false);
      expect(String(res.error)).toContain('not a regular file');
    } finally {
      vi.mocked(fsPromises.stat).mockRestore();
      expect(fsPromises.stat).toBe(realStat);
    }
  });
});
