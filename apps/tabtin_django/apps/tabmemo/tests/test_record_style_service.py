"""
RecordStyle service 测试（TM-5 service 缺口 + TM-4 / TM-12 单元覆盖）。

分两层：
  1. **无 DB 单元测试**（纯函数 / mock ORM）——保证可跑，覆盖
     - ``_sanitize_custom_config`` 键白名单 + 枚举校验 + 超大值/超大 list 防护（TM-12）
     - ``load_effective_record_style`` 三态：查无记录→默认开 / 读取异常→fail-closed / 命中→映射（TM-4）
  2. **需 DB 的 service 测试**（``@pytest.mark.django_db``）——覆盖
     - get/update upsert（同 (user, organization) 只一行）
     - extra_preference 截断（1000）
     - custom_config 白名单落库
     - 非法 style 拒绝（400）
     - 越权 403（get + update，非成员）

DB 层用 tabtinspace ``Organization`` + users_auth ``User`` 真实建对象；单库 SQLite 测试
模式下 ``postgresql`` alias 为 ``default`` 的 TEST MIRROR，服务里的 ``.using(TABMEMO_DB)``
与测试事务共用同一连接，可见性正常。
"""

from unittest.mock import MagicMock, patch
import uuid

import pytest
from django.contrib.auth import get_user_model
from pydantic import ValidationError

from apps.tabmemo.schemas import RecordStyleUpdateRequest
from apps.tabmemo.services.record_style_service import (
    DEFAULT_RECORD_STYLE,
    EXTRA_PREFERENCE_MAX_CHARS,
    FAIL_CLOSED_RECORD_STYLE,
    RecordStyleService,
    _sanitize_custom_config,
    load_effective_record_style,
)
from apps.tabtinspace.services.base import ServiceError

_SVC_MOD = "apps.tabmemo.services.record_style_service"


# ════════════════════════ 无 DB：_sanitize_custom_config（TM-12）════════════════════════


class TestSanitizeCustomConfig:

    def test_non_dict_returns_empty(self):
        assert _sanitize_custom_config(None) == {}
        assert _sanitize_custom_config("x") == {}
        assert _sanitize_custom_config(123) == {}
        assert _sanitize_custom_config(["a"]) == {}

    def test_keeps_only_whitelisted_dims(self):
        out = _sanitize_custom_config({
            "density": "moderate",
            "depth": "with_judgment",
            "tone": "warm",
            "focus": ["about_user", "method"],
            "evil": "x" * 100_000,      # 未知键 → 丢
            "__proto__": {"a": 1},      # 未知键 → 丢
            "style": "companion",       # 非维度键 → 丢
        })
        assert out == {
            "density": "moderate",
            "depth": "with_judgment",
            "tone": "warm",
            "focus": ["about_user", "method"],
        }

    def test_drops_invalid_enum_values(self):
        out = _sanitize_custom_config({
            "density": "bogus",       # 非法枚举 → 丢
            "depth": "facts_only",    # 合法
            "tone": 123,              # 非字符串 → 丢
        })
        assert out == {"depth": "facts_only"}

    def test_drops_oversized_scalar_value(self):
        # 超大字符串不在枚举内 → 直接丢，杜绝无界存储（DoS）
        assert _sanitize_custom_config({"density": "m" * 1_000_000}) == {}

    def test_focus_filters_invalid_and_dedups(self):
        out = _sanitize_custom_config({
            "focus": ["about_user", "about_user", "bogus", 42, "method"],
        })
        assert out == {"focus": ["about_user", "method"]}

    def test_focus_non_list_dropped(self):
        assert _sanitize_custom_config({"focus": "about_user"}) == {}

    def test_focus_huge_list_is_bounded(self):
        # 恶意超大 list：只扫描前 N 个 + 最多 4 个合法值，不会全量遍历
        out = _sanitize_custom_config({"focus": ["about_user"] * 5000})
        assert out == {"focus": ["about_user"]}

    def test_all_focus_values_accepted(self):
        out = _sanitize_custom_config({
            "focus": ["outcome", "method", "about_user", "emotion"],
        })
        assert out == {"focus": ["outcome", "method", "about_user", "emotion"]}


