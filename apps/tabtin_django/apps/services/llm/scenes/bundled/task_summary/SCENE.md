---
scene_key: task_summary
display_name: 任务摘要
description: 从对话生成任务级摘要（title + diary + outcome + emotion + pitfalls，JSON）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 32000
  max_output_tokens: 2500
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.2
  max_tokens: 2048
  response_format:
    type: json_object
  timeout_sec: 120
  max_input_chars: 30000

template_variables:
  - name: conversation_text
    type: str
    required: true
    description: 对话文本
  - name: record_preference
    type: str
    required: false
    description: 用户记录风格偏好说明（平台据 MemoRecordStyle 渲染，可空；空=现状默认）
---

## 触发场景

Celery 任务，对话结束后异步触发。
