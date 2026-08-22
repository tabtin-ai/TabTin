"""Observability 基础设施 — Trace 记录、格式化与上下文变量。

被 tools/domains/、common/ws/、llm/、skills/、observability/ 等广泛引用。
请直接 import 子模块（trace / trace_recorder / trace_formatters），本包不做 re-export。

注意：M5 删除 middleware/ re-export stub 时，需同步更新 celery.py 的
_BEAT_DISCOVERY_MODULE_SUFFIXES 以包含新路径。
"""
