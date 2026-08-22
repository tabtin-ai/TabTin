---
scene_key: mail_ai_extract_data
display_name: 邮件结构化提取
description: 从邮件中提取结构化数据（dates / amounts / contacts / action_items / links / key_points）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 1800
  latency_class: interactive
  cost_class: standard

default_params:
  temperature: 0.2
  max_tokens: 1500
  response_format:
    type: json_object
  timeout_sec: 60

template_variables:
  - name: subject
    type: str
    required: true
    description: 邮件标题
  - name: content
    type: str
    required: true
    description: 邮件正文
  - name: schema
    type: str
    required: false
    description: 自定义 JSON schema（可选）
---
