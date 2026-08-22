import { describe, expect, it } from 'vitest'
import {
  isFileTreeNodeSelected,
  resolveNewItemParentPath,
  shouldRenderNewItemFallback,
} from './fileTreeSelection'

describe('TabCode file tree selection', () => {
  const rootPath = 'C:\\workspace\\project'

  it('在选中目录内新建', () => {
    expect(resolveNewItemParentPath(rootPath, {
      path: 'C:\\workspace\\project\\src',
      isDirectory: true,
    })).toBe('C:\\workspace\\project\\src')
  })

  it('在选中文件的父目录内新建', () => {
    expect(resolveNewItemParentPath(rootPath, {
      path: 'C:\\workspace\\project\\src\\index.ts',
      isDirectory: false,
    })).toBe('C:\\workspace\\project\\src')
  })

  it('兼容斜杠路径并在无选择时回退根目录', () => {
    expect(resolveNewItemParentPath('/workspace/project', {
      path: '/workspace/project/src/index.ts',
      isDirectory: false,
    })).toBe('/workspace/project/src')
    expect(resolveNewItemParentPath('/workspace/project', null)).toBe('/workspace/project')
  })

  it('跨 Windows 路径大小写和分隔符识别同一选中节点', () => {
    expect(isFileTreeNodeSelected(
      { path: 'C:\\工作空间\\Project\\src', isDirectory: true },
      'c:/workspace/project/src',
    )).toBe(true)
  })

  it('跨 UNC 路径大小写识别同一选中节点', () => {
    expect(isFileTreeNodeSelected(
      { path: '\\\\Server\\Share\\Project\\src', isDirectory: true },
      '//server/share/project/src',
    )).toBe(true)
  })

  it('树行不可见或无法内联时回退显示新建输入框', () => {
    expect(shouldRenderNewItemFallback(true, false, false)).toBe(true)
    expect(shouldRenderNewItemFallback(true, true, false)).toBe(true)
    expect(shouldRenderNewItemFallback(true, true, true)).toBe(false)
    expect(shouldRenderNewItemFallback(false, false, false)).toBe(false)
  })
})
