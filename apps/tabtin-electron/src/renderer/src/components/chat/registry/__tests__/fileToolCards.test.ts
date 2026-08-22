/**
 * fileToolCards — 文件类工具的 output extractor 契约测试。
 *
 * **为什么单独建测试**：W14 修问题 2（read_file 序号重复）时发现根因是
 * read_file 工具协议从 `${行号}|内容` 改成 `${行号}\t内容`，但前端
 * `stripLineNumbers` 的 pattern 没跟着改。这种"前端必须解析后端 schema"的
 * 对齐点是协议演化的高风险地带——一次 commit 的协议变化就能让整个 file 卡片
 * 渲染瘫痪，但因为 LLM 看到的 content 还是行号化字符串，错误极隐蔽。
 *
 * 本测试守住几条关键契约：
 *   1. extractFileRead 能识别新协议（content + contentRaw + start_line）
 *   2. extractFileRead 能识别旧协议（仅 content，给历史会话回放）
 *   3. extractDiff 的标准 schema 和多 hunks 兼容路径
 *
 * 下次协议演化时，跑这套测试就能立刻知道前端 extractor 是否需要跟上。
 */

import { describe, it, expect } from 'vitest'
import {
  extractFileRead,
  extractDiff,
  extractFileWrite,
  extractCodeSearch,
} from '../fileToolCards'

