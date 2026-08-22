---
scene_key: memory_capture
display_name: 记忆捕获
description: 从对话中抽取记忆碎片（auto/selective 双 mode）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 32000
  max_output_tokens: 4096
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.1
  max_tokens: 4096
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

mode_variants:
  - mode: auto
    system_file: system.auto.md
  - mode: selective
    system_file: system.selective.md
---

## 触发场景

Celery 任务（capture_mode 参数控制）。
