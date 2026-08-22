"""Wave 9 i18n 治理 — tracker app 错误响应 i18n key 存在性测试。

背景(charter v1.8 §4.4 + Wave 7 mini 二次验证 P1):
  scheduler / agenda / goal API 中错误响应曾大量使用裸中文/英文字符串,
  绕过 i18n。Wave 9 渐进式治理把所有 permission_denied_response /
  not_found_response / validation_error_response 改走 i18n key。

Stage 3 用户可见层收尾（2026-05-25）补做：
  - Tracker 域子 key 名 `agenda_*` / `goal_*` → `tracker_*`，与产品命名对齐
  - 删除 D1 砍掉 event 路径后留下的 9 个死 key（无 caller）

2026-05-28 收编：ScheduledJob.table_automation 子系统整体下线，相关
``scheduler.automation_*`` / ``scheduler.agent_space_not_found`` /
``scheduler.automation_rule_resource`` 死 key 一并清理。事件目录两个端点
迁入 ``apps/services/common/api/registry_events.py``（``/api/registry/events``），
仍复用 ``scheduler.business_event_resource`` i18n key（namespace 不随 URL 改）。

本文件守护:
  1. 所有用到的 i18n key 在 zh-CN.json / en-US.json **同时存在**(防漏键)
  2. zh-CN / en-US 的翻译都不退化为返回 key 本身
  3. 强制 helper(raise_forbidden_i18n / raise_not_found_i18n / ...)真返回
     翻译后的人话,不返回裸 key

跑法::

    cd apps/tabtin_django && source venv/bin/activate
    python -m pytest apps/tracker/tests/test_i18n_keys.py -v
"""
from __future__ import annotations

import pytest

# Wave 9 治理范围内,tracker app 真实使用的 i18n key 清单
# (grep `_("scheduler\.` 全文,凡走 i18n 的字段都在此列出)
SCHEDULER_I18N_KEYS = [
    # 业务事件目录 — services/common/api/registry_events.py（/api/registry/events）
    "scheduler.business_event_resource",
    # TS-2（dry-run 路由收敛）后随 tracker_dry_run 搬到 tracker/api/trackers.py
    "scheduler.tracker_resource",
    "scheduler.tracker_dry_run_no_permission",
    "scheduler.tracker_dry_run_no_organization_access",
    "scheduler.tracker_dry_run_no_tenant",
    # Stage 3 改名 — tracker/api/trackers.py（原 agenda_api.py）
    "scheduler.tracker_no_organization_viewer",
    "scheduler.tracker_no_space_viewer",
    "scheduler.tracker_no_space_editor",
    "scheduler.tracker_not_found",
    "scheduler.tracker_run_not_found",
    # Stage 3 删除的死 key（D1 下线 event 路径后无 caller）：
    #   agenda_invalid_start_after / agenda_invalid_end_before
    #   agenda_event_requires_start_at / agenda_end_before_start
    #   agenda_event_already_active / agenda_only_agent_task_triggerable
    #   agenda_event_no_restore_needed / agenda_user_not_found / agenda_agent_not_found
    # Wave 4 Stage 2 一刀切：attendees 已下线，相关 key 同步移除
    # （agenda_attendee_not_found / agenda_attendee_user_or_agent_required /
    # agenda_attendee_duplicate）。
    # Stage 3 改名 — tracker/api/sidechannel.py（原 goal_api.py 内容已迁入）
    "scheduler.tracker_template_not_found",
    "scheduler.webhook_no_matching_tracker",
    "scheduler.run_record_resource",
]


