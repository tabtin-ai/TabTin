/**
 * 文件树 CRUD 操作 hook — 新建文件/文件夹、重命名、删除
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { getBaseName, getExtension, getParentPath, joinPath } from '@components/shared/file-utils'
import { canMoveEntryToDir } from '@components/shared/file-utils/path-ops'

export type FileTreeActionsI18nNamespace = 'tabcode' | 'context'

const FILE_OP_TOAST_OPTIONS = { preferNative: true } as const

type FileOpErrorTone = 'neutral' | 'destructive'

interface FileOpErrorDisplay {
  message: string
  tone: FileOpErrorTone
}

function readErrorField(err: unknown, field: 'code' | 'error' | 'message'): string {
  if (err === null || typeof err !== 'object') return ''
  const value = (err as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

function readLocalFileOpErrorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (err === null || typeof err !== 'object') return ''
  return [
    readErrorField(err, 'code'),
    readErrorField(err, 'error'),
    readErrorField(err, 'message'),
  ].filter(Boolean).join('\n')
}

function formatLocalFileOpError(
  err: unknown,
  fallbackMessage: string,
  writePermissionMessage: string,
): FileOpErrorDisplay {
  const rawText = readLocalFileOpErrorText(err)
  const lower = rawText.toLowerCase()

  if (
    readErrorField(err, 'code') === 'FS_PERMISSION_DENIED'
    || /\b(eacces|eperm)\b/i.test(rawText)
    || lower.includes('permission denied')
    || lower.includes('operation not permitted')
  ) {
    return { message: writePermissionMessage, tone: 'neutral' }
  }

  if (
    /\boutside (your )?workspace\b/i.test(rawText)
    || lower.includes('super permissions')
    || lower.includes('access denied')
    || lower.includes('blocked by security policy')
  ) {
    return { message: fallbackMessage, tone: 'neutral' }
  }

  return { message: formatIpcErrorForUser(rawText || err, fallbackMessage), tone: 'destructive' }
}

/**
 * 同名冲突时为新建条目找一个不冲突的名字。
 *
 * 背景：本地文件系统里同一目录下文件和文件夹共用一个路径命名空间，
 * `11` 文件已存在时再建 `11` 文件夹会被 OS 拒绝。 之前
 * 直接报「已存在」让用户自己改，反馈弱、看起来像"无响应"。这里改为
 * 自动追加 `-N` 后缀（保留文件扩展名），让创建能成功，并返回 renamed
 * 标记让上层提示用户最终用了什么名字。
 *
 * 行为：
 *   - 原名不冲突 → { name: originalName, renamed: false }
 *   - 原名冲突 → 尝试 `base-1.ext`、`base-2.ext`… 直到 maxAttempts
 *   - 全部冲突 → 返回原名，让上层调 OS 创建拿真实错误（极端情况，几乎不会触发）
 *
 * `existsFn` 注入是为了单测可控制路径存在性；运行时传 `pathAlreadyExists`。
 */
export async function resolveUniqueEntryName(
  parentPath: string,
  originalName: string,
  existsFn: (path: string) => Promise<boolean>,
  maxAttempts = 99,
): Promise<{ name: string; renamed: boolean }> {
  const directPath = joinPath(parentPath, originalName)
  if (!(await existsFn(directPath))) {
    return { name: originalName, renamed: false }
  }
  const ext = getExtension(originalName)
  const base = ext ? originalName.slice(0, -ext.length) : originalName
  for (let i = 1; i <= maxAttempts; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!(await existsFn(joinPath(parentPath, candidate)))) {
      return { name: candidate, renamed: true }
    }
  }
  return { name: originalName, renamed: false }
}

interface UseFileTreeActionsProps {
  rootPath: string | null
  onRefresh: (parentPaths: string | string[]) => void | Promise<void>
  /** TabCode 默认 tabcode；TabFolder 传 context */
  i18nNamespace?: FileTreeActionsI18nNamespace
  /**
   * TabFolder 为 false：成功静默，失败用顶部单行 toast（对齐 TabFolderHomePane）。
   * TabCode 默认 true：成功/失败均 toast。
   */
  showSuccessToast?: boolean
}

