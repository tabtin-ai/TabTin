/**
 * useInlineEdit — 内联编辑状态管理 hook
 *
 * 封装了创建/重命名的常见交互模式：
 * - committedRef 防止 Enter→blur 触发双重提交
 * - 自动聚焦 + 选中（重命名时）
 * - 统一的取消/提交/清理流程
 *
 * 用法：创建和重命名各用一个实例
 *   const createEdit = useInlineEdit()
 *   const renameEdit = useInlineEdit()
 */
import React, { useCallback, useRef, useState } from 'react'

export interface InlineEditState {
  value: string
  /** 被编辑的实体 ID（重命名场景） */
  id?: string
  /** 调用方自定义元数据（如实体类型、parentId 等） */
  meta?: Record<string, unknown>
}

type CommitHandler = (value: string, id?: string, meta?: Record<string, unknown>) => Promise<void>

interface InlineEditInputOptions {
  /** 创建态的空输入偶发失焦时保留编辑行；仍可用 Escape 显式取消。 */
  retainEmptyOnBlur?: boolean
}

export function useInlineEdit() {
  const [state, setState] = useState<InlineEditState | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)
  const focusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const start = useCallback((initialValue = '', id?: string, meta?: Record<string, unknown>) => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
    setState({ value: initialValue, id, meta })
    committedRef.current = false
    focusTimerRef.current = setTimeout(() => {
      inputRef.current?.focus()
      if (id) inputRef.current?.select()
    }, 50)
  }, [])

  const setValue = useCallback((value: string) => {
    setState(prev => prev ? { ...prev, value } : null)
  }, [])

  const commit = useCallback(async (onCommit: CommitHandler): Promise<boolean> => {
    if (committedRef.current || !state) { setState(null); return false }
    committedRef.current = true
    const trimmed = state.value.trim()
    if (!trimmed) { setState(null); return false }
    const snapshot = state
    setState(prev => (prev === snapshot ? null : prev))
    try {
      await onCommit(trimmed, snapshot.id, snapshot.meta)
    } catch (err) {
      console.error('[useInlineEdit] commit failed:', err)
      return false
    }
    return true
  }, [state])

  const cancel = useCallback(() => setState(null), [])

  /**
   * 返回可直接 spread 到 <input> 的 props 集合，减少模板代码。
   * 用法: <input className="..." placeholder="..." {...edit.getInputProps(onCommitHandler)} />
   */
  const getInputProps = useCallback((
    onCommit: CommitHandler,
    options?: InlineEditInputOptions,
  ) => ({
    ref: inputRef,
    value: state?.value ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    onBlur: () => {
      if (options?.retainEmptyOnBlur && !state?.value.trim()) return
      void commit(onCommit)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
      if (e.key === 'Escape') cancel()
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  }), [state, setValue, commit, cancel])

  return { state, inputRef, isActive: state !== null, start, setValue, commit, cancel, getInputProps }
}
