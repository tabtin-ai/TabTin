---
scene_key: mail_ai_classify
display_name: 邮件分类
description: 邮件分类（category / priority / labels / confidence / reasoning），JSON 输出
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 400
  latency_class: interactive
  cost_class: cheap

default_params:
  temperature: 0.2
  max_tokens: 300
  response_format:
    type: json_object
  timeout_sec: 30
  max_input_chars: 16000

template_variables:
  - name: from
    type: str
    required: true
    description: 发件人
  - name: subject
    type: str
    required: true
    description: 邮件标题
  - name: content
    type: str
    required: true
    description: 邮件正文

attachments:
  - path: output_schema.json
    purpose: output_contract
---
