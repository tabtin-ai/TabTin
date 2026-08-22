import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ExternalArchivePrefixBubble,
  parseExternalArchivePrefix,
  resolveImportSourceLabel,
} from '../messages/system/ExternalArchivePrefixBubble'

describe('ExternalArchivePrefixBubble', () => {
  it('resolveImportSourceLabel 映射已知来源', () => {
    expect(resolveImportSourceLabel('codex')).toBe('Codex')
    expect(resolveImportSourceLabel('cursor')).toBe('Cursor')
    expect(resolveImportSourceLabel('unknown_tool')).toBe('unknown_tool')
  })

  it('从结构化 metadata 解析前缀', () => {
    const info = parseExternalArchivePrefix({
      content: 'Codex 历史 · 理解连接',
      metadata: {
        system_fact: 'external_archive_prefix',
        external_archive: true,
        source: 'codex',
        title: '理解连接和请求区别',
        cwd: '/tmp/f',
      },
    })
    expect(info).toMatchObject({
      source: 'codex',
      sourceLabel: 'Codex',
      title: '理解连接和请求区别',
      cwd: '/tmp/f',
    })
  })

  it('兼容旧版长文前缀', () => {
    const info = parseExternalArchivePrefix({
      content: [
        '【外部历史 · 特殊新对话】',
        '来源：Codex',
        '原工作目录：/Users/seda/workspace/repos/FIClash',
        '原会话：理解连接和请求区别',
        '以下内容来自外部工具历史…',
      ].join('\n'),
      metadata: null,
    })
    expect(info?.sourceLabel).toBe('Codex')
    expect(info?.title).toBe('理解连接和请求区别')
    expect(info?.cwd).toContain('FIClash')
  })

  it('渲染简洁横幅而非整段长文', () => {
    render(
      <ExternalArchivePrefixBubble
        info={{
          source: 'codex',
          sourceLabel: 'Codex',
          title: '理解连接和请求区别',
          cwd: '/tmp/f',
        }}
      />,
    )
    const banner = screen.getByTestId('external-archive-prefix-banner')
    expect(banner.textContent).toContain('新任务')
    expect(banner.textContent).toContain('来自 Codex')
    expect(banner.textContent).toContain('理解连接和请求区别')
    expect(banner.textContent).toContain('交给小 Tin')
    expect(banner.textContent).not.toContain('【外部历史 · 特殊新对话】')
    expect(screen.getByTestId('external-archive-prefix-mascot')).toBeTruthy()
  })
})
