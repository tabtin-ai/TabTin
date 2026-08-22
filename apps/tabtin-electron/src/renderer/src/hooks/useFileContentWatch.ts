import { useState, useEffect, useRef } from 'react'
import { normalizePathSeparators } from '@components/shared/file-utils/path-ops'

/**
 * 当 useFileContentWatch 检测到文件已被外部删除（rename 事件 + pathExists=false）
 * 时，version 会被设成这个哨兵值。caller 用 `version === FILE_DELETED_VERSION`
 * 判断要不要清掉 selectedFile / preview 状态——否则面板会继续展示已不存在
 * 文件的旧内容（dogfood 反馈的"鬼影"bug）。
 *
 * 选择哨兵值而不是改返回类型为 `{ version, deleted }`，是因为已有多处 caller
 * 用 `const v = useFileContentWatch(...)` 形式取值；改类型会引发大范围 caller
 * 更新，本次只追加语义、不破坏既有 API。
 */
export const FILE_DELETED_VERSION = -1

/** 与 main 端 path.resolve / Windows 盘符大小写对齐后再比，避免 Agent 改文件事件对不上。 */
function comparableWatchPath(path: string): string {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  const isWindowsPath = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

/**
 * 监听指定文件的磁盘变更，返回一个递增 version。
 * 任何依赖此 version 的 effect 会在文件被外部修改时重新执行。
 *
 * **删除语义**：当 fullPath rename 事件到达，hook 会用 `fs:pathExists`
 * 探测一次；若文件已不存在（外部 mv 走 / 删除 / Finder 拖到回收站），
 * version 被设为 `FILE_DELETED_VERSION`（-1），caller 应当借此清掉对应的
 * selectedFile / preview 状态。
 *
 * 切换 filePath 时 version 自动重置为 0，避免上次留下的 -1 哨兵污染新文件
 * 的初始状态。
 *
 * 依赖渲染进程已有的 recursive watcher 发出的 fs:watch-event，
 * 自身不创建新的 watcher。
 */
export function useFileContentWatch(filePath: string | null): number {
  const [version, setVersion] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const versionPathRef = useRef<string | null>(filePath)

  useEffect(() => {
    if (!filePath) return
    // 切换 filePath：清掉上一段 watch 留下的 -1 / 累计 version，
    // 让新 filePath 的 caller useEffect "version === 0 时 skip" 兜底失效。
    versionPathRef.current = filePath
    setVersion(0)
    const targetPath = comparableWatchPath(filePath)

    const unsub = window.tabtin.fileSystem.onWatchEvent((payload) => {
      if (!payload.fullPath) return
      if (comparableWatchPath(payload.fullPath) !== targetPath) return
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        timerRef.current = null
        if (versionPathRef.current !== filePath) return

        // rename 事件来源多：modify-via-replace / mv / 删除 / 改名。仅"还在原
        // 路径"才是 modify，否则 caller 拿不到的旧文件。pathExists 探测一次
        // 把这两类分开。pathExists 自身失败保守按"变更"处理（递增 version
        // 让 caller 走正常的 readFile 链路再面对真实错误）。
        if (payload.eventType === 'rename') {
          try {
            const result = await window.tabtin.fileSystem.pathExists(filePath)
            if (result?.success === true && !result.exists) {
              if (versionPathRef.current !== filePath) return
              setVersion(FILE_DELETED_VERSION)
              return
            }
          } catch {
            // 探测失败 → fall through 到普通递增。
          }
        }

        // 已经是 -1 的状态意味着 caller 还没消费删除信号，下一次普通变更不能
        // 直接 +1（会变 0，与"未触发"重叠语义混淆）；统一从 1 重新计数。
        if (versionPathRef.current === filePath) {
          setVersion((v) => (v < 0 ? 1 : v + 1))
        }
      }, 80)
    })
    return () => {
      unsub()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [filePath])

  // 新路径首帧不能继承旧路径的删除哨兵或累计 version。
  return versionPathRef.current === filePath ? version : 0
}

/**
 * 读取文件内容并在文件变更时自动重读。
 * 适用于只读预览场景。
 *
 * 文件被外部删除时：清空内容；caller 看到 isLoading=false + content=''
 * 的稳定空态，与文件本就不存在的展示一致（避免鬼影）。
 */
export function useWatchedFileContent(
  filePath: string | null,
  options?: { maxBytes?: number }
): { content: string; language: string; isLoading: boolean } {
  const version = useFileContentWatch(filePath)
  const [content, setContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!filePath) {
      setContent('')
      return
    }
    if (version === FILE_DELETED_VERSION) {
      setContent('')
      setIsLoading(false)
      return
    }
    let cancelled = false
    setIsLoading(true)
    window.tabtin.fileSystem
      .readFilePreview(filePath, { maxBytes: options?.maxBytes ?? 512 * 1024 })
      .then((result: any) => {
        if (cancelled) return
        setContent(result?.data?.content || '')
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => { cancelled = true }
  }, [filePath, version, options?.maxBytes])

  return { content, language: '', isLoading }
}