describe('extractFileRead — read_file output extractor', () => {
  it('W14 协议：透传 contentRaw / start_line / total_lines / num_lines', () => {
    const output = {
      data: {
        path: '/abs/calculator.html',
        content: '1\talpha\n2\tbeta',
        contentRaw: 'alpha\nbeta',
        start_line: 1,
        total_lines: 306,
        num_lines: 2,
      },
    }
    const result = extractFileRead(output)
    expect(result).toEqual({
      kind: 'file_read',
      path: '/abs/calculator.html',
      content: '1\talpha\n2\tbeta',
      contentRaw: 'alpha\nbeta',
      start_line: 1,
      total_lines: 306,
      num_lines: 2,
    })
  })

  it('部分读取：start_line > 1 的 offset 场景透传完整', () => {
    const output = {
      data: {
        path: '/abs/big.txt',
        content: '132\tline132',
        contentRaw: 'line132',
        start_line: 132,
        num_lines: 1,
      },
    }
    const result = extractFileRead(output)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.start_line).toBe(132)
      expect(result.contentRaw).toBe('line132')
    }
  })

  it('旧会话回放：只有 content（无 contentRaw）也认得', () => {
    const output = {
      data: {
        path: '/abs/old.txt',
        content: '1|alpha\n2|beta',
      },
    }
    const result = extractFileRead(output)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.content).toBe('1|alpha\n2|beta')
      expect(result.contentRaw).toBeUndefined()
    }
  })

  it('contentRaw 单独存在（无 content）也接受——容错防御', () => {
    const output = {
      data: {
        path: '/abs/raw.txt',
        contentRaw: 'pure content',
      },
    }
    const result = extractFileRead(output)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.contentRaw).toBe('pure content')
    }
  })

  it('non-file_read object output（无 content / contentRaw）返回 null', () => {
    expect(extractFileRead({ data: { path: '/x' } })).toBeNull()
    expect(extractFileRead(null)).toBeNull()
    expect(extractFileRead('')).toBeNull()
    expect(extractFileRead({})).toBeNull()
  })

  it('output 不带 .data 包装也能从顶层取（unwrapData 容错）', () => {
    const output = {
      path: '/abs/flat.txt',
      content: 'flat',
      contentRaw: 'flat',
    }
    const result = extractFileRead(output)
    expect(result?.kind).toBe('file_read')
  })

  it('非文本文件物化成功 → 显示已查看的文件数量', () => {
    expect(
      extractFileRead({
        success: true,
        type: 'file_materialized',
        path: '/tmp/example.png',
        file_id: 'file-1',
      }),
    ).toEqual({
      kind: 'materialized_files',
      file_count: 1,
    })
  })

  // ─── W2/W3 string output 路径（防 P1 回炉） ─────────────────────────
  //
  // W2 把 read_file 文本成功路径改成 `buildTextReadToolResult` 多行明文 string
  // （cat -n 形态）；W3 把 PDF/DOCX/XLSX 的 `runLocalDocParse` 也改走 string +
  // 顶部 `<system-reminder>` 头部的形态。前端 extractor 必须能识别 string 形
  // 态，否则 FileReadCardRenderer fallback 显示 `card.file_content_empty` —
  // 用户场景级 UI bug。三种形态都要覆盖：
  //
  //   1. cat -n 多行明文（read_file 成功）
  //   2. system-reminder only（read_file 空文件 / offset 越界 warning）
  //   3. system-reminder + body（PDF/DOCX/XLSX 解析成功）
  //
  // path 在 string 路径下 extractor 拿不到，置空串由 renderer 从 input.path 补；
  // 测试只断言 contentRaw / content 与 kind。

  it('W2 string output（cat -n 多行明文）→ 整段当 content 让 FileReadCard.stripLineNumbers 兜底解析', () => {
    const text = '1\thello\n2\tworld\n3\tfoo'
    const result = extractFileRead(text)
    expect(result).toEqual({
      kind: 'file_read',
      path: '',
      content: '1\thello\n2\tworld\n3\tfoo',
    })
  })

  it('W2 string output（system-reminder warning only）→ reminder 正文当 contentRaw 显示', () => {
    const text =
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
    const result = extractFileRead(text)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.contentRaw).toBe(
        '[Warning: the file exists but the contents are empty.]',
      )
      expect(result.content).toBeUndefined()
      expect(result.path).toBe('')
    }
  })

  it('W3 string output（PDF system-reminder + 正文）→ reminder 头 + body 拼成 contentRaw', () => {
    const text =
      '<system-reminder>Document: foo.pdf — 50 pages, 5.20MB, parsed locally from /tmp/foo.pdf</system-reminder>\n\nPage 1 body line 1\nPage 1 body line 2\nPage 2 body line 1'
    const result = extractFileRead(text)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.contentRaw).toContain(
        '[Document: foo.pdf — 50 pages, 5.20MB, parsed locally from /tmp/foo.pdf]',
      )
      expect(result.contentRaw).toContain('Page 1 body line 1')
      expect(result.contentRaw).toContain('Page 2 body line 1')
      expect(result.path).toBe('')
    }
  })

  it('W3 string output（offset 越界 system-reminder）→ 同 warning 路径处理', () => {
    const text =
      '<system-reminder>Warning: the file exists but is shorter than the provided offset (500). The file has 100 lines.</system-reminder>'
    const result = extractFileRead(text)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.contentRaw).toContain('shorter than the provided offset')
    }
  })

  it('W3 string output（DOCX 解析无 pages 字段）→ system-reminder 头 + body 拼成 contentRaw', () => {
    const text =
      '<system-reminder>Document: report.docx — 0.05MB, parsed locally from /tmp/report.docx</system-reminder>\n\nReport body paragraph one.'
    const result = extractFileRead(text)
    expect(result?.kind).toBe('file_read')
    if (result?.kind === 'file_read') {
      expect(result.contentRaw).toContain(
        '[Document: report.docx — 0.05MB, parsed locally from /tmp/report.docx]',
      )
      expect(result.contentRaw).toContain('Report body paragraph one.')
    }
  })
})