@pytest.mark.parametrize("key", SCHEDULER_I18N_KEYS)
def test_scheduler_i18n_key_resolves_in_zh_cn(key: str) -> None:
    """每个 key 在 zh-CN 下必须有真翻译,不能返回 key 字符串本身。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.ZH_CN)

    # 失败模式 1:翻译缺失,manager 兜底返回 key 本身
    assert text != key, (
        f"i18n key {key!r} 在 zh-CN 翻译缺失(返回了 key 本身)。"
        f"请在 apps/i18n/locales/zh-CN.json 'scheduler' 节点下补齐。"
    )
    # 失败模式 2:翻译存在但是空字符串
    assert text, f"i18n key {key!r} 在 zh-CN 翻译为空"


@pytest.mark.parametrize("key", SCHEDULER_I18N_KEYS)
def test_scheduler_i18n_key_resolves_in_en_us(key: str) -> None:
    """每个 key 在 en-US 下必须有真翻译。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.EN_US)

    assert text != key, (
        f"i18n key {key!r} 在 en-US 翻译缺失(返回了 key 本身)。"
        f"请在 apps/i18n/locales/en-US.json 'scheduler' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 en-US 翻译为空"


def test_scheduler_i18n_zh_en_keys_are_consistent() -> None:
    """zh-CN 与 en-US 的 scheduler.* 键集合必须一致(无单边遗漏)。

    Stage 3 fix（2026-05-25）：原实现取 `.get("tracker")` 拿到空 dict，导致 zh/en
    都是空集合，"一致" 永远成立——dead assertion。改为正确取 `.get("scheduler")`。
    """
    from apps.i18n.manager import i18n_manager
    from apps.i18n.language import SupportedLanguage

    zh_scheduler = (
        i18n_manager.translations.get(SupportedLanguage.ZH_CN, {}).get("scheduler", {})
    )
    en_scheduler = (
        i18n_manager.translations.get(SupportedLanguage.EN_US, {}).get("scheduler", {})
    )

    zh_keys = set(zh_scheduler.keys())
    en_keys = set(en_scheduler.keys())

    missing_in_en = zh_keys - en_keys
    missing_in_zh = en_keys - zh_keys

    assert not missing_in_en, (
        f"zh-CN scheduler.* 有 key 但 en-US 缺失: {sorted(missing_in_en)}"
    )
    assert not missing_in_zh, (
        f"en-US scheduler.* 有 key 但 zh-CN 缺失: {sorted(missing_in_zh)}"
    )


def test_scheduler_i18n_parameterized_key_substitutes() -> None:
    """带模板参数的 key 应当能正确替换变量。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    # business_event_resource 模板含 {event_key}
    # Stage 3 改名：示例 event key 用 tracker.run.completed（与后端 TrackerEvent.RUN_COMPLETED 一致）
    text_zh = get_text(
        "scheduler.business_event_resource",
        language=SupportedLanguage.ZH_CN,
        event_key="tracker.run.completed",
    )
    assert "tracker.run.completed" in text_zh, (
        f"模板参数未被替换。实际消息: {text_zh!r}"
    )

    text_en = get_text(
        "scheduler.business_event_resource",
        language=SupportedLanguage.EN_US,
        event_key="tracker.run.completed",
    )
    assert "tracker.run.completed" in text_en

    # tracker_resource 模板含 {tracker_id}
    text_zh = get_text(
        "scheduler.tracker_resource",
        language=SupportedLanguage.ZH_CN,
        tracker_id="abc-123",
    )
    assert "abc-123" in text_zh


def test_raise_forbidden_i18n_helper_translates_key() -> None:
    """新加的 raise_forbidden_i18n helper 必须把 key 翻译成人话再 raise。"""
    from ninja.errors import HttpError
    from apps.services.common.api_errors import raise_forbidden_i18n

    with pytest.raises(HttpError) as excinfo:
        raise_forbidden_i18n("scheduler.tracker_dry_run_no_permission")

    err: HttpError = excinfo.value
    assert err.status_code == 403
    # 不应该把 i18n key 字符串原样吐到 HTTP message
    assert err.message != "scheduler.tracker_dry_run_no_permission", (
        f"raise_forbidden_i18n 没翻译 key,吐出了原始 key 字符串: {err.message!r}"
    )
    # 翻译结果不应为空
    assert err.message


def test_raise_not_found_i18n_helper_translates_key() -> None:
    from ninja.errors import HttpError
    from apps.services.common.api_errors import raise_not_found_i18n

    with pytest.raises(HttpError) as excinfo:
        raise_not_found_i18n(
            "scheduler.business_event_resource",
            event_key="x.y.z",
        )

    err: HttpError = excinfo.value
    assert err.status_code == 404
    # 模板参数应被替换
    assert "x.y.z" in err.message


def test_raise_bad_request_i18n_helper_translates_key() -> None:
    from ninja.errors import HttpError
    from apps.services.common.api_errors import raise_bad_request_i18n

    # Stage 3 改名：原用 `scheduler.agenda_event_requires_start_at`（已删 - D1 死 key），
    # 改用真实存活的 key 验证 helper 翻译行为。
    with pytest.raises(HttpError) as excinfo:
        raise_bad_request_i18n("scheduler.tracker_not_found")

    err: HttpError = excinfo.value
    assert err.status_code == 400
    assert err.message != "scheduler.tracker_not_found"


def test_scheduler_api_no_chinese_hardcoded_in_responses() -> None:
    """死字段防线 — scheduler app 错误响应里不应再有中文硬编码字面量。

    只 grep 模块文件,不 grep test 文件(test 文件可以 assert 中文)。
    """
    import re
    from pathlib import Path

    scheduler_root = Path(__file__).resolve().parents[1]
    # 波次 4 Stage 2 一刀切后：agenda_api / goal_api / api.py 三文件已合并/移至
    # api/ 子包。2026-05-28 收编：scheduler_api.py 随 ScheduledJob 子系统整文件
    # 删除。Suspect 文件指向 api/trackers.py（主 CRUD + dry-run）+ api/sidechannel.py。
    suspect_files = [
        scheduler_root / "api" / "trackers.py",
        scheduler_root / "api" / "sidechannel.py",
    ]

    # 匹配 *_response("...中文...") 或 *_response(f"...中文...")
    chinese_in_response_re = re.compile(
        r"(?:permission_denied_response|not_found_response|validation_error_response)"
        r"\(\s*f?\"[^\"]*[一-鿿][^\"]*\"\s*\)"
    )

    offenders: list[tuple[str, int, str]] = []
    for path in suspect_files:
        if not path.exists():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if chinese_in_response_re.search(line):
                offenders.append((str(path), lineno, line.strip()))

    assert not offenders, (
        "Wave 9 i18n 治理后 scheduler app 不应再有 *_response(中文字面量) 硬编码:\n"
        + "\n".join(f"  {p}:{ln}  {snippet}" for p, ln, snippet in offenders)
    )