# ════════════════ 无 DB：load_effective_record_style 三态（TM-4）════════════════


class TestLoadEffectiveRecordStyle:

    def test_empty_args_returns_default_enabled(self):
        assert load_effective_record_style("", "ws")["enabled"] is True
        assert load_effective_record_style("u", "")["enabled"] is True

    @patch(f"{_SVC_MOD}.MemoRecordStyle")
    def test_no_record_returns_default_enabled(self, MockModel):
        MockModel.objects.using.return_value.filter.return_value.first.return_value = None
        cfg = load_effective_record_style("u", "ws")
        assert cfg["enabled"] is True
        assert cfg["style"] == DEFAULT_RECORD_STYLE["style"]

    @patch(f"{_SVC_MOD}.MemoRecordStyle")
    def test_db_error_fails_closed(self, MockModel):
        """TM-4：读取异常 → enabled=False（不记），绝不 fail-open。"""
        MockModel.objects.using.return_value.filter.return_value.first.side_effect = (
            RuntimeError("db down")
        )
        cfg = load_effective_record_style("u", "ws")
        assert cfg["enabled"] is False
        assert cfg == FAIL_CLOSED_RECORD_STYLE

    @patch(f"{_SVC_MOD}.MemoRecordStyle")
    def test_existing_record_is_mapped(self, MockModel):
        obj = MagicMock(
            enabled=True,
            style="companion",
            custom_config={"density": "concise"},
            extra_preference="多关注决策习惯",
        )
        MockModel.objects.using.return_value.filter.return_value.first.return_value = obj
        cfg = load_effective_record_style("u", "ws")
        assert cfg == {
            "enabled": True,
            "style": "companion",
            "custom_config": {"density": "concise"},
            "extra_preference": "多关注决策习惯",
        }


# ════════════ 无 DB：RecordStyleUpdateRequest schema 边界守卫（TM-12）════════════


class TestRecordStyleUpdateRequestSchema:

    def test_normal_custom_config_accepted(self):
        req = RecordStyleUpdateRequest(
            style="custom",
            custom_config={
                "density": "moderate",
                "depth": "with_judgment",
                "tone": "warm",
                "focus": ["about_user", "method"],
            },
        )
        assert req.custom_config["density"] == "moderate"

    def test_none_custom_config_accepted(self):
        # custom_config 不提供，只改 enabled —— 不应触发守卫
        req = RecordStyleUpdateRequest(enabled=False)
        assert req.custom_config is None

    def test_too_many_keys_rejected(self):
        with pytest.raises(ValidationError):
            RecordStyleUpdateRequest(
                custom_config={f"k{i}": "v" for i in range(21)},
            )

    def test_huge_focus_list_rejected(self):
        with pytest.raises(ValidationError):
            RecordStyleUpdateRequest(
                custom_config={"focus": ["outcome"] * 51},
            )

    def test_non_dict_custom_config_rejected(self):
        with pytest.raises(ValidationError):
            RecordStyleUpdateRequest(custom_config=["about_user"])

    def test_empty_update_rejected(self):
        # model_validator：至少一个待更新字段
        with pytest.raises(ValidationError):
            RecordStyleUpdateRequest()


# ════════════════════════ 需 DB：RecordStyleService ════════════════════════


@pytest.fixture
def member_user(db):
    User = get_user_model()
    return User.objects.create(email=f"member-{uuid.uuid4()}@example.com")


@pytest.fixture
def owned_organization(db, member_user):
    """member_user 是 owner → 天然有 viewer+ 权限。"""
    from apps.tabtinspace.models import Organization
    return Organization.objects.create(name="自验团队", owner=member_user, type="team")


@pytest.fixture
def foreign_organization(db):
    """另一个用户拥有、member_user 不是成员 → 越权场景。"""
    from apps.tabtinspace.models import Organization
    User = get_user_model()
    other = User.objects.create(email=f"other-{uuid.uuid4()}@example.com")
    return Organization.objects.create(name="他人团队", owner=other, type="team")


