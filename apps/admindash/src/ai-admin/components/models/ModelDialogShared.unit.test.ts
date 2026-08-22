import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildEmptyForm,
  ChatVisionPanel,
  loadFromModel,
  serializeCapabilitiesConfig,
} from './ModelDialogShared'

describe('模型能力结构化保存', () => {
  it('新建视觉模型默认以 Base64 传输并写入运行时适配配置', () => {
    const form = buildEmptyForm('chat')
    form.chat_vision.image_enabled = true

    const result = serializeCapabilitiesConfig(form)

    expect(result.errors).toEqual([])
    expect(result.capabilities_config).toMatchObject({
      image: {
        enabled: true,
        input_via: ['base64'],
        formats: ['jpeg', 'png', 'webp'],
      },
      wire_adapter: {
        image: {
          enabled: true,
          input_via: ['base64'],
          formats: ['jpeg', 'png', 'webp'],
          upload_mode: 'inline_base64',
        },
      },
    })
  })

  it('编辑模型时回显已保存的图片传输方式和文件格式', () => {
    const form = loadFromModel({
      id: 'model-1',
      provider_id: 'provider-1',
      model_name: 'kimi-k3',
      display_name: 'Kimi K3',
      capability_domain: 'chat',
      context_window_tokens: 256000,
      billing_type: 'token',
      input_price_per_1k: '0',
      output_price_per_1k: '0',
      price_per_request: '0',
      price_per_second: '0',
      capabilities_config: {
        wire_adapter: {
          image: {
            enabled: true,
            input_via: ['base64', 'file_id'],
            formats: ['jpg', 'png', 'gif'],
          },
        },
      },
      custom_billing_config: {},
    } as never)

    expect(form.chat_vision.image_enabled).toBe(true)
    expect(form.chat_vision.image_input_via_csv).toBe('base64,file_id')
    expect(form.chat_vision.image_formats_csv).toBe('jpeg,png,gif')
  })

  it('开启图片理解时拒绝空的图片传输方式和文件格式', () => {
    const form = buildEmptyForm('chat')
    form.chat_vision.image_enabled = true
    form.chat_vision.image_input_via_csv = ''
    form.chat_vision.image_formats_csv = ''

    const result = serializeCapabilitiesConfig(form)

    expect(result.errors).toEqual(['图片理解至少选择一种传输方式', '图片理解至少选择一种文件格式'])
  })

  it('只覆盖页面负责字段并保留厂商适配配置', () => {
    const form = buildEmptyForm('chat')
    form.chat_vision = {
      ...form.chat_vision,
      stream_supported: false,
      tool_enabled: true,
      image_enabled: false,
      supports_document_input: true,
      supports_zip_input: true,
      json_mode_modes_csv: 'json_schema',
      json_mode_strict: true,
      caching_mode: 'none',
      max_documents_per_request: '3',
      request_payload_max_mb: '20',
    }
    form.raw_capabilities_config = JSON.stringify({
      vendor_extension: { region: 'cn-beijing' },
      wire_adapter: {
        image: { enabled: true, upload_mode: 'inline_base64', input_via: ['base64'] },
        wire: { request_protocol: 'legacy', vendor_header: 'x-test' },
        limits: { max_tool_recursion_depth: 8 },
      },
    })
    form.raw_custom_billing_config = JSON.stringify({ vendor_price_rule: 'keep-me' })

    const result = serializeCapabilitiesConfig(form)

    expect(result.errors).toEqual([])
    expect(result.capabilities_config).toMatchObject({
      vendor_extension: { region: 'cn-beijing' },
      supports_streaming: false,
      supports_function_calling: true,
      supports_vision: false,
      supports_document_input: true,
      supports_zip_input: true,
      wire_adapter: {
        image: {
          enabled: false,
          upload_mode: 'inline_base64',
          input_via: ['base64'],
        },
        wire: {
          request_protocol: 'openai_chat_completions',
          stream_supported: false,
          vendor_header: 'x-test',
        },
        limits: {
          max_documents_per_request: 3,
          request_payload_max_mb: 20,
          max_tool_recursion_depth: 8,
        },
      },
    })
    expect(result.custom_billing_config).toEqual({ vendor_price_rule: 'keep-me' })
  })

  it('保留厂商自定义的图片上传与请求结构策略', () => {
    const form = buildEmptyForm('chat')
    form.chat_vision.image_enabled = true
    form.chat_vision.image_input_via_csv = 'base64,file_id'
    form.chat_vision.image_formats_csv = 'jpeg,png'
    form.raw_capabilities_config = JSON.stringify({
      wire_adapter: {
        image: {
          enabled: true,
          input_via: ['file_id'],
          formats: ['png'],
          upload_mode: 'files_api',
          request_shape: 'anthropic_image_source',
          files_api: { purpose: 'vision' },
          native_url_prefixes: ['ms://'],
        },
      },
    })

    const result = serializeCapabilitiesConfig(form)

    expect(result.errors).toEqual([])
    expect(result.capabilities_config.wire_adapter).toMatchObject({
      image: {
        enabled: true,
        input_via: ['base64', 'file_id'],
        formats: ['jpeg', 'png'],
        upload_mode: 'files_api',
        request_shape: 'anthropic_image_source',
        files_api: { purpose: 'vision' },
        native_url_prefixes: ['ms://'],
      },
    })
  })

  it('关闭原生文档输入时显式保存 false，并保留其它厂商配置', () => {
    const form = buildEmptyForm('chat')
    form.chat_vision.supports_document_input = false
    form.chat_vision.supports_zip_input = false
    form.raw_capabilities_config = JSON.stringify({
      supports_document_input: true,
      supports_zip_input: true,
      vendor_extension: { upload_mode: 'files_api' },
    })

    const result = serializeCapabilitiesConfig(form)

    expect(result.capabilities_config).toMatchObject({
      supports_document_input: false,
      supports_zip_input: false,
      vendor_extension: { upload_mode: 'files_api' },
    })
  })

  it('清空页面限制时只删除对应字段', () => {
    const form = buildEmptyForm('chat')
    form.raw_capabilities_config = JSON.stringify({
      limits: {
        max_documents_per_request: 5,
        request_payload_max_mb: 20,
        max_tool_recursion_depth: 6,
      },
    })

    const result = serializeCapabilitiesConfig(form)

    expect(result.capabilities_config.limits).toEqual({ max_tool_recursion_depth: 6 })
  })
})

describe('图片能力配置展示', () => {
  const renderPanel = (imageEnabled: boolean) => {
    const form = buildEmptyForm('chat')
    form.chat_vision.image_enabled = imageEnabled
    return renderToStaticMarkup(
      createElement(ChatVisionPanel, { cfg: form.chat_vision, update: () => undefined })
    )
  }

  it('未开启图片理解时隐藏传输方式和图片格式', () => {
    const html = renderPanel(false)

    expect(html).not.toContain('图片传输方式')
    expect(html).not.toContain('支持的图片格式')
  })

  it('开启图片理解时展示传输方式和图片格式', () => {
    const html = renderPanel(true)

    expect(html).toContain('图片传输方式')
    expect(html).toContain('支持的图片格式')
  })
})
