import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  MODEL_FILE_RELATIVE_PATH,
  TOKENIZER_FILENAME,
} from '@tabtin/local-embedding';
import { hasLocalSemanticModel } from './semantic-model-files.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function makeRoot(): string {
  const root = path.join(
    process.cwd(),
    '.test-dist',
    `semantic-model-${crypto.randomUUID()}`,
  );
  roots.push(root);
  return root;
}

describe('hasLocalSemanticModel', () => {
  it('returns false when the optional model is absent or incomplete', () => {
    const root = makeRoot();
    const modelPath = path.join(
      root,
      DEFAULT_MODEL_ID,
      MODEL_FILE_RELATIVE_PATH,
    );
    mkdirSync(path.dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, 'fixture');

    expect(hasLocalSemanticModel(root)).toBe(false);
  });

  it('returns true when both runtime files exist', () => {
    const root = makeRoot();
    for (const relativePath of [MODEL_FILE_RELATIVE_PATH, TOKENIZER_FILENAME]) {
      const filePath = path.join(root, DEFAULT_MODEL_ID, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'fixture');
    }

    expect(hasLocalSemanticModel(root)).toBe(true);
  });
});