describe('extractDiff — edit_file output extractor', () => {
  it('Git 模式 apply_patch：从 changes.unified_diff 提取多文件差异', () => {
    const result = extractDiff({
      changes: {
        'src/a.ts': { unified_diff: '@@ -2,2 +2,2 @@\n keep\n-old\n+new' },
        'src/b.ts': { unified_diff: '@@ -1 +1 @@\n-before\n+after' },
      },
    }) as ToolOutputData & { hunks?: Array<Record<string, unknown>> }

    expect(result.file).toBe('src/a.ts')
    expect(result.hunks).toHaveLength(2)
    expect(result.hunks?.[0]).toMatchObject({
      file: 'src/a.ts',
      old_start_line: 2,
      new_start_line: 2,
      old_lines: ['old'],
      new_lines: ['new'],
    })
    expect(result.hunks?.[1]).toMatchObject({
      file: 'src/b.ts',
      old_lines: ['before'],
      new_lines: ['after'],
    })
  })

  it('Git 模式 apply_patch：同一文件的多个 hunk 保留各自行号', () => {
    const result = extractDiff({
      changes: {
        'src/a.ts': {
          unified_diff: '@@ -10 +10 @@\n-old-10\n+new-10\n@@ -500 +501 @@\n-old-500\n+new-501',
        },
      },
    }) as ToolOutputData & { hunks?: Array<Record<string, unknown>> }

    expect(result.hunks).toEqual([
      expect.objectContaining({ old_start_line: 10, new_start_line: 10, old_lines: ['old-10'], new_lines: ['new-10'] }),
      expect.objectContaining({ old_start_line: 500, new_start_line: 501, old_lines: ['old-500'], new_lines: ['new-501'] }),
    ])
  })

  it('Git 模式 apply_patch：支持纯新增与纯删除 hunk', () => {
    const added = extractDiff({ changes: { 'new.ts': { unified_diff: '@@ -0,0 +1,2 @@\n+one\n+two' } } }) as ToolOutputData
    const deleted = extractDiff({ changes: { 'old.ts': { unified_diff: '@@ -4,2 +0,0 @@\n-one\n-two' } } }) as ToolOutputData

    expect(added).toMatchObject({ old_lines: [], new_lines: ['one', 'two'], start_line: 1 })
    expect(deleted).toMatchObject({ old_lines: ['one', 'two'], new_lines: [], start_line: 0 })
  })

  it('标准 schema：单 hunk 的 old_lines / new_lines', () => {
    const output = {
      data: {
        file: '/abs/calc.html',
        start_line: 7,
        end_line: 136,
        old_lines: ['old1', 'old2'],
        new_lines: ['new1', 'new2', 'new3'],
        replacements: 1,
      },
    }
    const result = extractDiff(output)
    expect(result).toEqual({
      kind: 'diff',
      file: '/abs/calc.html',
      start_line: 7,
      end_line: 136,
      old_lines: ['old1', 'old2'],
      new_lines: ['new1', 'new2', 'new3'],
      replacements: 1,
    })
  })

  it('外部 Agent batch-edit 形态（edits[] 数组）合并为单 hunk', () => {
    const output = {
      data: {
        file: '/abs/multi.ts',
        edits: [
          { start_line: 10, end_line: 12, old_lines: ['a'], new_lines: ['A'], replacements: 1 },
          { start_line: 30, end_line: 32, old_lines: ['b'], new_lines: ['B'], replacements: 1 },
        ],
      },
    }
    const result = extractDiff(output)
    expect(result?.kind).toBe('diff')
    if (result?.kind === 'diff') {
      expect(result.start_line).toBe(10)
      expect(result.end_line).toBe(32)
      expect(result.old_lines).toEqual(['a', 'b'])
      expect(result.new_lines).toEqual(['A', 'B'])
      expect(result.replacements).toBe(2)
    }
  })

  it('字符串形式的 old_string / new_string 兼容路径', () => {
    const output = {
      data: {
        file: '/abs/strs.ts',
        start_line: 5,
        old_string: 'line1\nline2',
        new_string: 'newline1\nnewline2\nnewline3',
      },
    }
    const result = extractDiff(output)
    expect(result?.kind).toBe('diff')
    if (result?.kind === 'diff') {
      expect(result.old_lines).toEqual(['line1', 'line2'])
      expect(result.new_lines).toEqual(['newline1', 'newline2', 'newline3'])
    }
  })

  it('既无 old_lines 也无 old_string 则返回 null', () => {
    expect(extractDiff({ data: { file: '/x' } })).toBeNull()
    expect(extractDiff(null)).toBeNull()
  })

  it('edits[] 为空数组退化到非 batch-edit 路径', () => {
    const output = { data: { file: '/abs/empty.ts', edits: [] } }
    expect(extractDiff(output)).toBeNull()
  })
})

// ─── T2 final R2/R3：extractCodeSearch 0 匹配文案识别 ───────────────────────
//
// **为什么单独建测试**：T2 final reviewer R2 / R3 共识发现 SEV-1 残腕——
// count 模式 0 匹配输出**双段
// 复合文案**：
//   `No matches found.\n\nFound 0 total occurrences across 0 files.`
// 而前端 ZERO_RESULT_OUTPUTS Set 只装单段字符串 → trim 后整段不命中 →
// 卡片把 2 行非空内容当 2 条假匹配显示「找到 2 条」，跟 LLM 看到的「0 匹配」反向。
// 修法：识别「整段输出 = 多个 ZERO_RESULT_OUTPUTS 行的（含 truncate 行 + 空行过滤）」。

