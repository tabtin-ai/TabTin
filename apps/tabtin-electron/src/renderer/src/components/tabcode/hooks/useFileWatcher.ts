/**
 * 文件变更监听 Hook（薄壳子）——给 useGitStatus 用。
 *
 * 监听整个工作区根目录（recursive），这样 Agent / 外部编辑器改工作区文件时
 * 能立刻触发 git:fullStatus 刷新（目录 M/A/D、变更列表）。
 *
 * 历史实现只 watch `.git/`（非 recursive），工作区修改靠 30s 轮询兜底——
 * Agent 改文件通常不碰 `.git`，体感就是「左边状态与 Git 区不实时」。
 * 目录树自己的 useFolderWatch 也会调 onFileSystemChange→refresh，但：
 *   1) 目录区收起时 FileTree 可能卸载，watch 随之消失
 *   2) GitWorkflowPanel 自管一份 status，不跟 refresh 挂钩（另修）
 * 因此 git status 必须自带工作区 watch，不能依赖 FileTree 存活。
 *
 * 实现委托给 useFolderWatch。debounce 略宽于 FileTree（200ms），避免与
 * 树侧 refresh 叠成 thrash；useGitStatus 的 refreshRef 也会丢弃过期结果。
 */
import { useFolderWatch } from '@hooks/useFolderWatch'

const GIT_STATUS_WATCH_DEBOUNCE_MS = 350

export function useFileWatcher(rootPath: string | null, onChange: () => void) {
  useFolderWatch(
    rootPath,
    () => {
      onChange()
    },
    { recursive: true, debounceMs: GIT_STATUS_WATCH_DEBOUNCE_MS },
  )
}
