---
scene_key: memory_flush
display_name: 记忆 flush
description: 从对话内容中提取长期记忆/偏好/约束
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 16000
  max_output_tokens: 1000
  latency_class: interactive
  cost_class: standard

default_params:
  temperature: 0.2
  max_tokens: 800
  response_format:
    type: text
  timeout_sec: 60

template_variables:
  - name: existing_notes
    type: str
    required: false
    description: 已有记忆内容
  - name: messages
    type: "list[dict]"
    required: true
    description: 对话消息列表
---

## 触发场景

上层 caller 在压缩前预提取。
