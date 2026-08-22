/**
 * doc-parser-handlers — PDF/docx/xlsx 解析纯函数
 *
 * **H2-E 重构后**：实现已迁到 `@tabtin/local-docparse/workers`，本文件保留为再
 * 导出薄壳，让原有单测（`__tests__/doc-parser-handlers.test.ts`）和 worker entry
 * 无需改 import 路径即可继续工作。
 */

export {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
} from '@tabtin/local-docparse/workers'
