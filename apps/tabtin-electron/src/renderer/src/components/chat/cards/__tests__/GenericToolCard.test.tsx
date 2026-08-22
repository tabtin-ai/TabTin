/**
 * GenericToolCard — PRD 08 W14（L-24-UI）渲染优先级链 regression
 *
 * 这套测试钉死「错误显示优先级」契约：
 *   1. 最优先：i18n 翻译（toolLifecycleNotice.translateToolErrorKind 计算后传 error prop）
 *   2. 次选：envelope.error 字段（jsonError 协议第一参，capability/tools 的中文 message）
 *   3. 兜底：raw content 字符串
 *
 * 同时验证 W13 已有的 metadata 折叠 + raw JSON 折叠行为：
 *   - 技术 metadata（status / error_label / code / technical_note 等）默认折叠
 *   - raw JSON 仅在「查看原始 JSON」展开区出现
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { GenericToolCard } from '../GenericToolCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // 返回 defaultValue（如果有）或 key 本身——测试用裸 key 做断言更稳
      return String(opts?.defaultValue ?? key)
    },
  }),
}))

const TOOL_NAME = 'run_terminal_command'
const TOOL_ID = 'tc_test_1'

describe('GenericToolCard · 错误优先级链（W14 L-24-UI）', () => {
  it('phase=error + jsonError envelope + 上层翻译过的 error prop → 优先显示翻译文案，envelope.error 不再出现', () => {
    // 模拟 toolHandler 调用 i18n 翻译 command_blocked_by_policy 后传 error
    const translatedI18nText = '已阻止 — 该命令含高危操作'
    const envelope = {
      success: false,
      error: '命中安全硬底线：rm -rf 高风险操作',
      error_kind: 'command_blocked_by_policy',
      error_label: 'hardline_block',
      blocked_by: 'security_policy',
    }

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="error"
        input={{ command: 'rm -rf /' }}
        output={JSON.stringify(envelope)}
        error={translatedI18nText}
      />,
    )

    expect(screen.getByText(translatedI18nText)).toBeTruthy()
    expect(screen.queryByText(envelope.error)).toBeNull()
    expect(screen.queryByText('hardline_block')).toBeNull()
    expect(screen.queryByText('security_policy')).toBeNull()
  })

  it('phase=error + envelope，但 i18n 没翻译（error prop 缺）→ 兜底 envelope.error', () => {
    const envelope = {
      success: false,
      error: '系统拒绝访问 /etc/passwd（macOS TCC）',
      error_kind: 'os_access_error',
      path: '/etc/passwd',
    }

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="read_file"
        phase="error"
        input={{ path: '/etc/passwd' }}
        output={JSON.stringify(envelope)}
        error={undefined}
      />,
    )

    expect(screen.getByText(envelope.error)).toBeTruthy()
    expect(screen.queryByText('/etc/passwd')).toBeNull()
  })

  it('phase=error + error prop 是 raw jsonError 字符串 → 仍显示 envelope.error 而不是整段 JSON', () => {
    const envelope = {
      success: false,
      error: '资源不存在 — 请重新选择文件',
      error_kind: 'resource_not_found',
      upstream_status: 404,
    }
    const raw = JSON.stringify(envelope)

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="parse_document"
        phase="error"
        input={{ file_id: 'missing' }}
        output={raw}
        error={raw}
      />,
    )

    expect(screen.getByText(envelope.error)).toBeTruthy()
    expect(screen.queryByText(raw)).toBeNull()
  })

  it('phase=error + envelope 的 metadata 字段（error_kind / error_label 等）默认折叠，不在首屏', () => {
    const envelope = {
      success: false,
      error: '网络请求失败：ECONNRESET',
      error_kind: 'network_failed',
      error_label: 'http_5xx',
      http_status: 503,
      technical_note: 'upstream service overloaded',
    }

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="web_search"
        phase="error"
        input={{ url: 'https://example.com' }}
        output={JSON.stringify(envelope)}
        error={'网络请求失败 — 检查网络或重试'}
      />,
    )

    // 翻译过的友好文案展示
    expect(screen.getByText('网络请求失败 — 检查网络或重试')).toBeTruthy()
    // 折叠区按钮存在（label 用 i18n key 兜底，因为 mock 返回 defaultValue）
    expect(screen.getByRole('button', { name: /错误详情/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /查看原始 JSON/ })).toBeTruthy()
    // 未展开时，metadata 字段值不在 DOM 里（折叠的 button 文本本身不含值）
    expect(screen.queryByText('http_5xx')).toBeNull()
    expect(screen.queryByText('upstream service overloaded')).toBeNull()
  })

  it('phase=error + 非 jsonError shape（旧 runtime 纯字符串） → 走兼容路径直接显示 error prop', () => {
    const fallbackText = 'OS_ACCESS_ERROR: code=EPERM path=/var/log'

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="read_file"
        phase="error"
        input={{ path: '/var/log' }}
        output={fallbackText}
        error={fallbackText}
      />,
    )

    // 兼容路径下 ErrorBanner 渲染（fallbackText 同时出现在 Result + ErrorBanner，
    // 因为 output 也是这个字符串；只要至少出现一次即证明 ErrorBanner 已展示）
    expect(screen.getAllByText(fallbackText).length).toBeGreaterThan(0)
    // 没有 envelope 折叠区
    expect(screen.queryByRole('button', { name: /错误详情/ })).toBeNull()
  })

  it('phase=end + 成功 envelope → 不渲染 ErrorBanner，正常走 result', () => {
    const envelope = { success: true, content: 'hello world', path: '/tmp/x' }

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="read_file"
        phase="end"
        input={{ path: '/tmp/x' }}
        output={JSON.stringify(envelope)}
      />,
    )

    expect(screen.queryByText('error')).toBeNull()
    expect(screen.queryByRole('button', { name: /错误详情/ })).toBeNull()
  })

  it('phase=error + envelope 没有 metadata（除 success/error）→ 不渲染折叠区', () => {
    const envelope = { success: false, error: '内部错误 — 重试或联系支持' }

    render(
      <GenericToolCard
        id={TOOL_ID}
        toolName="web_search"
        phase="error"
        input={{ url: 'https://example.com' }}
        output={JSON.stringify(envelope)}
        error={'内部错误 — 重试或联系支持'}
      />,
    )

    expect(screen.getByText('内部错误 — 重试或联系支持')).toBeTruthy()
    // 没有 metadata，「错误详情」分区不应出现；raw JSON 展开按钮仍然有
    // （raw JSON 排查一直保留，metadata 区是按内容动态决定）
    expect(screen.queryByRole('button', { name: /错误详情/ })).toBeNull()
    expect(screen.getByRole('button', { name: /查看原始 JSON/ })).toBeTruthy()
  })
})
