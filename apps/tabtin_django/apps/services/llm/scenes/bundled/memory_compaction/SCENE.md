---
scene_key: memory_compaction
display_name: 记忆合并
description: 把多个相似记忆碎片合并成更高阶的记忆（JSON）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 16000
  max_output_tokens: 1500
  latency_class: batch
  cost_class: cheap

default_params:
  temperature: 0.2
  max_tokens: 1024
  response_format:
    type: json_object
  timeout_sec: 120
  min_group_size: 2
  max_groups_per_run: 5

template_variables:
  - name: memories
    type: str
    required: true
    description: 需要合并的记忆列表文本
---

## 触发场景

Celery beat 6 小时一次。
