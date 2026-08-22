/**
 * 语义打分器单例（ 双路召回）——Daemon 宿主装配。
 *
 * 与 Electron main 的同名模块职责一致：进程级一个 `LocalEmbeddingService`
 * （模型与向量缓存在 `~/.tabtin/` 下，与 Electron dev 共享磁盘资产），包装成
 * `SemanticScorer` 注入 `initSkillsModule`。就绪前 scorer 返回 null，
 * 融合层自动走词法单路——Daemon 无头模式零额外依赖即可用。
 *
 * 模型目录（ 生产零下载）：默认 `~/.tabtin/models`，部署方用
 * `TABTIN_MODELS_DIR` 指到预置目录；置入方式统一为
 * `node scripts/electron/runtime/fetch-embedding-model.mjs`（运行时无下载能力，缺模型时
 * 语义路缺席、词法兜底）。
 */

import type { WarmableSemanticScorer } from '@tabtin/search';
import { LocalEmbeddingService, createSemanticScorer } from '@tabtin/local-embedding';

let scorer: WarmableSemanticScorer | null = null;

export function getDaemonSemanticScorer(log: (msg: string) => void): WarmableSemanticScorer {
  if (scorer) return scorer;
  const modelsDir = process.env.TABTIN_MODELS_DIR?.trim();
  const service = new LocalEmbeddingService({ ...(modelsDir ? { modelsDir } : {}), log });
  service.warmup().catch((err: unknown) => {
    // 失败已在 service 内记日志；后续对话走词法单路，不影响主链路。
    log(`[semantic-scorer] 语义模型预热失败（将走词法单路）：${err instanceof Error ? err.message : String(err)}`);
  });
  scorer = createSemanticScorer(service);
  return scorer;
}
