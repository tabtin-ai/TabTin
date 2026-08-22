---
scene_key: mail_ai_summarize
display_name: 邮件摘要
description: 邮件一句话摘要
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 200
  latency_class: interactive
  cost_class: cheap

default_params:
  temperature: 0.3
  max_tokens: 200
  response_format:
    type: text
  timeout_sec: 30
  max_input_chars: 16000

template_variables:
  - name: subject
    type: str
    required: true
    description: 邮件标题
  - name: content
    type: str
    required: true
    description: 邮件正文
---
