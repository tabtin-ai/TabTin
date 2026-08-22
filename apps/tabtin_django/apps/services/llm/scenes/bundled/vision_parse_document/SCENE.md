---
scene_key: vision_parse_document
display_name: VLM 文档解析
description: 解析 PDF / PPTX / Word 等文档页面图片为结构化 JSON
capability_domain: vision

capability_requirements:
  requires_json_mode: true
  min_context_tokens: 16000
  max_output_tokens: 8192
  max_image_edge_px: 1600
  max_images_per_request: 1
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.1
  max_tokens: 8192
  response_format:
    type: json_object
  image_detail: high
  timeout_sec: 120

template_variables: []

attachments:
  - path: output_schema.json
    purpose: output_contract
---

## 触发场景

docparse 同步管线（PDF 扫描件、PPTX 等走 VLM 兜底解析）。

## 结构特别

user-only（无 system.md）。VLM 把 prompt 跟 image 在同 user message 注入。
