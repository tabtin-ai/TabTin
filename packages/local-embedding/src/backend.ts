/**
 * 推理后端抽象 —— 语义双路召回。
 *
 * 生产实现 `OnnxBackend`：`onnxruntime-node` 直连推理 + `@anush008/tokenizers`
 * （HF tokenizers Rust 绑定）分词。**模型文件从本地目录读取，本包没有任何
 * 下载能力**——生产零下载由依赖树物理保证，模型置入见
 * `scripts/electron/runtime/fetch-embedding-model.mjs`（dev 手动跑一次）与打包 extraResources。
 *
 * 单测注入假后端，不加载真模型。
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  EMBED_BATCH_SIZE,
  MAX_SEQ_LENGTH,
  MODEL_FILE_RELATIVE_PATH,
  TOKENIZER_FILENAME,
} from './constants.js';

export interface EmbeddingBackend {
  /** 加载模型（本地文件）。幂等由调用方（service）保证，本接口只管做。 */
  load(): Promise<void>;
  /** 批量前向。返回**已 L2 归一化**的向量（余弦相似度可用点积计算）。 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** `@anush008/tokenizers` 的最小结构声明（值导入走动态 import）。 */
interface RustTokenizer {
  setTruncation(maxLength: number): void;
  tokenToId(token: string): number | null;
  encodeBatch(
    sentences: string[],
  ): Promise<{ getIds(): number[]; getAttentionMask(): number[] }[]>;
}

/** `onnxruntime-node` 的最小结构声明（值导入走动态 import）。 */
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

type OrtTensorCtor = new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;

/** XLM-R 词表的 `<pad>` token 文本（pad id 从 tokenizer 动态解析，此处只定名字）。 */
const PAD_TOKEN = '<pad>';

export class OnnxBackend implements EmbeddingBackend {
  private readonly modelDir: string;
  private readonly dims: number;
  private session: OrtSession | null = null;
  private tokenizer: RustTokenizer | null = null;
  private padId = 0;
  private tensorCtor: OrtTensorCtor | null = null;

  /**
   * @param options.modelDir 模型目录（含 `tokenizer.json` 与 `onnx/model_quantized.onnx`），
   *   布局与 HF 缓存目录一致——dev 复用 `~/.tabtin/models/<modelId>`，生产指向
   *   安装包内置的 `Resources/models/<modelId>`。
   */
  constructor(options: { modelDir: string; dims: number }) {
    this.modelDir = options.modelDir;
    this.dims = options.dims;
  }

  async load(): Promise<void> {
    const modelPath = path.join(this.modelDir, MODEL_FILE_RELATIVE_PATH);
    const tokenizerPath = path.join(this.modelDir, TOKENIZER_FILENAME);
    for (const p of [modelPath, tokenizerPath]) {
      if (!existsSync(p)) {
        throw new Error(
          `模型文件缺失：${p}（dev 环境跑 node scripts/electron/runtime/fetch-embedding-model.mjs 置入；生产应随安装包内置）`,
        );
      }
    }
    // 动态 import：让未走语义召回的宿主路径不加载原生模块。
    const [ort, tokenizers] = await Promise.all([
      import('onnxruntime-node'),
      import('@anush008/tokenizers'),
    ]);
    this.tensorCtor = ort.Tensor as unknown as OrtTensorCtor;
    this.session = (await ort.InferenceSession.create(modelPath)) as unknown as OrtSession;
    const tokenizer = tokenizers.Tokenizer.fromFile(tokenizerPath) as unknown as RustTokenizer;
    tokenizer.setTruncation(MAX_SEQ_LENGTH);
    this.tokenizer = tokenizer;
    this.padId = tokenizer.tokenToId(PAD_TOKEN) ?? 0;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // 分批：单次 ONNX Run 的 batch 有界，避免大语料一次性推理顶爆 ORT 内存 →
    // C++ abort() 把整个宿主进程 SIGABRT（详见 EMBED_BATCH_SIZE 注释）。
    // 批间顺序拼接，语义与不分批完全等价（每批各自 pad，互不影响）。
    if (texts.length <= EMBED_BATCH_SIZE) {
      return this.embedBatch(texts);
    }
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const chunk = texts.slice(start, start + EMBED_BATCH_SIZE);
      const vecs = await this.embedBatch(chunk);
      for (const v of vecs) out.push(v);
    }
    return out;
  }

  /** 单批前向（batch ≤ EMBED_BATCH_SIZE）。上层 `embed` 负责分批调度。 */
  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const session = this.session;
    const tokenizer = this.tokenizer;
    const Tensor = this.tensorCtor;
    if (!session || !tokenizer || !Tensor) {
      throw new Error('模型尚未加载（先调用 load）');
    }

    const encodings = await tokenizer.encodeBatch(texts);
    const batch = texts.length;
    const maxLen = Math.max(...encodings.map((e) => e.getIds().length));

    // pad 到 batch 内最长；pad 位置 attention mask 为 0，不参与 pooling。
    const inputIds = new BigInt64Array(batch * maxLen).fill(BigInt(this.padId));
    const attentionMask = new BigInt64Array(batch * maxLen); // 默认 0
    encodings.forEach((enc, row) => {
      const ids = enc.getIds();
      const mask = enc.getAttentionMask();
      for (let i = 0; i < ids.length; i++) {
        inputIds[row * maxLen + i] = BigInt(ids[i]);
        attentionMask[row * maxLen + i] = BigInt(mask[i]);
      }
    });

    const feeds: Record<string, unknown> = {
      input_ids: new Tensor('int64', inputIds, [batch, maxLen]),
      attention_mask: new Tensor('int64', attentionMask, [batch, maxLen]),
    };
    // 个别 ONNX 导出带 token_type_ids 输入（XLM-R 全零即可），按需补齐。
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new Tensor('int64', new BigInt64Array(batch * maxLen), [batch, maxLen]);
    }

    const outputs = await session.run(feeds);
    const hidden = outputs[session.outputNames[0]];
    const hiddenDims = hidden.dims[hidden.dims.length - 1];
    if (hiddenDims !== this.dims) {
      // 模型与配置错配时立刻可诊断，而不是静默错切向量导致相似度全错
      throw new Error(`模型输出维度 ${hiddenDims} 与配置 ${this.dims} 不符（${this.modelDir}）`);
    }

    // masked mean pooling + L2 归一化（e5 推荐用法，等价 transformers.js
    // 的 { pooling: 'mean', normalize: true }）。
    const result: Float32Array[] = [];
    for (let row = 0; row < batch; row++) {
      const vec = new Float32Array(this.dims);
      let tokenCount = 0;
      for (let i = 0; i < maxLen; i++) {
        if (attentionMask[row * maxLen + i] === 0n) continue;
        tokenCount++;
        const offset = (row * maxLen + i) * this.dims;
        for (let d = 0; d < this.dims; d++) {
          vec[d] += hidden.data[offset + d];
        }
      }
      if (tokenCount > 0) {
        for (let d = 0; d < this.dims; d++) vec[d] /= tokenCount;
      }
      let norm = 0;
      for (let d = 0; d < this.dims; d++) norm += vec[d] * vec[d];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < this.dims; d++) vec[d] /= norm;
      }
      result.push(vec);
    }
    return result;
  }
}
