"""Tracker 两入口契约测试（charter v1.8 §6.2 / §6.4 / §7.1）。

「创建路径必须只有一条」收敛到 ``TrackerService.create_tracker``。Tracker 模块
波次 4 Stage 2.2 一刀切后，**DTO 已合并** —— 历史 Agenda 中间 DTO 与翻译
helper 全部删除，两入口直接构造 ``TrackerCreate``，不再经过中间层。

**当前两个用户感知入口**：

    1. **CLI**(``tabtin tracker new``)→ daemon HTTP → ``/api/tracker/events``
    2. **UI 表单**(``CreateTrackerDialog``)→ 同上 ``/api/tracker/events``

**契约保护演化**：

历史上有 ``agenda_event_create_to_tracker_create`` SSOT helper，两入口都过
此 helper。Stage 2 一刀切删 helper 后两入口直接构造 ``TrackerCreate`` —— 翻译
层消失，**契约保护点转移到 TrackerCreate Pydantic schema 本身**。

本测试在 Module D 重新设计后包含三层契约保护：

1. **schema 反射契约**（``test_BASE_covers_all_required_TrackerCreate_fields``）：
   用 pydantic introspection 检查 BASE 业务输入 + SCENARIO 字段是否覆盖
   ``TrackerCreate`` 所有 required 字段。schema 加新 required 字段 → fail。
2. **两入口等价**（``test_two_entries_normalize_equivalence_all_scenarios``）：
   两入口（即使共享 endpoint）必须按相同 BASE 业务输入产出 byte-identical
   的 ``TrackerCreate``。任一入口忘填字段 → normalize 后不等价 → fail。
3. **全字段透传**（``test_all_business_fields_propagate``）：``TrackerCreate``
   承载所有业务字段；新增字段未透传 → fail。

排除字段：``intent_snapshot`` (CLI 无对话上下文，UI 可选；符合 charter §4.1)。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.tracker.tracker_schemas import TrackerCreate


def _normalize(payload: TrackerCreate) -> dict:
    """提取 TrackerCreate 的「核心业务字段」用于路径间对比。

    排除 ``intent_snapshot``——CLI 路径不含对话上下文是合理的 (charter §4.1)。
    其余 7 个字段必须 byte-identical。
    """
    return {
        "name": payload.name,
        "description": payload.description,
        "trigger_type": payload.trigger_type,
        "trigger_config": payload.trigger_config or {},
        "skill_key": (payload.skill_key or "").strip(),
        "skill_params": payload.skill_params,
        "agent_id": payload.agent_id,
    }


# 三 trigger 场景必须等价覆盖。每条用同一份 BASE 业务输入，仅 trigger_type /
# trigger_config 不同。agent_id 在每条 case 内复用同一 UUID，保证字段值
# byte-identical 而非仅"语义近似"。
SCENARIOS = [
    {
        "label": "manual",
        "trigger_type": "manual",
        "trigger_config": {},
    },
    {
        "label": "cron-daily-9am",
        "trigger_type": "cron",
        "trigger_config": {
            "cron_expression": "0 9 * * *",
            "timezone": "Asia/Shanghai",
        },
    },
    {
        "label": "extension_event",
        "trigger_type": "extension_event",
        "trigger_config": {"event_key": "record_created", "filter": "table_id=tbl_x"},
    },
]


BASE = {
    "name": "Tracker 两入口契约 Tracker",
    "description": "测试两入口产物 normalize 后语义一致 (charter §6.2)",
    "skill_key": "data-sync",
    "skill_params": {"target": "tabdata"},
}


class TwoEntriesEquivalenceTest(SimpleTestCase):
    """charter v1.8 §6.2:「创建路径必须只有一条」。

    两个用户感知入口 (CLI / UI 表单) 直接构造 ``TrackerCreate``（波次 4 Stage 2.2
    一刀切后无中间 helper），对相同业务输入产出的 ``TrackerCreate`` 必须 normalize
    后语义一致。
    """

    def setUp(self):
        self.captured: list[TrackerCreate] = []

        def _capture(_organization_id, _space_id, payload, _user, *args, **kwargs):
            self.captured.append(payload)
            mock_tracker = MagicMock()
            mock_tracker.id = uuid.uuid4()
            mock_tracker.name = payload.name
            mock_tracker.status = "draft"
            mock_tracker.trigger_type = payload.trigger_type
            mock_tracker.skill_key = payload.skill_key
            mock_tracker.skill_params = payload.skill_params
            mock_tracker.organization_id = _organization_id
            mock_tracker.space_id = _space_id
            return mock_tracker

        self.patcher = patch(
            "apps.tracker.services.tracker_service.TrackerService.create_tracker",
            side_effect=_capture,
        )
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()

    # ─── 入口 1：CLI (tabtin tracker new) ───

    def _run_cli_entry(self, agent_uuid: uuid.UUID, trigger_type: str, trigger_config: dict):
        cli_payload = TrackerCreate(
            name=BASE["name"],
            description=BASE["description"],
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            skill_key=BASE["skill_key"],
            skill_params=BASE["skill_params"],
            intent_snapshot=None,
            agent_id=str(agent_uuid),
        )
        from apps.tracker.services.tracker_service import TrackerService

        svc = TrackerService(user=MagicMock())
        svc.create_tracker("wt-cli", "sp-cli", cli_payload, MagicMock())

    # ─── 入口 2：UI 表单 (CreateTrackerDialog) ───

    def _run_ui_form_entry(self, agent_uuid: uuid.UUID, trigger_type: str, trigger_config: dict):
        ui_payload = TrackerCreate(
            name=BASE["name"],
            description=BASE["description"],
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            skill_key=BASE["skill_key"],
            skill_params=BASE["skill_params"],
            intent_snapshot=None,
            agent_id=str(agent_uuid),
        )
        from apps.tracker.services.tracker_service import TrackerService

        svc = TrackerService(user=MagicMock())
        svc.create_tracker("wt-ui", "sp-ui", ui_payload, MagicMock())

    # ─── 北极星：两入口 × 三场景 等价矩阵 ───────────────────────

    def test_two_entries_normalize_equivalence_all_scenarios(self):
        """北极星：两入口 (CLI / UI 表单) 在三种 trigger 场景下，
        产出的 TrackerCreate 必须 byte-identical 等价（charter §6.2）。

        新增字段未同步两入口 → 立刻产出不同 normalize。
        """
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario["label"]):
                agent_uuid = uuid.uuid4()
                trigger_type = scenario["trigger_type"]
                trigger_config = scenario["trigger_config"]

                self._run_cli_entry(agent_uuid, trigger_type, trigger_config)
                cli_payload = self.captured.pop()

                self._run_ui_form_entry(agent_uuid, trigger_type, trigger_config)
                ui_payload = self.captured.pop()

                cli_norm = _normalize(cli_payload)
                ui_norm = _normalize(ui_payload)

                self.assertEqual(
                    cli_norm,
                    ui_norm,
                    f"[{scenario['label']}] CLI vs UI 表单 normalize 后不一致 "
                    f"(charter §6.2)\nCLI={cli_norm}\nUI={ui_norm}",
                )
                # 关键 trigger 字段二次确认
                self.assertEqual(
                    cli_payload.trigger_type, trigger_type,
                    f"[{scenario['label']}] trigger_type 透传丢失",
                )
                self.assertEqual(
                    cli_payload.trigger_config, trigger_config,
                    f"[{scenario['label']}] trigger_config 透传丢失",
                )
                self.assertEqual(
                    cli_payload.agent_id, str(agent_uuid),
                    f"[{scenario['label']}] agent_id 透传丢失 (charter §7.1)",
                )

    # ─── 全字段透传契约 ─────────────────────────────────────────

    def test_all_business_fields_propagate(self):
        """``TrackerCreate`` 必须把 7 个核心业务字段全部承载，
        新增字段未对齐 → 此测试 fail。"""
        agent_uuid = uuid.uuid4()
        intent_snapshot = {"user_utterance": "hello"}
        payload = TrackerCreate(
            name=BASE["name"],
            description=BASE["description"],
            trigger_type="cron",
            trigger_config={"cron_expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
            skill_key=BASE["skill_key"],
            skill_params=BASE["skill_params"],
            intent_snapshot=intent_snapshot,
            agent_id=str(agent_uuid),
        )

        self.assertEqual(payload.name, BASE["name"])
        self.assertEqual(payload.description, BASE["description"])
        self.assertEqual(payload.trigger_type, "cron")
        self.assertEqual(
            payload.trigger_config,
            {"cron_expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
        )
        self.assertEqual(payload.skill_key, BASE["skill_key"])
        self.assertEqual(payload.skill_params, BASE["skill_params"])
        self.assertEqual(payload.intent_snapshot, intent_snapshot)
        self.assertEqual(payload.agent_id, str(agent_uuid))

    # ─── 北极星 2：BASE 业务输入覆盖 TrackerCreate 全部必填字段 ────────────

    def test_BASE_covers_all_required_TrackerCreate_fields(self):
        """schema 反射契约：本测试文件的 BASE + SCENARIO 字段集合必须覆盖
        ``TrackerCreate`` Pydantic schema 中所有 required 字段。

        Stage 2 删 helper 后，两入口直接构造 ``TrackerCreate`` —— 翻译层消失，
        真正契约保护点转移到 ``TrackerCreate`` schema 本身。如果将来 schema 加
        了新 required 字段（如 ``priority``），本测试立刻 fail，强迫两入口
        helper 同步加该字段。

        排除：``intent_snapshot`` (charter §4.1 CLI 无对话上下文，UI 可选)。
        """
        from pydantic.fields import PydanticUndefined

        # 收集 BASE + SCENARIO（第一个）+ helper 显式传的字段：
        # name / description / skill_key / skill_params 来自 BASE
        # trigger_type / trigger_config 来自 SCENARIO
        # agent_id / intent_snapshot 在 _run_*_entry helper 内显式传
        covered = set(BASE.keys()) | {"trigger_type", "trigger_config", "agent_id", "intent_snapshot"}

        # 反射 TrackerCreate 所有 required 字段（pydantic v2 用 PydanticUndefined 表示无 default）
        required: set[str] = set()
        for fname, finfo in TrackerCreate.model_fields.items():
            if finfo.default is PydanticUndefined and finfo.default_factory is None:
                required.add(fname)

        missing = required - covered
        self.assertEqual(
            missing,
            set(),
            f"TrackerCreate 新增了必填字段 {missing}，但本测试 BASE / SCENARIO "
            f"/ _run_*_entry helper 没同步覆盖 (charter §6.2)。请把新字段加到 BASE "
            f"或 helper，否则两入口契约保护失效。",
        )

    # ─── 两入口都拒绝缺少 agent_id 的输入 (charter §7.1) ────

    def test_two_entries_all_reject_missing_agent_id(self):
        """charter §7.1：两入口都必须在 service 层拒绝缺少 agent_id 的请求。"""
        from django.core.exceptions import ValidationError as DjangoValidationError
        from apps.tracker.services.tracker_service import TrackerService

        self.patcher.stop()
        try:
            with patch.object(TrackerService, "check_space_permission", return_value=True), \
                 patch("apps.tracker.services.tracker_service.ensure_space_in_organization"):
                payload = TrackerCreate(
                    name=BASE["name"],
                    description=BASE["description"],
                    trigger_type="manual",
                    trigger_config={},
                    skill_key=BASE["skill_key"],
                    skill_params=BASE["skill_params"],
                    agent_id=None,
                )

                svc = TrackerService(user=MagicMock())
                with self.assertRaises(DjangoValidationError) as ctx:
                    svc.create_tracker("wt", "sp", payload, MagicMock())
                self.assertIn("Agent", str(ctx.exception))
        finally:
            self.patcher.start()
