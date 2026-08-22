---
scene_key: summarization
display_name: Django 对话摘要
description: 用户主动 compact 或上下文超限时压缩历史消息为 ≤800 token 摘要
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 32000
  max_output_tokens: 1000
  latency_class: interactive
  cost_class: standard

default_params:
  temperature: 0.2
  max_tokens: 800
  response_format:
    type: text
  timeout_sec: 60
  keep_last_messages: 20

template_variables:
  - name: existing_summary
    type: str
    required: false
    description: 已有的摘要内容
  - name: messages
    type: "list[dict]"
    required: true
    description: 需要压缩的消息列表
---
