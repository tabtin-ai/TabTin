/**
 * 本地向量服务常量 —— 语义双路召回。
 *
 * 全部集中在此，禁止在实现文件里出现裸数字 / 裸字符串。
 */

/**
 * 默认模型：multilingual-e5-small（MIT 许可，384 维）。
 *
 * 选型依据（ 方案）：中英混合场景表现好、int8 量化 ONNX 约 112MB、
 * 许可允许商用分发。Xenova 命名空间是 transformers.js 官方维护的 ONNX 转换版
 * （模型文件仍取自该仓库，但推理走 onnxruntime-node 直连，见 ）。
 */
export const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';

/** e5 系列模型的向量维度。 */
export const EMBEDDING_DIMS = 384;

/**
 * e5 系列的文本前缀约定：查询侧与候选侧必须分别加前缀，否则相似度显著劣化。
 * 由本包内部统一附加，调用方无感知。
 */
export const QUERY_PREFIX = 'query: ';
export const PASSAGE_PREFIX = 'passage: ';

/** 查询向量进程内 LRU 容量——覆盖一个会话内的重复轮次即可，无需大。 */
export const QUERY_LRU_CAPACITY = 128;

/**
 * warmup 失败后的惰性重试节流间隔（毫秒）。
 *
 * 宿主只在进程启动时主动调一次 `warmup()`；若当时失败（模型文件缺失 / 损坏），
 * 后续每次 embed 调用会按此间隔在后台重试（只重读本地磁盘，零网络），
 * 避免语义路整个进程生命周期静默失效——dev 补置模型后无需重启。
 */
export const WARMUP_RETRY_INTERVAL_MS = 60_000;

/**
 * 候选向量磁盘快照的防抖间隔（毫秒）——一次清单刷新会分批产生未命中，
 * 攒一批一起重写，避免频繁全量落盘。
 */
export const SNAPSHOT_DEBOUNCE_MS = 5_000;

/** 磁盘缓存 manifest 的格式版本，结构变更时递增并整体作废旧缓存。 */
export const MANIFEST_VERSION = 2;

/**
 * 缓存条目 TTL（毫秒）：超过此时长未被使用（get/set）的条目在快照重写时
 * 丢弃。孤儿清理靠它——清单里删掉的 skill / 工具不再被 get，自然过期；
 * 取 30 天：远大于正常使用间隔，又能兜住磁盘无限增长。
 */
export const CACHE_ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 缓存目录下的两个文件名。 */
export const MANIFEST_FILENAME = 'manifest.json';
export const VECTORS_FILENAME = 'vectors.bin';

/**
 * 模型目录内的文件布局（与 HF 缓存目录一致，dev / 生产共用同一套路径逻辑）。
 * 置入脚本 `scripts/electron/runtime/fetch-embedding-model.mjs` 与打包 extraResources 按此布局落盘。
 */
export const MODEL_FILE_RELATIVE_PATH = 'onnx/model_quantized.onnx';
export const TOKENIZER_FILENAME = 'tokenizer.json';

/** e5（XLM-R）的最大序列长度，超长文本按此截断。 */
export const MAX_SEQ_LENGTH = 512;

/**
 * 单次 ONNX 前向的最大条数（分批上限）。
 *
 * 语义召回的候选语料可达数百条（如 755 条 skills），若一次性拼成
 * `[batch, maxLen]` 灌进 `session.run`，ORT 内部按 `batch × maxLen × 隐藏维 × 层数`
 * 线性放大分配中间张量——单次内存需求可轻易顶爆，触发 C++ `std::bad_alloc` →
 * `terminate()` → `abort()`，**整个宿主进程 SIGABRT**（JS try/catch 拦不住）。
 * 按此上限把大批切成多次 `run`，使单次内存有界；批间顺序拼接，结果与不分批等价。
 * 取 16：512 序列长下单批张量规模可控，且仍有足够吞吐。
 */
export const EMBED_BATCH_SIZE = 16;
