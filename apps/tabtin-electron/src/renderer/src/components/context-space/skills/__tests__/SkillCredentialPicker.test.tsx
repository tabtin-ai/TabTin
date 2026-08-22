/**
 * Wave 5b S2 — Skill 凭据选择器单测。
 *
 * 覆盖三个核心场景（北极星）：
 *   1. 已有凭据 → 用户能从下拉里选 + 默认进入 'existing' 模式
 *   2. 手动输入 → Radio 切换后裸密码框显示
 *   3. 空状态 → 该 service 一个凭据都没 → 友好提示；隐藏设置页时不展示跳转按钮
 *
 * 不直接挂载完整 dialog，只测 picker —— 它是新增 UI 行为的核心载体。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

const mockUseQuery = vi.fn()
const mockOpenSettings = vi.fn()

vi.mock('@/hooks/queries/credentials', () => ({
  useApiKeyCredentialsQuery: (opts: any) => mockUseQuery(opts),
  credentialKeys: { all: ['credentials'] },
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({ openSettings: mockOpenSettings }),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: any) => {
      if (opts?.defaultValue) {
        let s = opts.defaultValue as string
        for (const [k, v] of Object.entries(opts)) {
          if (k === 'defaultValue') continue
          s = s.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
        }
        return s
      }
      return _key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Input: (props: any) => <input data-testid="manual-input" {...props} />,
  Label: ({ children }: any) => <label>{children}</label>,
  Select: ({ children, value, onValueChange }: any) => (
    <div data-testid="select" data-value={value || ''}>
      {/* 简化的 Select：渲染所有子项，点击 SelectItem 触发 onValueChange */}
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { onValueChange } as any)
          : child,
      )}
    </div>
  ),
  SelectContent: ({ children, onValueChange }: any) => (
    <div>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { onValueChange } as any)
          : child,
      )}
    </div>
  ),
  SelectItem: ({ children, value, onValueChange }: any) => (
    <button
      data-testid={`select-item-${value}`}
      onClick={() => onValueChange?.(value)}
    >
      {children}
    </button>
  ),
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}))

import {
  SkillCredentialPicker,
  inferServiceNameFromPrimaryEnv,
  getServiceDisplayName,
} from '../SkillCredentialPicker'

describe('inferServiceNameFromPrimaryEnv', () => {
  it('maps OPENAI_API_KEY to openai', () => {
    expect(inferServiceNameFromPrimaryEnv('OPENAI_API_KEY')).toBe('openai')
  })

  it('maps ANTHROPIC_API_KEY to anthropic', () => {
    expect(inferServiceNameFromPrimaryEnv('ANTHROPIC_API_KEY')).toBe('anthropic')
  })

  it('returns undefined for unknown primary_env (fallback to all api_key)', () => {
    expect(inferServiceNameFromPrimaryEnv('MY_CUSTOM_LLM_KEY')).toBeUndefined()
  })

  it('returns undefined when primaryEnv is empty', () => {
    expect(inferServiceNameFromPrimaryEnv('')).toBeUndefined()
    expect(inferServiceNameFromPrimaryEnv(undefined)).toBeUndefined()
  })
})

describe('getServiceDisplayName（UI 显示成 BrandCase）', () => {
  it('已知服务 → 大小写正确的展示名', () => {
    expect(getServiceDisplayName('openai')).toBe('OpenAI')
    expect(getServiceDisplayName('anthropic')).toBe('Anthropic')
    expect(getServiceDisplayName('serper')).toBe('Serper')
  })

  it('未知服务 → 透传原 service_name', () => {
    expect(getServiceDisplayName('my-llm')).toBe('my-llm')
  })

  it('undefined / empty → undefined', () => {
    expect(getServiceDisplayName(undefined)).toBeUndefined()
    expect(getServiceDisplayName('')).toBeUndefined()
  })
})

describe('SkillCredentialPicker', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockOpenSettings.mockReset()
  })

  const baseProps = {
    primaryEnv: 'OPENAI_API_KEY',
    mode: 'existing' as const,
    onModeChange: vi.fn(),
    selectedCredentialId: '',
    onSelectedCredentialIdChange: vi.fn(),
    manualKey: '',
    onManualKeyChange: vi.fn(),
    onCloseDialog: vi.fn(),
  }

  it('Scenario 1：已有凭据 → 渲染下拉里的候选项', () => {
    mockUseQuery.mockReturnValue({
      data: [
        {
          id: 'cred-openai-1',
          service_name: 'openai',
          display_name: 'OpenAI',
          masked_data: { api_key: 'sk-****3a2f' },
        },
      ],
      isLoading: false,
    })

    render(<SkillCredentialPicker {...baseProps} mode="existing" />)

    // 候选项渲染（mock 里是 button）
    expect(screen.getByTestId('select-item-cred-openai-1')).toBeTruthy()
    expect(screen.getByText('OpenAI (sk-****3a2f)')).toBeTruthy()

    // 点击候选 → 触发 onSelectedCredentialIdChange
    fireEvent.click(screen.getByTestId('select-item-cred-openai-1'))
    expect(baseProps.onSelectedCredentialIdChange).toHaveBeenCalledWith('cred-openai-1')

    // 按 inferred service 过滤
    expect(mockUseQuery).toHaveBeenCalledWith({ serviceName: 'openai' })
  })

  it('Scenario 2：手动输入模式 → 显示密码输入框', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false })

    const onManualKeyChange = vi.fn()
    render(
      <SkillCredentialPicker
        {...baseProps}
        mode="manual"
        onManualKeyChange={onManualKeyChange}
      />,
    )

    const input = screen.getByTestId('manual-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.type).toBe('password')

    fireEvent.change(input, { target: { value: 'sk-test-1234' } })
    expect(onManualKeyChange).toHaveBeenCalledWith('sk-test-1234')
  })

  it('Scenario 3：空状态 → 隐藏未就绪凭据设置的跳转入口', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false })

    render(<SkillCredentialPicker {...baseProps} mode="existing" />)

    // 服务名走 SERVICE_DISPLAY_NAME 表显示成 "OpenAI" 而非 "openai"
    expect(screen.getByText('未找到 OpenAI 密钥')).toBeTruthy()

    expect(screen.queryByText('去添加')).toBeNull()
    expect(baseProps.onCloseDialog).not.toHaveBeenCalled()
    expect(mockOpenSettings).not.toHaveBeenCalled()
  })

  it('Radio 切换：existing → manual 触发 onModeChange', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false })

    const onModeChange = vi.fn()
    render(
      <SkillCredentialPicker
        {...baseProps}
        mode="existing"
        onModeChange={onModeChange}
      />,
    )

    const manualRadio = document.querySelector(
      'input[type="radio"][value="manual"]',
    ) as HTMLInputElement
    expect(manualRadio).toBeTruthy()
    fireEvent.click(manualRadio)
    expect(onModeChange).toHaveBeenCalledWith('manual')
  })

  it('未知 primary_env → 调用 query 时不传 serviceName（fallback 列出全部）', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false })

    render(
      <SkillCredentialPicker
        {...baseProps}
        primaryEnv="MY_CUSTOM_LLM_KEY"
      />,
    )

    expect(mockUseQuery).toHaveBeenCalledWith({ serviceName: undefined })
  })
})
