---
scene_key: memo_generation
display_name: TabMemo 自动标签
description: 用户写完 TabMemo 后台异步打 1-5 个中文标签
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 4000
  max_output_tokens: 300
  latency_class: batch
  cost_class: cheap

default_params:
  temperature: 0.3
  max_tokens: 200
  response_format:
    type: json_object
  timeout_sec: 100
  min_content_length: 30
  max_input_chars: 2000

template_variables:
  - name: content
    type: str
    required: true
    description: TabMemo 内容
---

## 触发场景

用户写完 TabMemo 后 Celery `auto_tag_memo` 任务异步触发。

## 结构特别

本 scene 没有 system.md，指令和内容一并放在 user role。
