/**
 * 服务端搜索模式判定（纯函数，便于单测）。
 *
 * 规则：
 * - 索引已启用且无异常 → 用服务端搜索。
 * - 即便未建索引，只要视图未全量加载（已加载 < 总数，典型为大表无限滚动只加载首屏），
 *   也走服务端全表扫描，避免本地搜索漏掉未加载的行；后端 search_records 用 LIKE
 *   扫全表，不依赖 GIN 索引。
 * - 小表全量加载（已加载 >= 总数）且未建索引 → 仍走本地搜索（快、可离线）。
 */
export interface ServerSearchGatingInput {
  supported: boolean | undefined;
  enabled: boolean | undefined;
  abnormalCount: number | undefined;
  loadedRecordCount: number;
  totalRecordCount: number;
}

export const isViewFullyLoaded = (
  loadedRecordCount: number,
  totalRecordCount: number,
): boolean => totalRecordCount <= 0 || loadedRecordCount >= totalRecordCount;

export const resolveShouldUseServerSearch = (
  input: ServerSearchGatingInput,
): boolean => {
  if (!input.supported || input.abnormalCount !== 0) {
    return false;
  }
  if (input.enabled) {
    return true;
  }
  return !isViewFullyLoaded(input.loadedRecordCount, input.totalRecordCount);
};
