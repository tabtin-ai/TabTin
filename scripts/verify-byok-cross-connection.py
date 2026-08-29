#!/usr/bin/env python3
"""PR4 只读审计：多套 OpenAI Compatible 连接的运行时隔离。

不改业务代码。可在无 Django venv 时跑 AST + Resolver 断言。
复跑：python3 scripts/verify-byok-cross-connection.py
"""

from __future__ import annotations

import ast
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

REPO = Path(__file__).resolve().parents[1]
DJANGO_ROOT = REPO / "apps" / "tabtin_django"
LLM_DIR = DJANGO_ROOT / "apps" / "services" / "llm"


def _read(rel: str) -> str:
    return (LLM_DIR / rel).read_text(encoding="utf-8")


def _parse(rel: str) -> ast.AST:
    return ast.parse(_read(rel), filename=rel)


def _contains(tree: ast.AST, *needles: str) -> bool:
    source = ast.unparse(tree) if hasattr(ast, "unparse") else ast.dump(tree)
    return all(needle in source for needle in needles)


def _load_adapter_resolver():
    registry = ModuleType("apps.services.llm.registry")

    class ProviderRegistry:
        registered = {
            "openai",
            "claude",
            "moonshot",
            "kimi_coding",
            "volcengine",
            "qwen",
        }

        @classmethod
        def is_registered(cls, name: str) -> bool:
            return name in cls.registered

        @classmethod
        def get_service_class(cls, name: str):
            return "OpenAIService"

    registry.ProviderRegistry = ProviderRegistry

    for name in ("apps", "apps.services", "apps.services.llm"):
        sys.modules.setdefault(name, ModuleType(name))
    sys.modules["apps.services.llm.registry"] = registry

    spec = importlib.util.spec_from_file_location(
        "adapter_resolver_audit",
        LLM_DIR / "adapter_resolver.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module, ProviderRegistry


def audit_adapter_isolation() -> dict:
    resolver, _registry = _load_adapter_resolver()
    cases = {
        "openrouter": resolver.resolve_adapter_name(
            SimpleNamespace(provider_key="openai-openrouter", name="openai")
        ),
        "siliconflow": resolver.resolve_adapter_name(
            SimpleNamespace(provider_key="openai-siliconflow", name="openai")
        ),
        "official_openai": resolver.resolve_adapter_name(
            SimpleNamespace(provider_key="openai", name="openai")
        ),
        "kimi_coding": resolver.resolve_adapter_name(
            SimpleNamespace(provider_key="kimi_coding", name="moonshot")
        ),
    }
    ok = (
        cases["openrouter"] == "openai"
        and cases["siliconflow"] == "openai"
        and cases["official_openai"] == "openai"
        and cases["kimi_coding"] == "kimi_coding"
    )
    return {"ok": ok, "cases": cases}


def audit_source() -> list[dict]:
    factory = _read("services/factory.py")
    routing = _read("services/routing_pool.py")
    failover = _read("services/failover_executor.py")
    key_manager = _read("services/key_manager.py")
    billing = _read("services/billing.py")
    proxy = _read("services/proxy_service.py")
    litellm = _read("litellm_config.py")
    guard = _read("services/capability_guard.py")
    usage = _read("services/usage_tracking.py")
    chat = _read("services/chat/__init__.py")

    findings = []

    findings.append({
        "id": "proxy_uuid_then_fk",
        "ok": "def resolve_proxy_model" in proxy and "model_id=model_name" in proxy,
        "note": "Proxy 先按 model_name 试，失败后再把 UUID 当 model_id 直查",
    })
    findings.append({
        "id": "runtime_url_from_model",
        "ok": '"api_base": model.base_url' in litellm,
        "note": "build_litellm_config 读 LLMModel.base_url",
    })
    findings.append({
        "id": "runtime_key_from_provider_id",
        "ok": "select_provider_key(str(provider.id))" in proxy
        and "LLMProviderKey.objects.filter(provider_id=provider_id)" in key_manager,
        "note": "Key 按 provider_id 选，不会跨连接",
    })
    findings.append({
        "id": "failover_key_scoped_to_provider_id",
        "ok": "select_provider_key(provider_id, session_id=session_id)" in failover
        and "select_model_from_pool" not in failover,
        "note": "failover_executor 只换同一 provider_id 的 Key",
    })
    findings.append({
        "id": "byok_skips_wallet",
        "ok": 'return scope in ("user", "organization")' in billing
        and 'return {"byok_exempt": True}' in billing,
        "note": "scope=user/organization 免钱包扣费",
    })
    findings.append({
        "id": "usage_backfills_provider_key",
        "ok": "if not provider_key:" in usage
        and 'provider_key = getattr(provider_obj, "provider_key", "")' in usage,
        "note": "有 model_id 时 Usage 从 Provider 回填 provider_key",
    })
    findings.append({
        "id": "factory_degraded_pool_switch",
        "ok": True,
        "risk": True,
        "severity": "P1",
        "note": "get_llm_service(model_id) 在 degraded 时按 model_name 换渠道，未锁 provider_id",
        "evidence": "select_model_from_pool(\n                    model_name=model.model_name," in factory
        and "provider_key=" not in factory[factory.find("R5: degraded"): factory.find("R5: degraded") + 400],
    })
    findings.append({
        "id": "routing_pool_model_name_only",
        "ok": True,
        "risk": True,
        "severity": "P1",
        "note": "不传 provider_key 时同名模型跨连接进同一轮询池",
        "evidence": "LLMModel.objects.select_related(\"provider\").filter(model_name=model_name)" in routing
        and "if provider_key:" in routing,
    })
    findings.append({
        "id": "capability_guard_name_union",
        "ok": True,
        "risk": True,
        "severity": "P2",
        "note": "provider_supports_chat_capability 按 name 做 capability union",
        "evidence": "LLMProvider.objects.filter(name=provider_name)" in guard,
    })
    findings.append({
        "id": "scene_chat_fallback_to_model_name",
        "ok": True,
        "risk": True,
        "severity": "P1",
        "note": "unified_llm_call 在 get_llm_service(model_id) 失败后回退 model_name 池",
        "evidence": "get_llm_service(model_name=model.model_name)" in chat,
    })
    findings.append({
        "id": "proxy_no_degraded_switch",
        "ok": "select_model_from_pool" not in proxy and "runtime_status" not in proxy,
        "note": "Electron 主对话 Proxy 不按健康状态换连接",
    })

    return findings


def main() -> int:
    adapter = audit_adapter_isolation()
    findings = audit_source()
    failed = [item for item in findings if item.get("ok") is False]
    report = {
        "adapter": adapter,
        "findings": findings,
        "failed_invariants": [item["id"] for item in failed],
        "risks": [item["id"] for item in findings if item.get("risk")],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if adapter["ok"] and not failed else 1


if __name__ == "__main__":
    sys.exit(main())
