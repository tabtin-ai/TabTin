---
scene_key: diary_distill
display_name: 每日 Agent 日记蒸馏
description: 从同一 Agent 当日会话小结生成一条用户可读的工作日记（JSON）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 16000
  max_output_tokens: 1200
  latency_class: batch
  cost_class: cheap

default_params:
  temperature: 0.2
  max_tokens: 1024
  response_format:
    type: json_object
  timeout_sec: 120
  max_input_chars: 30000

template_variables:
  - name: date
    type: str
    required: true
    description: 日记日期，YYYY-MM-DD
  - name: summaries_text
    type: str
    required: true
    description: 当天同一 Agent 的会话小结列表
  - name: record_preference
    type: str
    required: false
    description: 用户记录风格偏好说明
---

## 触发场景

Celery 定时任务，每日按 Agent 聚合当日会话小结后异步触发。
