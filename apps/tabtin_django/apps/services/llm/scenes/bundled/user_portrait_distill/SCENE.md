---
scene_key: user_portrait_distill
display_name: 用户画像蒸馏
description: 基于用户 TabMemo + organization 上下文生成 5 段叙事用户画像（Markdown）
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 65536
  max_output_tokens: 4096
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.4
  max_tokens: 4096
  response_format:
    type: text
  timeout_sec: 300
  max_input_chars: 60000
  max_memos: 200

template_variables:
  - name: user_display_name
    type: str
    required: true
    description: 用户称呼
  - name: organization_name
    type: str
    required: true
    description: Organization 名称
  - name: previous_portrait
    type: str
    required: false
    description: 上一版小传
  - name: memos_summary
    type: str
    required: false
    description: 拼好的 TabMemo 列表
  - name: hints_text
    type: str
    required: false
    description: 用户 hint 列表
---

## 触发场景

Celery `distill_portrait_task` 按 organization 维度触发。
