import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_MODEL_ID,
  MODEL_FILE_RELATIVE_PATH,
  TOKENIZER_FILENAME,
} from '@tabtin/local-embedding';

export function hasLocalSemanticModel(modelsDir: string): boolean {
  const modelDir = path.join(modelsDir, DEFAULT_MODEL_ID);
  return [MODEL_FILE_RELATIVE_PATH, TOKENIZER_FILENAME].every((relativePath) =>
    existsSync(path.join(modelDir, relativePath)),
  );
}