@pytest.mark.django_db(databases=["default", "postgresql"])
class TestRecordStyleServiceDB:

    def test_get_style_default_when_no_record(self, member_user, owned_organization):
        svc = RecordStyleService(user=member_user)
        cfg = svc.get_style(organization_id=str(owned_organization.id))
        assert cfg["enabled"] is True
        assert cfg["style"] == "faithful"
        assert cfg["custom_config"] == {}
        assert cfg["extra_preference"] == ""

    def test_update_creates_then_upserts_single_row(self, member_user, owned_organization):
        from apps.tabmemo.constants import TABMEMO_DB
        from apps.tabmemo.models import MemoRecordStyle

        svc = RecordStyleService(user=member_user)
        ws = str(owned_organization.id)

        cfg = svc.update_style(organization_id=ws, enabled=False, style="minimal")
        assert cfg["enabled"] is False
        assert cfg["style"] == "minimal"

        cfg2 = svc.update_style(organization_id=ws, enabled=True, style="companion")
        assert cfg2["enabled"] is True
        assert cfg2["style"] == "companion"

        # upsert 而非新建：同 (user, organization) 仍只有一行
        count = MemoRecordStyle.objects.using(TABMEMO_DB).filter(
            user_id=str(member_user.id), organization_id=ws,
        ).count()
        assert count == 1

    def test_extra_preference_truncated_at_limit(self, member_user, owned_organization):
        svc = RecordStyleService(user=member_user)
        long_text = "x" * (EXTRA_PREFERENCE_MAX_CHARS + 500)
        cfg = svc.update_style(
            organization_id=str(owned_organization.id), extra_preference=long_text,
        )
        assert len(cfg["extra_preference"]) == EXTRA_PREFERENCE_MAX_CHARS

    def test_custom_config_whitelist_persisted(self, member_user, owned_organization):
        svc = RecordStyleService(user=member_user)
        cfg = svc.update_style(
            organization_id=str(owned_organization.id),
            style="custom",
            custom_config={
                "density": "moderate",                 # 合法
                "depth": "bogus",                      # 非法枚举 → 丢
                "tone": "warm",                        # 合法
                "focus": ["about_user", "evil", "method"],  # evil → 丢
                "junk": "y" * 10_000,                  # 未知键 → 丢
            },
        )
        assert cfg["custom_config"] == {
            "density": "moderate",
            "tone": "warm",
            "focus": ["about_user", "method"],
        }

    def test_switch_to_non_custom_clears_custom_config(self, member_user, owned_organization):
        """TM-16：从 custom 切到非 custom（minimal）时清空 custom_config，
        不把旧自定义维度持久化 / 回传。"""
        svc = RecordStyleService(user=member_user)
        ws = str(owned_organization.id)

        cfg = svc.update_style(
            organization_id=ws,
            style="custom",
            custom_config={"density": "concise", "focus": ["about_user"]},
        )
        assert cfg["style"] == "custom"
        assert cfg["custom_config"] == {"density": "concise", "focus": ["about_user"]}

        # 切到 minimal：custom_config 应被清空
        cfg2 = svc.update_style(organization_id=ws, style="minimal")
        assert cfg2["style"] == "minimal"
        assert cfg2["custom_config"] == {}

        # 重新 get 也确认持久化层无 stale 维度
        cfg3 = svc.get_style(organization_id=ws)
        assert cfg3["custom_config"] == {}

    def test_invalid_style_rejected_400(self, member_user, owned_organization):
        svc = RecordStyleService(user=member_user)
        with pytest.raises(ServiceError) as ei:
            svc.update_style(organization_id=str(owned_organization.id), style="nonsense")
        assert ei.value.status == 400

    def test_get_style_denied_for_non_member_403(self, member_user, foreign_organization):
        svc = RecordStyleService(user=member_user)
        with pytest.raises(ServiceError) as ei:
            svc.get_style(organization_id=str(foreign_organization.id))
        assert ei.value.status == 403

    def test_update_style_denied_for_non_member_403(self, member_user, foreign_organization):
        svc = RecordStyleService(user=member_user)
        with pytest.raises(ServiceError) as ei:
            svc.update_style(organization_id=str(foreign_organization.id), enabled=False)
        assert ei.value.status == 403
