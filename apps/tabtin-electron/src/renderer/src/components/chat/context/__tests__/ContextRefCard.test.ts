import { describe, expect, it } from 'vitest'

import { isContextRefBlock, isWebContextRefBlock } from '../ContextRefCard'

describe('ContextRefCard context block detection', () => {
  it('treats webpage blocks as context references for sent-message history', () => {
    expect(isContextRefBlock({
      type: 'webpage',
      preview: '当前浏览器窗口',
      url: 'https://example.com/current',
      page_title: 'Example',
    })).toBe(true)
  })

  it('routes webpage blocks through browser-source navigation', () => {
    expect(isWebContextRefBlock({ type: 'webpage', url: 'https://example.com/current' })).toBe(true)
    expect(isWebContextRefBlock({ type: 'web_selection', url: 'https://example.com/current' })).toBe(true)
    expect(isWebContextRefBlock({ type: 'web_annotation', url: 'https://example.com/current' })).toBe(true)
    expect(isWebContextRefBlock({ type: 'document', doc_id: 'doc-1' })).toBe(false)
  })

  it('#2595：TabVideo @ 引用（有 video_id）才算上下文引用', () => {
    expect(isContextRefBlock({ type: 'video', video_id: 'vid_001', preview: 'Demo' })).toBe(true)
  })

  it('#2595：用户上传视频附件（file_id/url/source）不算上下文引用黄条', () => {
    expect(isContextRefBlock({
      type: 'video',
      file_id: 'f-1',
      filename: 'clip.mp4',
      url: 'https://cdn.example.com/clip.mp4',
    })).toBe(false)
    expect(isContextRefBlock({
      type: 'video',
      source: { type: 'url', url: 'https://cdn.example.com/clip.mp4' },
    })).toBe(false)
  })

  it('只有带 connection_id 的 mcp_server 才显示为 focus 引用', () => {
    expect(isContextRefBlock({
      type: 'mcp_server',
      connection_id: 'conn-1',
      server_name: 'github',
    })).toBe(true)
    expect(isContextRefBlock({ type: 'mcp_server' })).toBe(false)
  })

  it('#7309：TabDoc @ 引用（有 doc_id）才算上下文引用', () => {
    expect(isContextRefBlock({ type: 'document', doc_id: 'doc-1', preview: '需求' })).toBe(true)
  })

  it('#7309：LLM/上传 DocumentBlock（无 doc_id）不算「文档」蓝条', () => {
    expect(isContextRefBlock({
      type: 'document',
      title: 'brief.xlsx',
      source: { type: 'url', url: 'https://cdn.example.com/brief.xlsx' },
    })).toBe(false)
    expect(isContextRefBlock({ type: 'document' })).toBe(false)
  })

  it('#8096：云盘 / TabFiles @ 引用（file_id + preview、无附件字段）算上下文引用', () => {
    expect(isContextRefBlock({
      type: 'file',
      file_id: '0ba8b5e3-9ea6-4939-8a25-2a508000ccc1',
      preview: 'IMG_8380.PNG',
    })).toBe(true)
  })

  it('#8096：用户上传文件附件（filename/size/url）不算上下文引用卡', () => {
    expect(isContextRefBlock({
      type: 'file',
      file_id: 'f-1',
      filename: 'brief.pdf',
      size: 140,
      url: 'https://cdn.example.com/brief.pdf',
    })).toBe(false)
    expect(isContextRefBlock({
      type: 'file',
      file_id: 'f-2',
      filename: 'a.png',
      size: 0,
    })).toBe(false)
    expect(isContextRefBlock({ type: 'file' })).toBe(false)
  })
})
