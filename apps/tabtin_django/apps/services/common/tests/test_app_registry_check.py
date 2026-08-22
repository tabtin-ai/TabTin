"""app_registry_check：manifest 与注册表一致性（builtin + marketplace）。

Wave D（2026-04-17）扩展覆盖：
- 第 1 项 ``has_prompt_section`` 双源校验（pkgutil + ``packages/apps/<id>/prompts/`` 兜底）
- 第 5 项 ``context_fields`` 扩展遍历到 marketplace
- 第 7 项 ``tool_domains`` 扩展遍历到 marketplace
对应 PRD §4.1 N-3 的三个负面用例 + 兼容性回归。
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from apps.services.common import app_registry as ar
from apps.services.common.app_registry import (
    AppContextField,
    AppDefinition,
)
from apps.services.common.app_registry_check import (
    _marketplace_prompt_section_exists,
    _validate_manifest_consistency,
    _validate_marketplace_channel_gateway_pairings,
    validate_app_registry,
    validate_channel_registry,
)


def _write_manifest(apps_root: Path, folder: str, data: dict) -> None:
    d = apps_root / folder
    d.mkdir(parents=True)
    (d / "app.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def minimal_agent() -> dict:
    return {
        "contextFields": [],
        "toolDomains": [],
        "hasPromptSection": False,
        "displayField": "",
        "workspaceRootSource": "",
        "isFrontendDependent": False,
        "typeAliases": [],
    }


def test_marketplace_manifest_resolves_no_core_apps_mismatch(
    tmp_path: Path, minimal_agent: dict
) -> None:
    """marketplace manifest 合法存在于 MARKETPLACE_APPS 时不应报 CORE_APPS 缺失或数量不等。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_manifest(
        apps_dir,
        "zz_builtin_test_app",
        {
            "id": "zz_builtin_test_app",
            "distribution": "builtin",
            "name": "B",
            "agentIntegration": minimal_agent,
        },
    )
    _write_manifest(
        apps_dir,
        "zz_market_test_app",
        {
            "id": "zz_market_test_app",
            "distribution": "marketplace",
            "name": "M",
            "agentIntegration": minimal_agent,
        },
    )
    builtin_def = AppDefinition(id="zz_builtin_test_app", name="B")
    market_def = AppDefinition(
        id="zz_market_test_app", name="M", distribution="marketplace"
    )
    with (
        patch.object(ar, "CORE_APPS", {"zz_builtin_test_app": builtin_def}),
        patch.object(ar, "MARKETPLACE_APPS", {"zz_market_test_app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warns = _validate_manifest_consistency()

    assert not any("在 CORE_APPS 中无对应条目" in w for w in warns), warns
    assert not any("manifest 数量" in w and "≠" in w for w in warns), warns
    assert not any("注册表中无对应条目" in w for w in warns), warns


def test_manifest_without_registry_entry_warns(
    tmp_path: Path, minimal_agent: dict
) -> None:
    apps_dir = tmp_path / "packages" / "apps"
    _write_manifest(
        apps_dir,
        "orphan_app",
        {
            "id": "orphan_app",
            "agentIntegration": minimal_agent,
        },
    )
    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warns = _validate_manifest_consistency()
    assert any("注册表中无对应条目" in w for w in warns)


def test_builtin_in_registry_missing_manifest_warns(tmp_path: Path) -> None:
    (tmp_path / "packages" / "apps").mkdir(parents=True)
    ghost = AppDefinition(id="ghost_builtin", name="G")
    with (
        patch.object(ar, "CORE_APPS", {"ghost_builtin": ghost}),
        patch.object(ar, "MARKETPLACE_APPS", {}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warns = _validate_manifest_consistency()
    assert any("无 manifest 文件" in w for w in warns)


# ─── Wave D 扩展用例（PRD §4.1 N-3）─────────────────────────────


def _seed_minimal_manifests(tmp_path: Path, market_def: AppDefinition) -> None:
    """在 ``tmp_path`` 写入对应 marketplace AppDefinition 的最小 manifest，
    避免 _validate_manifest_consistency 的反向告警干扰 N-3 用例的命中检测。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_manifest(
        apps_dir,
        market_def.id,
        {
            "id": market_def.id,
            "distribution": "marketplace",
            "name": market_def.name,
            "agentIntegration": {
                "contextType": market_def.context_type,
                "contextFields": [
                    {"name": f.name, "label": f.label, "isResourceId": f.is_resource_id}
                    for f in market_def.context_fields
                ],
                "toolDomains": list(market_def.tool_domains),
                "hasPromptSection": market_def.has_prompt_section,
                "displayField": market_def.display_field,
                "workspaceRootSource": market_def.workspace_root_source,
                "isFrontendDependent": market_def.is_frontend_dependent,
                "typeAliases": list(market_def.type_aliases),
            },
        },
    )


def test_n3_case1_marketplace_prompt_module_missing_warns(tmp_path: Path) -> None:
    """N-3 第 1 项：marketplace App 声明 hasPromptSection=true 但 prompts 模块未发现 → WARNING。

    场景：marketplace App 把 ``hasPromptSection`` 设为 true，但既不在主仓
    ``prompts/apps/<app_id>.py``（pkgutil 扫描点）也不在
    ``packages/apps/<app_id>/prompts/<lang>/system.md``（marketplace 双源兜底点）
    出现 → 校验产 WARN，但 Django 仍可启动。
    """
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        has_prompt_section=True,
    )
    _seed_minimal_manifests(tmp_path, market_def)

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch(
            "apps.services.common.app_registry.APP_SECTIONS",
            {},
            create=True,
        ),
    ):
        warns = validate_app_registry()

    matched = [w for w in warns if "hasPromptSection=true" in w and "未发现" in w]
    assert matched, f"期望命中 hasPromptSection 双源未发现 WARN，实际: {warns}"
    assert any("demo-app" in w for w in matched)


def test_n3_case1_marketplace_prompt_in_main_repo_passes(tmp_path: Path) -> None:
    """兼容性回归：marketplace App 声明 hasPromptSection=true 且主仓 pkgutil 已加载（B1 完成前的现状），
    不应触发"未发现"WARN。"""
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        has_prompt_section=True,
    )
    _seed_minimal_manifests(tmp_path, market_def)

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch(
            "apps.services.common.app_registry.APP_SECTIONS",
            {"demo-app": "..."},
            create=True,
        ),
    ):
        warns = validate_app_registry()

    assert not any(
        "hasPromptSection=true" in w and "未发现" in w for w in warns
    ), f"主仓 prompt 已存在时不应报未发现：{warns}"


def test_n3_case1_marketplace_prompt_in_marketplace_dir_passes(tmp_path: Path) -> None:
    """兼容性回归：marketplace App 声明 hasPromptSection=true 且 packages/apps/<id>/prompts/<lang>/system.md
    存在（B1 完成后的位置），不应触发"未发现"WARN（双源兜底命中）。"""
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        has_prompt_section=True,
    )
    _seed_minimal_manifests(tmp_path, market_def)
    # 模拟 B1 完成后的 marketplace 目录布局
    marketplace_prompt = tmp_path / "packages" / "apps" / "demo-app" / "prompts" / "zh"
    marketplace_prompt.mkdir(parents=True, exist_ok=True)
    (marketplace_prompt / "system.md").write_text("# demo-app prompt", encoding="utf-8")

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch(
            "apps.services.common.app_registry.APP_SECTIONS",
            {},
            create=True,
        ),
    ):
        warns = validate_app_registry()

    assert not any(
        "hasPromptSection=true" in w and "未发现" in w for w in warns
    ), f"marketplace 目录有 prompt 时不应报未发现：{warns}"


def test_n3_case2_marketplace_context_field_not_in_agent_state_warns(
    tmp_path: Path,
) -> None:
    """N-3 第 5 项：marketplace App 在 contextFields 中加了 AgentState 未声明的字段 → WARNING。"""
    phantom_field = AppContextField(
        name="phantomField", label="phantom", is_resource_id=False
    )
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        context_fields=(phantom_field,),
    )
    _seed_minimal_manifests(tmp_path, market_def)

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warns = validate_app_registry()

    matched = [
        w
        for w in warns
        if "context_fields 'phantomField'" in w and "AgentState TypedDict" in w
    ]
    assert matched, f"期望命中 context_fields 不在 AgentState 的 WARN，实际: {warns}"
    assert any("demo-app" in w for w in matched)


def test_n3_case3_marketplace_undefined_tool_domain_warns(tmp_path: Path) -> None:
    """N-3 第 7 项：marketplace App 在 toolDomains 中声明了 runtime 未识别的域 → WARNING。"""
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        tool_domains=("fake_domain",),
    )
    _seed_minimal_manifests(tmp_path, market_def)

    class _StubHub:
        @staticmethod
        def list_domains() -> list[str]:
            return ["common", "rag"]

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch("apps.services.tools.ToolHub", _StubHub, create=True),
    ):
        warns = validate_app_registry()

    matched = [
        w
        for w in warns
        if "demo-app.tool_domains contains undefined domain 'fake_domain'" in w
    ]
    assert matched, f"期望命中 tool_domains 未定义 WARN，实际: {warns}"


def test_tool_domains_use_runtime_sources_after_toolhub_retirement(
    tmp_path: Path,
) -> None:
    """ToolHub 退役后，平台域 / 虚拟域 / Python domain 目录 / CLI-first 策略域仍应被识别。"""
    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        tool_domains=("sql", "terminal", "tabdoc", "tabdata"),
    )
    _seed_minimal_manifests(tmp_path, market_def)

    class _EmptyHub:
        @staticmethod
        def list_domains() -> list[str]:
            return []

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch("apps.services.tools.ToolHub", _EmptyHub, create=True),
    ):
        warns = validate_app_registry()

    assert not any(
        "demo-app.tool_domains contains undefined domain" in w for w in warns
    ), f"有效 runtime 工具域不应报 WARN：{warns}"


def test_n3_case3_marketplace_empty_tool_domains_skipped(tmp_path: Path) -> None:
    """兼容性回归：marketplace App 的 tool_domains 为空（CLI-first App 的常见形态）时不应触发 WARN。"""
    market_def = AppDefinition(
        id="demo-app", name="Demo App", distribution="marketplace", tool_domains=()
    )
    _seed_minimal_manifests(tmp_path, market_def)

    class _StubHub:
        @staticmethod
        def list_domains() -> list[str]:
            return ["common"]

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch("apps.services.tools.ToolHub", _StubHub, create=True),
    ):
        warns = validate_app_registry()

    assert not any(
        "demo-app.tool_domains contains undefined domain" in w for w in warns
    ), f"空 tool_domains 不应报 WARN：{warns}"


def test_marketplace_prompt_section_exists_helper(tmp_path: Path) -> None:
    """``_marketplace_prompt_section_exists`` 仅识别 ``prompts/<lang>/system.md`` 结构，
    避免误判其他 markdown（如 README）。"""
    apps_dir = tmp_path / "packages" / "apps" / "demo" / "prompts" / "zh"
    apps_dir.mkdir(parents=True)
    with patch.object(ar, "_PROJECT_ROOT", tmp_path):
        # 还没写 system.md，应返回 False
        assert _marketplace_prompt_section_exists("demo") is False
        # 仅写 README，不算
        (apps_dir / "README.md").write_text("readme")
        assert _marketplace_prompt_section_exists("demo") is False
        # 写 system.md，命中
        (apps_dir / "system.md").write_text("# system")
        assert _marketplace_prompt_section_exists("demo") is True
        # 不存在的 app_id 返回 False
        assert _marketplace_prompt_section_exists("nonexistent") is False


def test_validate_app_registry_keeps_builtin_compat(tmp_path: Path) -> None:
    """兼容性回归：现有 builtin App 校验仍按原逻辑工作（不引入误伤）。"""
    builtin_def = AppDefinition(
        id="zz_builtin", name="B", has_prompt_section=False, tool_domains=()
    )
    apps_dir = tmp_path / "packages" / "apps"
    _write_manifest(
        apps_dir,
        "zz_builtin",
        {
            "id": "zz_builtin",
            "distribution": "builtin",
            "name": "B",
            "agentIntegration": {
                "contextFields": [],
                "toolDomains": [],
                "hasPromptSection": False,
                "displayField": "",
                "workspaceRootSource": "",
                "isFrontendDependent": False,
                "typeAliases": [],
            },
        },
    )

    with (
        patch.object(ar, "CORE_APPS", {"zz_builtin": builtin_def}),
        patch.object(ar, "MARKETPLACE_APPS", {}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch(
            "apps.services.common.app_registry.APP_SECTIONS",
            {},
            create=True,
        ),
    ):
        warns = validate_app_registry()

    assert not any(
        "zz_builtin" in w for w in warns
    ), f"无声明的 builtin App 不应触发任何 WARN：{warns}"


def test_n3_warnings_actually_logged(tmp_path: Path) -> None:
    """N-3 验收要求：三个负面用例对应的 WARNING 必须被 logger 实际打印
    （PRD §4.1 N-3 与 §6.5 提到的"启动 log 必出现 WARNING [AppRegistryCheck] ..."）。

    project Django logger 配置可能用 console handler 而非 propagate，所以这里
    直接附加一个 list handler 抓取 logger 自身的输出，避免依赖 caplog 的 propagate。
    """
    import logging

    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        has_prompt_section=True,
        context_fields=(
            AppContextField(name="phantomField", label="phantom", is_resource_id=False),
        ),
        tool_domains=("fake_domain",),
    )
    _seed_minimal_manifests(tmp_path, market_def)

    class _StubHub:
        @staticmethod
        def list_domains() -> list[str]:
            return ["common"]

    captured_records: list[logging.LogRecord] = []

    class _ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured_records.append(record)

    arc_logger = logging.getLogger("apps.services.common.app_registry_check")
    handler = _ListHandler(level=logging.WARNING)
    arc_logger.addHandler(handler)
    original_level = arc_logger.level
    arc_logger.setLevel(logging.WARNING)

    try:
        with (
            patch.object(ar, "CORE_APPS", {}),
            patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
            patch.object(ar, "_PROJECT_ROOT", tmp_path),
            patch(
                "apps.services.common.app_registry.APP_SECTIONS",
                {},
                create=True,
            ),
            patch("apps.services.tools.ToolHub", _StubHub, create=True),
        ):
            validate_app_registry()
    finally:
        arc_logger.removeHandler(handler)
        arc_logger.setLevel(original_level)

    messages = [r.getMessage() for r in captured_records]
    log_text = "\n".join(messages)

    # 第 1 项
    assert "hasPromptSection=true" in log_text and "未发现" in log_text, log_text
    # 第 5 项
    assert (
        "context_fields 'phantomField'" in log_text
        and "AgentState TypedDict" in log_text
    ), log_text
    # 第 7 项
    assert (
        "demo-app.tool_domains contains undefined domain 'fake_domain'" in log_text
    ), log_text
    # 全部用 [AppRegistryCheck] 前缀
    assert all("[AppRegistryCheck]" in m for m in messages), messages
    # WARNING 级别（不是 ERROR/CRITICAL，按 N3 决议）
    assert all(r.levelno == logging.WARNING for r in captured_records), [
        r.levelname for r in captured_records
    ]


def test_sentry_capture_aggregates_warnings(tmp_path: Path) -> None:
    """N3 决议：marketplace 校验失败应**单次**聚合上报 Sentry（仅 WARNING 级别，不 panic）。

    三视角 Review 反馈：每条 WARN 独立 capture_message 易在启动期刷屏（一次启动数十条），
    应改为 ``push_scope`` + ``set_extra("warnings", [...])`` + 单次 ``capture_message``。
    """
    import sys
    from contextlib import contextmanager

    market_def = AppDefinition(
        id="demo-app",
        name="Demo App",
        distribution="marketplace",
        has_prompt_section=True,
        context_fields=(
            AppContextField(name="phantomField", label="phantom", is_resource_id=False),
        ),
    )
    _seed_minimal_manifests(tmp_path, market_def)

    captured_messages: list[tuple[str, str]] = []  # (level, message)
    captured_tags: dict[str, str] = {}
    captured_extras: dict[str, object] = {}

    class _FakeScope:
        def set_tag(self, k: str, v: str) -> None:
            captured_tags[k] = v

        def set_extra(self, k: str, v: object) -> None:
            captured_extras[k] = v

    @contextmanager
    def fake_push_scope():
        yield _FakeScope()

    def fake_capture_message(message: str, level: str = "info") -> None:
        captured_messages.append((level, message))

    fake_sentry = type(
        "FakeSentry",
        (),
        {
            "push_scope": staticmethod(fake_push_scope),
            "capture_message": staticmethod(fake_capture_message),
        },
    )

    with (
        patch.object(ar, "CORE_APPS", {}),
        patch.object(ar, "MARKETPLACE_APPS", {"demo-app": market_def}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch(
            "apps.services.common.app_registry.APP_SECTIONS",
            {},
            create=True,
        ),
        patch.dict(sys.modules, {"sentry_sdk": fake_sentry}),
    ):
        warns = validate_app_registry()

    assert len(warns) >= 2, "前置：本用例需至少 2 条 WARN 才能验证聚合形态"
    # 单次 capture_message
    assert (
        len(captured_messages) == 1
    ), f"Sentry 应聚合上报为单次 capture_message，实际: {captured_messages}"
    level, message = captured_messages[0]
    assert level == "warning", level
    assert message.startswith("[AppRegistryCheck]"), message
    assert f"{len(warns)} warning(s)" in message, message
    # tag 用于分类过滤
    assert captured_tags.get("registry_check_category") == "AppRegistryCheck"
    # extras 携带完整列表
    assert captured_extras.get("warning_count") == len(warns)
    assert captured_extras.get("warnings") == warns


# ─── Wave D' 扩展用例：channelGateway 配对校验（PRD §4.1 N-3 ④ + §5.2 第 2 项）──


def _write_channel_gateway_manifest(
    apps_root: Path, app_id: str, channel_gateway: dict | None
) -> None:
    """快捷函数：写一个仅有 ``id`` / ``distribution`` / 可选 ``channelGateway``
    的 marketplace manifest，专供 channelGateway 配对校验测试使用，
    不掺杂其他校验项干扰。"""
    folder = apps_root / app_id
    folder.mkdir(parents=True, exist_ok=True)
    payload: dict[str, object] = {
        "id": app_id,
        "distribution": "marketplace",
        "name": app_id,
    }
    if channel_gateway is not None:
        payload["channelGateway"] = channel_gateway
    (folder / "app.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


class _StubChannelRegistry:
    """ChannelAdapterRegistry 的极简替身——实现 ``list_ids`` / ``list_all``
    供 D' 配对校验和 D 主体元数据校验同时使用，避免在测试中拖入真正的
    Django app 注册流程。

    ``list_all`` 默认返回空列表，让上游元数据校验走"为空"分支并多一条
    ``ChannelAdapterRegistry 为空`` WARN（与本期配对校验断言互不干扰，
    断言均按 ``[validate_channel_registry]`` 子标记或 app_id 精确过滤）。
    """

    def __init__(self, ids: list[str], adapters: list[object] | None = None) -> None:
        self._ids = list(ids)
        self._adapters = list(adapters or [])

    def list_ids(self) -> list[str]:
        return list(self._ids)

    def list_all(self) -> list[object]:
        return list(self._adapters)


def _patch_channel_registry(ids: list[str]):
    """便捷：把 ChannelAdapterRegistry 替换为 stub 后返回 patch context manager。"""
    return patch(
        "apps.channel_gateway.adapters.registry.ChannelAdapterRegistry",
        _StubChannelRegistry(ids),
    )


def test_n3_case4_marketplace_channel_gateway_unregistered_warns(
    tmp_path: Path,
) -> None:
    """N-3 第 ④ 项（PRD §4.1）：marketplace App 在 manifest 写
    ``channelGateway.enabled=true type=fake_channel`` 但 ChannelAdapterRegistry
    没有注册对应 adapter → WARNING（不阻断启动）。

    这是 D' 启动包消化 D-L2 的核心验收点。
    """
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "fake_market_app", {"enabled": True, "type": "fake_channel"}
    )
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu", "slack"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()

    matched = [
        w
        for w in warns
        if "[validate_channel_registry]" in w
        and "fake_market_app" in w
        and "type=fake_channel" in w
        and "未注册" in w
    ]
    assert matched, f"期望命中 channelGateway 未注册 WARN，实际: {warns}"


def test_n3_case4_pairing_warning_actually_logged(tmp_path: Path) -> None:
    """N-3 ④ 验收要求：未注册的 WARN 必须经 logger 实际打印，
    保留 D 已定型的 ``[ChannelRegistryCheck]`` 前缀，且消息体内含
    ``[validate_channel_registry]`` 子标记，让 PRD 文案 grep 命中。"""
    import logging

    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "fake_market_app", {"enabled": True, "type": "fake_channel"}
    )

    captured: list[logging.LogRecord] = []

    class _ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    arc_logger = logging.getLogger("apps.services.common.app_registry_check")
    handler = _ListHandler(level=logging.WARNING)
    arc_logger.addHandler(handler)
    original_level = arc_logger.level
    arc_logger.setLevel(logging.WARNING)

    try:
        with (
            patch.object(ar, "_PROJECT_ROOT", tmp_path),
            _patch_channel_registry(["feishu"]),
        ):
            validate_channel_registry()
    finally:
        arc_logger.removeHandler(handler)
        arc_logger.setLevel(original_level)

    pairing_logs = [
        r
        for r in captured
        if "[validate_channel_registry]" in r.getMessage()
        and "fake_market_app" in r.getMessage()
    ]
    assert (
        pairing_logs
    ), f"未捕获到 channelGateway 配对 WARN，实际：{[r.getMessage() for r in captured]}"
    rec = pairing_logs[0]
    assert rec.levelno == logging.WARNING, rec.levelname
    full_msg = rec.getMessage()
    assert "[ChannelRegistryCheck]" in full_msg, full_msg
    assert "type=fake_channel" in full_msg, full_msg


def test_channel_gateway_field_absent_does_not_warn(tmp_path: Path) -> None:
    """兼容性回归：marketplace App 的 manifest 没有 ``channelGateway`` 字段
    （CLI-first marketplace App 的常见形态）→ 配对校验不应产生任何 WARN，避免误伤。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(apps_dir, "no_gateway_app", channel_gateway=None)
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    assert not any("no_gateway_app" in w for w in warns), warns
    assert not any("[validate_channel_registry]" in w for w in warns), warns


def test_channel_gateway_disabled_does_not_warn(tmp_path: Path) -> None:
    """兼容性回归：``channelGateway.enabled=false`` → 即便 type 缺失或
    指向未注册 adapter，也不报警（视为该 App 显式关闭了 channel gateway 入口）。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "disabled_app", {"enabled": False, "type": "unknown_channel"}
    )
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    assert not warns, warns


def test_channel_gateway_registered_type_passes(tmp_path: Path) -> None:
    """正向用例：``channelGateway.enabled=true type=feishu`` 且 registry 已注册
    feishu adapter → 不报警。覆盖 marketplace App 启用 channelGateway 的兼容场景。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "feishu_gateway_app", {"enabled": True, "type": "feishu"}
    )
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu", "slack"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    assert not warns, f"已注册 type 不应触发 WARN：{warns}"


def test_channel_gateway_missing_type_warns(tmp_path: Path) -> None:
    """配置不完整用例：``channelGateway.enabled=true`` 但缺 ``type`` 字段
    → WARN（避免因为漏写字段而沉默通过 → 上线后才发现配对失败）。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(apps_dir, "incomplete_app", {"enabled": True})
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    matched = [
        w
        for w in warns
        if "[validate_channel_registry]" in w
        and "incomplete_app" in w
        and "缺少有效的 type 字段" in w
    ]
    assert matched, f"期望命中缺少 type 的 WARN：{warns}"


def test_channel_gateway_empty_type_string_warns(tmp_path: Path) -> None:
    """边界用例：``type`` 是空字符串或非字符串（如 dict / null）→ 都视为缺失。"""
    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "empty_type_app", {"enabled": True, "type": ""}
    )
    _write_channel_gateway_manifest(
        apps_dir, "non_str_type_app", {"enabled": True, "type": {"nested": "feishu"}}
    )
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        _patch_channel_registry(["feishu"]),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    assert any("empty_type_app" in w and "缺少有效的 type" in w for w in warns), warns
    assert any("non_str_type_app" in w and "缺少有效的 type" in w for w in warns), warns


def test_channel_gateway_registry_unimportable_emits_skip_warn(tmp_path: Path) -> None:
    """容错用例：当 ChannelAdapterRegistry 因任何原因无法导入时，
    给出说明性 WARN（携带 ``[validate_channel_registry]`` 子标记），
    不让校验静默失败。"""
    import sys

    apps_dir = tmp_path / "packages" / "apps"
    _write_channel_gateway_manifest(
        apps_dir, "any_app", {"enabled": True, "type": "feishu"}
    )
    with (
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
        patch.dict(sys.modules, {"apps.channel_gateway.adapters.registry": None}),
    ):
        warns = _validate_marketplace_channel_gateway_pairings()
    assert any(
        "[validate_channel_registry]" in w and "无法导入 ChannelAdapterRegistry" in w
        for w in warns
    ), warns
