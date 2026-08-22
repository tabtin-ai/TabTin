import { describe, expect, it, vi } from 'vitest'
import { parseResourcePointer } from '@tabtin/resource-router'

import {
  isAbsoluteLocalPath,
  normalizeLocalPath,
  resolveLocalFilePath,
  resolveLocalFileResource,
  shouldResolveAsLocalFile,
  stripShellPathQuotes,
} from '../localFileResourceResolver'

describe('localFileResourceResolver', () => {
  it('stripShellPathQuotes 剥成对与孤立引号 ', () => {
    expect(stripShellPathQuotes('foo.m4a"')).toBe('foo.m4a')
    expect(stripShellPathQuotes('"foo.m4a"')).toBe('foo.m4a')
    expect(stripShellPathQuotes("'foo.m4a'")).toBe('foo.m4a')
    expect(stripShellPathQuotes('foo.m4a')).toBe('foo.m4a')
  })

  it('识别 tabfiles hint 的 self-format file pointer', () => {
    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    expect(shouldResolveAsLocalFile(pointer)).toBe(true)
  })

  it('FileRecord UUID / oss_file 不走本地 working_dir 解析 ', () => {
    const fileId = '550e8400-e29b-41d4-a716-446655440000'
    const uuidPointer = parseResourcePointer(
      `tabtin://resource/file/${fileId}?hint=tabfiles&title=chart.png`,
    )
    expect(shouldResolveAsLocalFile(uuidPointer)).toBe(false)

    const ossMetaPointer = parseResourcePointer(
      `tabtin://resource/file/${fileId}?hint=tabfiles`,
    )
    ossMetaPointer.meta = { artifact_kind: 'oss_file', access_url: 'https://cdn.example.com/x.png' }
    expect(shouldResolveAsLocalFile(ossMetaPointer)).toBe(false)
  })

  it('按扩展名识别 json 本地文件 pointer', () => {
    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Fdata.json')
    expect(shouldResolveAsLocalFile(pointer)).toBe(true)
  })

  it('安全解析 working_dir 内 .xlsx 相对路径并检查文件存在', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 1024,
      mtimeMs: 1710000000000,
    })
    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')

    const params = await resolveLocalFileResource({
      pointer,
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/report.xlsx')
    expect(params).toMatchObject({
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        file_type: 'xlsx',
        relative_path: 'artifacts/report.xlsx',
        filename: 'report.xlsx',
        working_dir: '/Users/me/space',
        absolute_path: '/Users/me/space/artifacts/report.xlsx',
        path: '/Users/me/space/artifacts/report.xlsx',
        source: 'working_dir',
        local_file_refresh_token: '/Users/me/space/artifacts/report.xlsx:1024:1710000000000',
      },
    })
  })

  it('解析时剥掉相对路径尾部引号再查盘 ', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 2048,
      mtimeMs: 1710000000000,
    })
    // %22 = "
    const pointer = parseResourcePointer(
      'tabtin://resource/file/245TES.f30280.m4a%22?hint=tabfiles',
    )

    const resolved = await resolveLocalFilePath({
      pointer,
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/245TES.f30280.m4a')
    expect(resolved).toMatchObject({
      relativePath: '245TES.f30280.m4a',
      filename: '245TES.f30280.m4a',
      absolutePath: '/Users/me/space/245TES.f30280.m4a',
    })
  })

  it('每次解析本地文件都会带刷新时间戳，供已打开预览重读', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValueOnce(1710000000123).mockReturnValueOnce(1710000000456)
    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
    })

    const first = await resolveLocalFileResource({
      pointer,
      workingDir: '/Users/me/space',
      pathExists,
    })
    const second = await resolveLocalFileResource({
      pointer,
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(first?.meta?.local_file_refresh_token).toBe('/Users/me/space/artifacts/report.xlsx:unknown:1710000000123')
    expect(second?.meta?.local_file_refresh_token).toBe('/Users/me/space/artifacts/report.xlsx:unknown:1710000000456')
    expect(second?.meta?.local_file_refreshed_at).toBe(1710000000456)
    dateNow.mockRestore()
  })

  it('拒绝绝对路径', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/%2Ftmp%2Freport.xlsx?hint=tabfiles'),
      workingDir: '/Users/me/space',
    })).rejects.toThrow('只支持 Agent 工作目录内的相对路径')
  })

  it('拒绝路径穿越', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/..%2Freport.xlsx?hint=tabfiles'),
      workingDir: '/Users/me/space',
    })).rejects.toThrow('文件路径不可用')
  })

  it('拒绝临时目录根', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/tmp%2Freport.xlsx?hint=tabfiles'),
      workingDir: '/Users/me/space',
    })).rejects.toThrow('不支持打开临时目录里的本地产物')
  })

  it('安全解析 working_dir 内 .docx / .pdf 相对路径', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 2048,
      mtimeMs: 1710000000000,
    })

    const docx = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Freport.docx?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(docx?.meta?.file_type).toBe('docx')

    const pdf = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fsummary.pdf?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(pdf?.meta?.file_type).toBe('pdf')

    const pptx = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fdeck.pptx?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(pptx?.meta?.file_type).toBe('pptx')
  })

  it('安全解析 working_dir 内 .json 相对路径并走文本预览类型', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 128,
      mtimeMs: 1710000000000,
    })

    const params = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fdata.json?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/data.json')
    expect(params?.meta?.file_type).toBe('json')
    expect(params?.meta?.absolute_path).toBe('/Users/me/space/artifacts/data.json')
  })

  it('安全解析 working_dir 内 .txt 相对路径并走文本预览类型', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 64,
      mtimeMs: 1710000000000,
    })

    const params = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fnotes.txt?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/notes.txt')
    expect(params?.meta?.file_type).toBe('txt')
    expect(params?.meta?.absolute_path).toBe('/Users/me/space/artifacts/notes.txt')
  })

  it('安全解析 working_dir 内 .csv 相对路径并走 CSV 表格预览类型', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 128,
      mtimeMs: 1710000000000,
    })

    const params = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Freport.csv?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/report.csv')
    expect(params?.meta?.file_type).toBe('csv')
    expect(params?.meta?.absolute_path).toBe('/Users/me/space/artifacts/report.csv')
  })

  it('安全解析 working_dir 内 .svg / .png 图片产物', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 512,
      mtimeMs: 1710000000000,
    })

    const svg = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fdiagram.svg?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(svg?.meta?.file_type).toBe('image')
    expect(svg?.meta?.absolute_path).toBe('/Users/me/space/artifacts/diagram.svg')

    const png = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fscreenshot.png?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(png?.meta?.file_type).toBe('image')
  })

  it('安全解析音视频与常见文本产物', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 1024,
      mtimeMs: 1710000000000,
    })

    const m4a = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fclip.m4a?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(m4a?.meta?.file_type).toBe('audio')

    const mp4 = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fdemo.mp4?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(mp4?.meta?.file_type).toBe('video')

    const yaml = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fconfig.yaml?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(yaml?.meta?.file_type).toBe('text')

    const tsv = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Ftable.tsv?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(tsv?.meta?.file_type).toBe('csv')

    // 最长后缀：.mts 不应被 .ts 吞掉
    const mts = await resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fmod.mts?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })
    expect(mts?.meta?.file_type).toBe('text')
  })

  it('拒绝非支持格式的本地产物', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Freport.bin?hint=tabfiles'),
      workingDir: '/Users/me/space',
    })).rejects.toThrow(/当前只支持打开 .* 本地产物/)
  })

  it('非预览格式仍可解析为本地绝对路径，供系统打开和文件管理器定位', async () => {
    const pathExists = vi.fn().mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      size: 256,
      mtimeMs: 1710000000000,
    })

    const resolved = await resolveLocalFilePath({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Farchive.zip?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists,
    })

    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/archive.zip')
    expect(resolved).toEqual(expect.objectContaining({
      relativePath: 'artifacts/archive.zip',
      filename: 'archive.zip',
      workingDir: '/Users/me/space',
      absolutePath: '/Users/me/space/artifacts/archive.zip',
    }))
  })

  it('没有 working_dir 时给出设置工作目录语义', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles'),
      workingDir: '',
    })).rejects.toThrow('需要先设置或创建 Agent 工作目录')
  })

  it('文件不存在时给出已删除或不可用语义', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/artifacts%2Fmissing.xlsx?hint=tabfiles'),
      workingDir: '/Users/me/space',
      pathExists: vi.fn().mockResolvedValue({
        success: true,
        exists: false,
      }),
    })).rejects.toThrow('文件已删除或不可用')
  })

  it('非本地 artifact file id 返回 null，交回旧路由', async () => {
    await expect(resolveLocalFileResource({
      pointer: parseResourcePointer('tabtin://resource/file/cloud-file-id'),
      workingDir: '/Users/me/space',
    })).resolves.toBeNull()
  })

  it('路径 helper 覆盖 Unix 和 Windows 形态', () => {
    expect(normalizeLocalPath('/Users/me/space/../space/artifacts/report.xlsx'))
      .toBe('/Users/me/space/artifacts/report.xlsx')
    expect(normalizeLocalPath('C:\\Users\\me\\space\\artifacts\\report.xlsx'))
      .toBe('C:/Users/me/space/artifacts/report.xlsx')
    expect(isAbsoluteLocalPath('/Users/me/space')).toBe(true)
    expect(isAbsoluteLocalPath('C:/Users/me/space')).toBe(true)
    expect(isAbsoluteLocalPath('artifacts/report.xlsx')).toBe(false)
  })
})
