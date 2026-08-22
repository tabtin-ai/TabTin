/**
 * OnnxBackend 金标对照测试（：移除 @huggingface/transformers）。
 *
 * 两层断言：
 * 1. 分词金标：`@anush008/tokenizers` 加载现有 tokenizer.json 的输出必须与
 *    fixture（用 transformers.js AutoTokenizer 预生成）逐 id 一致——换栈不换语义；
 * 2. 推理理智检查：维度、L2 归一化、相关对 > 无关对。
 *
 * 依赖本机模型文件（`~/.tabtin/models/Xenova/multilingual-e5-small`，
 * 用 `node scripts/electron/runtime/fetch-embedding-model.mjs` 置入）；文件缺失时整组跳过，
 * 不阻塞无模型环境的单测。
 */

import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OnnxBackend } from '../backend.js';
import {
  DEFAULT_MODEL_ID,
  EMBEDDING_DIMS,
  MAX_SEQ_LENGTH,
  MODEL_FILE_RELATIVE_PATH,
  TOKENIZER_FILENAME,
} from '../constants.js';

const MODEL_DIR = path.join(os.homedir(), '.tabtin', 'models', DEFAULT_MODEL_ID);
const hasModel =
  existsSync(path.join(MODEL_DIR, MODEL_FILE_RELATIVE_PATH)) &&
  existsSync(path.join(MODEL_DIR, TOKENIZER_FILENAME));

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'tokenizer-golden.json',
);

interface GoldenCase {
  text: string;
  ids: number[];
}

/** XLM-R 的 `</s>` id——截断行为断言用。 */
const EOS_ID = 2;

describe.skipIf(!hasModel)('OnnxBackend（真模型，缺文件时跳过）', () => {
  it('分词输出与 transformers.js 金标逐 id 一致', async () => {
    const { Tokenizer } = await import('@anush008/tokenizers');
    const tokenizer = Tokenizer.fromFile(path.join(MODEL_DIR, TOKENIZER_FILENAME));
    tokenizer.setTruncation(MAX_SEQ_LENGTH);

    const golden = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: GoldenCase[] };
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const { text, ids } of golden.cases) {
      const encoding = await tokenizer.encode(text);
      expect(encoding.getIds(), JSON.stringify(text)).toEqual(ids);
    }
  });

  it('超长文本截断到最大长度且保留结尾特殊 token', async () => {
    const { Tokenizer } = await import('@anush008/tokenizers');
    const tokenizer = Tokenizer.fromFile(path.join(MODEL_DIR, TOKENIZER_FILENAME));
    tokenizer.setTruncation(MAX_SEQ_LENGTH);

    const encoding = await tokenizer.encode('passage: ' + '长文本截断测试。'.repeat(200));
    const ids = encoding.getIds();
    expect(ids.length).toBe(MAX_SEQ_LENGTH);
    expect(ids[ids.length - 1]).toBe(EOS_ID);
  });

  it('推理输出维度正确、已归一化，相关对相似度高于无关对', async () => {
    const backend = new OnnxBackend({ modelDir: MODEL_DIR, dims: EMBEDDING_DIMS });
    await backend.load();

    const [query, related, unrelated] = await backend.embed([
      'query: 帮我截一张当前屏幕的图',
      'passage: Capture a screenshot of the current screen or display',
      'passage: 获取A股每日筹码平均成本和胜率情况',
    ]);

    expect(query.length).toBe(EMBEDDING_DIMS);
    const norm = Math.sqrt(query.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 3);

    const dot = (a: Float32Array, b: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
      return sum;
    };
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  }, 30_000);
});
