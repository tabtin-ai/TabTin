---
scene_key: mail_ai_extract_reply
display_name: 邮件回复/引用/签名分离
description: 把邮件正文拆成回复/引用/签名三段（JSON）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 16000
  max_output_tokens: 2500
  latency_class: interactive
  cost_class: standard

default_params:
  temperature: 0.2
  max_tokens: 2000
  response_format:
    type: json_object
  timeout_sec: 60

template_variables:
  - name: content
    type: str
    required: true
    description: 邮件正文
---
