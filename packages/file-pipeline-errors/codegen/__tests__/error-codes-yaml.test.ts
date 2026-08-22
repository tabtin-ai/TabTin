import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ErrorCodeYamlDocument {
  codes?: Array<Record<string, unknown>>;
}

const yamlPath = fileURLToPath(new URL('../error-codes.yaml', import.meta.url));
const generatorPath = fileURLToPath(new URL('../generate.ts', import.meta.url));

describe('Wave 3 file-pipeline error_kind SSoT', () => {
  it('active YAML entries do not carry retired numeric protocol metadata', () => {
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as ErrorCodeYamlDocument;

    expect(doc.codes).toBeDefined();
    expect(doc.codes).not.toHaveLength(0);
    for (const entry of doc.codes ?? []) {
      expect(entry).not.toHaveProperty('numeric');
    }
  });

  it('codegen schema does not read or declare numeric entry fields', () => {
    const source = readFileSync(generatorPath, 'utf8');

    expect(source).not.toMatch(/\bnumeric\??\s*:/);
    expect(source).not.toMatch(/\.numeric\b/);
  });
});
