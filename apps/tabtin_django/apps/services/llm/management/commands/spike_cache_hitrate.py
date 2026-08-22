"""Spike: 测量 LLM provider prompt cache 命中率。

通过 proxy_service 内部函数直接调用 LLM，串行发送共享长前缀的请求，
从 response usage 中提取 cache 命中数据。
"""

import time
import json
from datetime import datetime
from pathlib import Path

from django.core.management.base import BaseCommand


REPORT_PATH = Path(
    "/Users/developer/dev/TabTin/TabTinAgent"
    "/packages/agent-runtime/docs/prd/06-subagent-coordination"
    "/spike-cache-hitrate-report.md"
)

SYSTEM_PREFIX = (
    "You are an expert assistant. "
    "Below is reference material you must consider when answering.\n\n"
    + ("The quick brown fox jumps over the lazy dog. " * 400)
    + "\n\nEnd of reference material."
)

NUM_REQUESTS = 5
INTERVAL_SECONDS = 5
MAX_TOKENS = 30


def _run_single_request(ctx, body, index, stdout=None):
    """发送一个请求，返回 (usage_dict, elapsed_ms, error_str|None)。"""
    from apps.services.llm.services.proxy_service import (
        stream_upstream, _parse_usage_from_sse,
    )

    body_copy = dict(body)
    body_copy["messages"] = [
        {"role": "user", "content": f"Answer question {index}: What is {index}+{index}?"},
    ]

    t0 = time.monotonic()
    usage = None
    raw_usage_lines = []
    try:
        gen = stream_upstream(ctx, body_copy)
        try:
            while True:
                chunk = next(gen)
                if chunk.startswith("data: "):
                    payload = chunk[6:].strip()
                    if payload and payload != "[DONE]":
                        try:
                            obj = json.loads(payload)
                            if "usage" in obj:
                                raw_usage_lines.append(json.dumps(obj["usage"]))
                        except (json.JSONDecodeError, TypeError):
                            pass
        except StopIteration as si:
            usage = si.value
        elapsed = int((time.monotonic() - t0) * 1000)
        if stdout and raw_usage_lines:
            stdout.write(f"    raw_usage: {raw_usage_lines[-1]}\n")
        return usage, elapsed, None
    except Exception as exc:
        elapsed = int((time.monotonic() - t0) * 1000)
        return None, elapsed, str(exc)


def _run_experiment(model_name, organization_id, stdout):
    """对一个模型跑完整实验，返回 results list。"""
    from apps.services.llm.services.proxy_service import (
        resolve_proxy_model,
        build_upstream_config,
        ProxyContext,
    )

    stdout.write(f"\n{'='*60}")
    stdout.write(f"\n模型: {model_name}")
    stdout.write(f"\n{'='*60}\n")

    model_instance = resolve_proxy_model(model_name, organization_id=organization_id)
    if not model_instance:
        stdout.write(f"  ✗ 模型 {model_name} 解析失败\n")
        return None, "模型解析失败"

    stdout.write(f"  模型实例: {model_instance}\n")

    try:
        upstream = build_upstream_config(model_instance)
    except Exception as exc:
        stdout.write(f"  ✗ 上游配置失败: {exc}\n")
        return None, f"上游配置失败: {exc}"

    # build_upstream_config strips provider prefix (custom_openai/),
    # but ZenMux expects the original model_name with provider prefix (anthropic/...).
    actual_upstream_name = upstream["model_name"]
    if "/" not in actual_upstream_name and "/" in model_name:
        actual_upstream_name = model_name

    stdout.write(f"  上游模型: {actual_upstream_name}\n")
    stdout.write(f"  API Base: {upstream['api_base']}\n")

    ctx = ProxyContext(
        model_name=actual_upstream_name,
        api_key=upstream["api_key"],
        api_base=upstream["api_base"],
        key_obj=upstream.get("key_obj"),
        model_instance=model_instance,
        source="spike_cache_hitrate",
        stream=True,
    )

    body = {
        "system": SYSTEM_PREFIX,
        "messages": [],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }

    results = []
    for i in range(1, NUM_REQUESTS + 1):
        stdout.write(f"\n  请求 {i}/{NUM_REQUESTS} ...")
        usage, elapsed, error = _run_single_request(ctx, body, i, stdout=stdout)

        if error:
            stdout.write(f" ✗ 错误: {error} ({elapsed}ms)\n")
            results.append({"index": i, "error": error, "elapsed_ms": elapsed})
        else:
            stdout.write(f" ✓ {elapsed}ms")
            if usage:
                stdout.write(f" | usage={json.dumps(usage)}")
            else:
                stdout.write(" | usage=None")
            stdout.write("\n")
            results.append({"index": i, "usage": usage, "elapsed_ms": elapsed})

        if i < NUM_REQUESTS:
            time.sleep(INTERVAL_SECONDS)

    return results, None


