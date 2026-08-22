/**
 * SECTION_REGISTRY —— prompt 段全集 SSoT
 *
 * 数据来源 `registry-entries.generated.ts`，由
 * `0_active_renderers.md` + `overrides.yaml` 抽取 + 合并生成。
 *
 * 治理纪律：
 *   - 注册表条目 = 0_active_renderers 的 A + B 类条目（C 类历史项不进）
 *   - audit P1 反向校验 1:1 对齐：注册表多 / 少都失败
 *   - audit P2 字符上限：渲染长度 > charBudget 即失败
 *   - audit P3 语言纪律：detectLanguage 算法判定 vs descriptor.language 必须一致
 *   - audit P4 cache 纪律：cacheBreak=true 必须有 reason 且不在 cache boundary 之前
 *   - audit P7 工具硬契约：high-risk 工具 description 必须含关键约束词
 *
 * 改 prompt 段时的流程：
 *   1. 改源代码（builder.ts / hook / capability / tool 等）
 *   2. 改 `0_active_renderers.md` 对应 entry（注明文件:行 + evidence）
 *   3. 改 `overrides.yaml`（如有 mode / host 特殊约束变化）
 *   4. rerun `python3 extract_renderers.py` 重新生成本文件依赖的 `.generated.ts`
 *   5. `pnpm --filter @tabtin/prompt-contract build` 验证类型
 *   6. `pnpm vitest audit.test.ts` 跑 P1-P7 审计
 *
 * 见 `99_治理基线候选.md` 阶段 1.1 / 1.6。
 */

import type { SectionDescriptor } from './section-descriptor.js';
import { REGISTRY_ENTRIES } from './registry-entries.generated.js';

/** id → SectionDescriptor。从 REGISTRY_ENTRIES 派生，O(N) 一次构建。 */
export const SECTION_REGISTRY: Readonly<Record<string, SectionDescriptor>> =
  Object.freeze(
    Object.fromEntries(REGISTRY_ENTRIES.map((e) => [e.id, e])) as Record<
      string,
      SectionDescriptor
    >,
  );

export { REGISTRY_ENTRIES };
