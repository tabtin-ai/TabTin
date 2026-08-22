/**
 * canonicalizePath — 把 path 解析成 readFileState / lock-map 用的 canonical key。
 *
 * **Wave 1.5（2026-05-13）下沉自 `packages/agent-runtime/src/tools/read-file-state.ts`。**
 * 抽到 action-tools 是因为 file-lock 模块同期下沉到 `action-tools/utils/file-lock.ts`，
 * 锁键必须用同一份 canonicalize 实现保证 read / lock / edit 跨入口归一；
 * action-tools 不能反向依赖 agent-runtime（架构方向相反），所以把 canonicalizePath
 * 抽到这里作为"两边共享的基础设施"。agent-runtime 一侧
 * `tools/read-file-state.ts` 改成 re-export 桥接，调用方零改动。
 *
 * 解决"读 / 写两端 key 不一致"的真实生产 bug：
 *   - macOS：`os.tmpdir()` → `/var/folders/...`，但 `fs.realpathSync` → `/private/var/folders/...`
 *   - Symlink：`~/dev` 软链到 `/Volumes/Data/dev` 时，两套 key 同一文件却 set/get 落不到同一格
 *   - 家目录速记：`~/.zshrc` 这类用户语言写法 —— action-tools `resolveInWorkspace`
 *     会展开 `~/`，本函数若不展开就会把 `<wsRoot>/~/.zshrc` 当 key 写进 Map，
 *     而下一轮 LLM 用绝对路径调 edit_file 时，key 完全错位 → 历史版本中
 *     "已读仍报 READ_REQUIRED" 的死循环（W1 第一轮 Review 三方独立点名；
 *     W2 删除 READ_REQUIRED 后不再以此形式表现，但 key 错位会让 stale-read
 *     校验失效 / dedup 不命中，仍是 latent bug）。
 *
 * 策略：先展开 `~/` → 绝对化 → 然后 try realpath（文件不存在时 ENOENT，回退
 * 父目录 realpath + basename，文件路径 layout 仍稳定）。read / edit / write /
 * delete / lock 全部走此函数，保证多入口 key 一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function canonicalizePath(filePath: string, baseDir?: string): string {
  const expanded =
    filePath === '~'
      ? os.homedir()
      : filePath.startsWith('~/')
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
  const abs = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(baseDir || process.cwd(), expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      const parent = fs.realpathSync(path.dirname(abs));
      return path.join(parent, path.basename(abs));
    } catch {
      return abs;
    }
  }
}