def _generate_report(experiments):
    """生成 markdown 报告。"""
    lines = [
        "# Spike: Prompt Cache Hit Rate Measurement",
        "",
        f"**日期**: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**实验参数**: system prompt ≈ {len(SYSTEM_PREFIX)} chars, "
        f"{NUM_REQUESTS} 请求/模型, 间隔 {INTERVAL_SECONDS}s, max_tokens={MAX_TOKENS}",
        "",
    ]

    for model_name, results, error in experiments:
        lines.append(f"## {model_name}")
        lines.append("")

        if error:
            lines.append(f"**跳过**: {error}")
            lines.append("")
            continue

        if not results:
            lines.append("**无数据**")
            lines.append("")
            continue

        lines.append("| # | prompt_tokens | cache_read | cache_creation | hit_rate | elapsed_ms | error |")
        lines.append("|---|---|---|---|---|---|---|")

        total_prompt = 0
        total_cache_read = 0
        total_cache_creation = 0
        valid_count = 0

        for r in results:
            idx = r["index"]
            elapsed = r["elapsed_ms"]
            err = r.get("error", "")
            usage = r.get("usage")

            if err:
                lines.append(f"| {idx} | - | - | - | - | {elapsed} | {err} |")
                continue

            if not usage:
                lines.append(f"| {idx} | - | - | - | - | {elapsed} | no usage |")
                continue

            pt = usage.get("input_tokens", 0)
            cr = usage.get("cache_read_input_tokens", 0)
            cc = usage.get("cache_creation_input_tokens", 0)
            hr = f"{cr/pt*100:.1f}%" if pt > 0 else "N/A"

            lines.append(f"| {idx} | {pt} | {cr} | {cc} | {hr} | {elapsed} | |")

            total_prompt += pt
            total_cache_read += cr
            total_cache_creation += cc
            valid_count += 1

        lines.append("")

        if valid_count > 0 and total_prompt > 0:
            overall_hr = total_cache_read / total_prompt * 100
            lines.append(f"**汇总**: {valid_count} 个有效请求, "
                         f"总 prompt_tokens={total_prompt}, "
                         f"总 cache_read={total_cache_read}, "
                         f"总 cache_creation={total_cache_creation}")
            lines.append(f"")
            lines.append(f"**总命中率**: {overall_hr:.1f}%")

            skip_first = [r for r in results if r["index"] > 1 and r.get("usage")]
            if skip_first:
                sp = sum(r["usage"].get("input_tokens", 0) for r in skip_first)
                scr = sum(r["usage"].get("cache_read_input_tokens", 0) for r in skip_first)
                if sp > 0:
                    lines.append(f"**排除首次请求后命中率**: {scr/sp*100:.1f}%")
        elif valid_count > 0:
            lines.append("**注意**: 所有请求的 prompt_tokens 均为 0，无法计算命中率")
        else:
            lines.append("**注意**: 没有有效请求数据")

        lines.append("")

    lines.append("## 结论与 PRD 决策建议")
    lines.append("")
    lines.append("PRD §10.2 决策规则：")
    lines.append("- Claude 命中率 ≥ 70% → v2 档 B 立项")
    lines.append("- Claude 命中率 40-70% → v2 降级目标")
    lines.append("- Claude < 40% → 不做档 B")
    lines.append("")

    for model_name, results, error in experiments:
        if error or not results:
            lines.append(f"- **{model_name}**: 无法测试 ({error or '无数据'})")
            continue

        valid = [r for r in results if r.get("usage") and r["usage"].get("input_tokens", 0) > 0]
        if not valid:
            lines.append(f"- **{model_name}**: provider 未返回 cache 相关字段")
            continue

        total_pt = sum(r["usage"]["input_tokens"] for r in valid)
        total_cr = sum(r["usage"].get("cache_read_input_tokens", 0) for r in valid)
        hr = total_cr / total_pt * 100 if total_pt > 0 else 0

        if "claude" in model_name.lower() or "anthropic" in model_name.lower():
            if hr >= 70:
                decision = "✅ v2 档 B 立项"
            elif hr >= 40:
                decision = "⚠️ v2 降级目标"
            else:
                decision = "❌ 不做档 B"
            lines.append(f"- **{model_name}**: 命中率 {hr:.1f}% → {decision}")
        else:
            lines.append(f"- **{model_name}**: 命中率 {hr:.1f}% (参考)")

    lines.append("")
    return "\n".join(lines)


class Command(BaseCommand):
    help = "Spike: 测量 LLM prompt cache 命中率（PRD-06 §10.2 决策依据）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--models",
            nargs="+",
            default=["anthropic/claude-sonnet-4.6"],
            help="要测试的模型列表",
        )
        parser.add_argument(
            "--organization-id",
            type=str,
            default="",
            help="Organization ID（留空则自动查第一个）",
        )

    def handle(self, *args, **options):
        models = options["models"]
        organization_id = options["organization_id"]

        if not organization_id:
            try:
                from apps.membership.models import Organization
                wt = Organization.objects.first()
                if wt:
                    organization_id = str(wt.id)
                    self.stdout.write(f"自动选择 organization: {organization_id}")
                else:
                    self.stdout.write(self.style.WARNING("数据库中没有 organization"))
            except Exception as exc:
                self.stdout.write(self.style.WARNING(f"查询 organization 失败: {exc}"))

        self.stdout.write(f"\nSystem prompt 长度: {len(SYSTEM_PREFIX)} chars")
        self.stdout.write(f"请求数/模型: {NUM_REQUESTS}")
        self.stdout.write(f"请求间隔: {INTERVAL_SECONDS}s")
        self.stdout.write(f"max_tokens: {MAX_TOKENS}")

        experiments = []
        for model_name in models:
            results, error = _run_experiment(model_name, organization_id, self.stdout)
            experiments.append((model_name, results, error))

        report = _generate_report(experiments)

        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(report, encoding="utf-8")
        self.stdout.write(f"\n\n报告已写入: {REPORT_PATH}")