describe('extractCodeSearch — T2 final R2/R3：count 模式 0 匹配复合文案识别', () => {
  it('count 模式 0 匹配双段复合文案 → 0 matches（不是 2 条假匹配）', () => {
    const output = {
      data: {
        success: true,
        output: 'No matches found.\n\nFound 0 total occurrences across 0 files.',
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toEqual([])
      expect(result.match_count).toBe(0)
    }
  })

  it('content 模式单段 "No matches found." → 0 matches（向后兼容）', () => {
    const output = { data: { success: true, output: 'No matches found.' } }
    const result = extractCodeSearch(output)
    expect(result?.match_count).toBe(0)
    expect(result?.kind === 'code_search' && result.matches).toEqual([])
  })

  it('files_with_matches 模式 "No files found." → 0 matches', () => {
    const output = { data: { success: true, output: 'No files found.' } }
    const result = extractCodeSearch(output)
    expect(result?.match_count).toBe(0)
  })

  it('截断说明行被过滤（不当假匹配）', () => {
    const output = {
      data: {
        success: true,
        output:
          'src/foo.ts:10:hello\n\n... truncated (showing 1 of 5, offset=0). Use offset=1 for next page.',
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].file).toBe('src/foo.ts')
    }
  })

  it('真正的多匹配仍正确解析', () => {
    const output = {
      data: {
        success: true,
        output: 'src/a.ts:5:foo\nsrc/b.ts:10:bar',
        total_matches: 2,
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toHaveLength(2)
      expect(result.match_count).toBe(2)
    }
  })

  // T2 follow-up B3 / E2 (2026-05-12)：B3 给 grep files_with_matches 加 "Found N files" 汇总头
  // —— extractor 必须跳过这行，否则会被当成第 1 条假匹配（路径列表前多 1 个 chrome 行）
  it('B3：跳过 grep files_with_matches 的 "Found N files" 汇总头', () => {
    const output = {
      data: {
        success: true,
        output: 'Found 3 files\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts',
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toHaveLength(3)
      expect(result.matches[0].file).toBe('src/a.ts')
      expect(result.matches[1].file).toBe('src/b.ts')
      expect(result.matches[2].file).toBe('src/c.ts')
    }
  })

  it('B3：截断时 "Found N files (limit: 250, offset: 0)" 头同款跳过', () => {
    const output = {
      data: {
        success: true,
        output:
          'Found 5 files (limit: 2, offset: 0)\nsrc/a.ts\nsrc/b.ts\n\n... truncated (showing 2 of 5, offset=0). Use offset=2 for next page.',
        total_matches: 5,
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toHaveLength(2)
      expect(result.matches[0].file).toBe('src/a.ts')
      expect(result.match_count).toBe(5) // 用 total_matches 真值
    }
  })

  // T2 follow-up E2：纯路径行（glob_search / grep files_with_matches 无 :N: 边界）
  // 应该填 file 字段让 CodeSearchCard title 显示文件名，而不是 file:'' 让 title 空
  it('E2：纯路径行 → file 填路径，让卡片 title 显示文件名', () => {
    const output = {
      data: {
        success: true,
        output: 'src/components/Foo.tsx\nsrc/utils/bar.ts',
        total_files: 2,
      },
    }
    const result = extractCodeSearch(output)
    expect(result?.kind).toBe('code_search')
    if (result?.kind === 'code_search') {
      expect(result.matches).toHaveLength(2)
      expect(result.matches[0].file).toBe('src/components/Foo.tsx')
      expect(result.matches[0].text).toBe('')
      expect(result.matches[1].file).toBe('src/utils/bar.ts')
    }
  })
})

describe('extractFileWrite — write_file output extractor', () => {
  it('标准 schema：path + size', () => {
    const output = { data: { path: '/abs/new.txt', size: 1024 } }
    const result = extractFileWrite(output)
    expect(result).toEqual({ kind: 'file_write', path: '/abs/new.txt', size: 1024 })
  })

  it('size 缺失返回 undefined（不抛错）', () => {
    const output = { data: { path: '/abs/new.txt' } }
    const result = extractFileWrite(output)
    expect(result?.kind).toBe('file_write')
    if (result?.kind === 'file_write') {
      expect(result.size).toBeUndefined()
    }
  })

  it('无 path 返回 null', () => {
    expect(extractFileWrite({ data: {} })).toBeNull()
    expect(extractFileWrite(null)).toBeNull()
  })
})
