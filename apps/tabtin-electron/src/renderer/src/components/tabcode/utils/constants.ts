/**
 * 搜索索引构建时跳过的目录/文件名。
 *
 * **不是 UI 隐藏黑名单**——文件树渲染（TabCodeFileTree）一律显示所有
 * entries，对标常见代码编辑器 默认行为。这份黑名单只在 useFileSearch
 * 的 BFS 索引构建里生效，作用是性能保护：
 *
 *   - 索引硬上限 10000 条（见 useFileSearch.ts buildSharedIndex）
 *   - 一旦 `node_modules` / `.git` 进队列，几次 readDir 就吃光配额，
 *     用户写的源代码反而搜不到
 *   - 所以这里挡掉的都是"用户/Agent 在 quick-open 里基本不会想找"的
 *     依赖/缓存/系统垃圾，让 10000 配额留给真正的源码
 *
 * 长期方案是按 `.gitignore` 过滤，但实现复杂（需要解析 gitignore +
 * 多层 ignore 文件叠加），不在本次范围。
 */
export const SEARCH_INDEX_SKIP_NAMES = new Set([
  'node_modules', '__pycache__', 'venv', '.venv', '.git',
  '.DS_Store', '.idea', '.vscode', '.cursor', 'dist', 'build',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'coverage',
  '.tox', '.mypy_cache', '.pytest_cache', 'egg-info',
  'Thumbs.db', '.Spotlight-V100', '.Trashes',
])

export { validateFileName, INVALID_FILE_NAME_CHARS } from '@components/shared/file-ops'

export const ROW_HEIGHT = 26
export const TREE_INDENT = 14