export function useFileTreeActions({
  rootPath,
  onRefresh,
  i18nNamespace = 'tabcode',
  showSuccessToast = true,
}: UseFileTreeActionsProps) {
  const { t } = useTranslation(i18nNamespace)
  const [isCreating, setIsCreating] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const formatFileOpError = useCallback((err: unknown): FileOpErrorDisplay => {
    const fallbackMessage = t('fileOps.genericDenied', {
      defaultValue: '操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。',
    })
    return formatLocalFileOpError(
      err,
      fallbackMessage,
      t('fileOps.noWritePermission', {
        defaultValue: '当前目录没有写入权限，无法完成本次文件操作。请修改目录权限，或选择可写目录。',
      }),
    )
  }, [t])

  const notifySuccess = useCallback((title: string) => {
    if (showSuccessToast) {
      toast({ title, ...FILE_OP_TOAST_OPTIONS })
    }
  }, [showSuccessToast])

  const notifyFailure = useCallback((title: string, error?: FileOpErrorDisplay | string) => {
    const description = typeof error === 'string' ? error : error?.message
    const variant = typeof error === 'string'
      ? undefined
      : error?.tone === 'destructive'
        ? 'destructive'
        : undefined
    if (showSuccessToast) {
      toast({ title, description, ...(variant ? { variant } : {}), ...FILE_OP_TOAST_OPTIONS })
      return
    }
    toast({ title: description ?? title, ...(variant ? { variant } : {}), ...FILE_OP_TOAST_OPTIONS })
  }, [showSuccessToast])

  /**
   * 同名冲突自动去重后必须告诉用户最终用了什么名字——这条提示不受
   * `showSuccessToast` 控制：FileExplorerPane 用 false 是为了"成功就静默"，
   * 但自动改名属于用户必须看见的信息，否则会以为建错了。
   */
  const notifyRenamed = useCallback((original: string, finalName: string) => {
    toast({
      title: t('fileOps.createSuccessRenamed', {
        original,
        name: finalName,
        defaultValue: `「${original}」已被占用，已命名为「${finalName}」`,
      }),
      duration: 4000,
      ...FILE_OP_TOAST_OPTIONS,
    })
  }, [t])

  const pathAlreadyExists = useCallback(async (targetPath: string): Promise<boolean> => {
    try {
      const fs = window.tabtin?.fileSystem
      if (fs?.pathExists) {
        const result = await fs.pathExists(targetPath)
        return !!result?.exists
      }
      const preview = await fs.readFilePreview(targetPath, { maxBytes: 1 })
      return !!preview?.success
    } catch {
      return false
    }
  }, [])

  const ensureParentWritable = useCallback(async (parentPath: string): Promise<boolean> => {
    if (!(await pathAlreadyExists(parentPath))) {
      notifyFailure(
        t('fileOps.createFailed'),
        t('fileOps.parentMissing', {
          defaultValue: '目标文件夹已不存在（可能被移动或改名），请刷新或重新选择目录后再试。',
        }),
      )
      return false
    }
    if (rootPath && !(await pathAlreadyExists(rootPath))) {
      notifyFailure(
        t('fileOps.createFailed'),
        t('fileOps.rootMissing', {
          defaultValue: '目录根路径已不可访问，请重新选择目录后再试。',
        }),
      )
      return false
    }
    return true
  }, [notifyFailure, pathAlreadyExists, rootPath, t])

  const createFile = useCallback(
    async (parentPath: string, name: string): Promise<boolean> => {
      if (!rootPath) return false
      setIsCreating(true)
      try {
        if (!(await ensureParentWritable(parentPath))) return false
        const resolved = await resolveUniqueEntryName(parentPath, name, pathAlreadyExists)
        const filePath = joinPath(parentPath, resolved.name)
        const result = await window.tabtin.fileSystem.writeFile(filePath, '')
        if (result.success) {
          if (resolved.renamed) {
            notifyRenamed(name, resolved.name)
          } else {
            notifySuccess(t('fileOps.createSuccess', { name }))
          }
          await onRefresh(parentPath)
          return true
        }
        notifyFailure(t('fileOps.createFailed'), formatFileOpError(result))
        return false
      } catch (err) {
        notifyFailure(t('fileOps.createFailed'), formatFileOpError(err))
        return false
      } finally {
        setIsCreating(false)
      }
    },
    [rootPath, onRefresh, t, formatFileOpError, pathAlreadyExists, notifySuccess, notifyFailure, notifyRenamed, ensureParentWritable],
  )

  const createDirectory = useCallback(
    async (parentPath: string, name: string): Promise<boolean> => {
      if (!rootPath) return false
      setIsCreating(true)
      try {
        if (!(await ensureParentWritable(parentPath))) return false
        const resolved = await resolveUniqueEntryName(parentPath, name, pathAlreadyExists)
        const dirPath = joinPath(parentPath, resolved.name)
        const result = await window.tabtin.fileSystem.createDir(dirPath)
        if (result.success) {
          if (resolved.renamed) {
            notifyRenamed(name, resolved.name)
          } else {
            notifySuccess(t('fileOps.createSuccess', { name }))
          }
          await onRefresh(parentPath)
          return true
        }
        notifyFailure(t('fileOps.createFailed'), formatFileOpError(result))
        return false
      } catch (err) {
        notifyFailure(t('fileOps.createFailed'), formatFileOpError(err))
        return false
      } finally {
        setIsCreating(false)
      }
    },
    [rootPath, onRefresh, t, formatFileOpError, pathAlreadyExists, notifySuccess, notifyFailure, notifyRenamed, ensureParentWritable],
  )

  const rename = useCallback(
    async (absolutePath: string, newName: string): Promise<boolean> => {
      if (!rootPath) return false
      setIsRenaming(true)
      try {
        const parentPath = getParentPath(absolutePath) || rootPath
        const newPath = joinPath(parentPath, newName)
        if (newPath !== absolutePath && await pathAlreadyExists(newPath)) {
          notifyFailure(
            t('fileOps.renameFailed'),
            t('fileOps.alreadyExists', { name: newName, defaultValue: `"${newName}" already exists` }),
          )
          return false
        }
        const result = await window.tabtin.fileSystem.rename(absolutePath, newPath)
        if (result.success) {
          notifySuccess(t('fileOps.renameSuccess', { name: newName }))
          await onRefresh(parentPath)
          return true
        }
        notifyFailure(t('fileOps.renameFailed'), formatFileOpError(result))
        return false
      } catch (err) {
        notifyFailure(t('fileOps.renameFailed'), formatFileOpError(err))
        return false
      } finally {
        setIsRenaming(false)
      }
    },
    [rootPath, onRefresh, t, formatFileOpError, pathAlreadyExists, notifySuccess, notifyFailure],
  )

  const moveToDirectory = useCallback(
    async (absolutePath: string, targetDirPath: string): Promise<boolean> => {
      if (!rootPath) return false
      if (!canMoveEntryToDir(absolutePath, targetDirPath)) return false

      const fileName = getBaseName(absolutePath)
      const newPath = joinPath(targetDirPath, fileName)
      const parentPath = getParentPath(absolutePath) || rootPath

      if (await pathAlreadyExists(newPath)) {
        notifyFailure(
          t('fileOps.moveFailed', { defaultValue: '移动失败' }),
          t('fileOps.alreadyExists', { name: fileName, defaultValue: `"${fileName}" already exists` }),
        )
        return false
      }

      setIsRenaming(true)
      try {
        const result = await window.tabtin.fileSystem.rename(absolutePath, newPath)
        if (result.success) {
          notifySuccess(t('fileOps.moveSuccess', { name: fileName, defaultValue: `已移动 ${fileName}` }))
          await onRefresh([parentPath, targetDirPath])
          return true
        }
        notifyFailure(t('fileOps.moveFailed', { defaultValue: '移动失败' }), formatFileOpError(result))
        return false
      } catch (err) {
        notifyFailure(t('fileOps.moveFailed', { defaultValue: '移动失败' }), formatFileOpError(err))
        return false
      } finally {
        setIsRenaming(false)
      }
    },
    [rootPath, onRefresh, t, formatFileOpError, pathAlreadyExists, notifySuccess, notifyFailure],
  )

  const deleteItem = useCallback(
    async (absolutePath: string, isDirectory: boolean) => {
      if (!rootPath) return
      setIsDeleting(true)
      try {
        const parentPath = getParentPath(absolutePath) || rootPath
        const result = isDirectory
          ? await window.tabtin.fileSystem.deleteDir(absolutePath)
          : await window.tabtin.fileSystem.deleteFile(absolutePath)
        if (result.success) {
          notifySuccess(t('fileOps.deleteSuccess'))
          await onRefresh(parentPath)
        } else {
          notifyFailure(t('fileOps.deleteFailed'), formatFileOpError(result))
        }
      } catch (err) {
        notifyFailure(t('fileOps.deleteFailed'), formatFileOpError(err))
      } finally {
        setIsDeleting(false)
      }
    },
    [rootPath, onRefresh, t, formatFileOpError, notifySuccess, notifyFailure],
  )

  return {
    createFile,
    createDirectory,
    rename,
    moveToDirectory,
    deleteItem,
    isCreating,
    isRenaming,
    isDeleting,
  }
}
