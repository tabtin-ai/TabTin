"""
MemoRecordStyle 读写 service —— per-(user, organization) 的 Agent 笔记记录风格偏好。

- 前台 API（用户改自己的偏好）：``RecordStyleService``（带 organization 成员权限校验）。
- 后台蒸馏链路（按 user_id + organization_id 直读，无 request 上下文）：
  ``load_effective_record_style`` 模块级函数。

跨库：跟随同 app 既有模式用 ``.using(TABMEMO_DB)``（tabmemo 路由到 PostgreSQL）。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from apps.i18n import _
from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabmemo.constants import TABMEMO_DB
from apps.tabmemo.error_codes import ErrorCode
from apps.tabmemo.models import MemoRecordStyle

logger = logging.getLogger(__name__)

VALID_STYLES = {c[0] for c in MemoRecordStyle.Style.choices}

# extra_preference 上限（与 personal_rules 量级对齐，避免无界文本注入 prompt）
EXTRA_PREFERENCE_MAX_CHARS = 1000

# 无记录时的 effective 默认（= 现状行为：开启 + 忠实记录）
DEFAULT_RECORD_STYLE: Dict[str, Any] = {
    "enabled": True,
    "style": MemoRecordStyle.Style.FAITHFUL,
    "custom_config": {},
    "extra_preference": "",
}

# 读取异常时的 fail-closed 配置（TM-4 隐私）：``enabled`` 是用户的隐私闸门
# （「别记我的对话」）。DB 抖动等读取失败时，无法确认用户当前意愿，宁可不记
# （enabled=False）也不要 fail-open 成「记」——一旦用户已关闭却被回退成开启，
# 等于违背其明确意愿。style 仍维持 faithful（万一上层把 enabled 改回 True 也安全）。
FAIL_CLOSED_RECORD_STYLE: Dict[str, Any] = {
    "enabled": False,
    "style": MemoRecordStyle.Style.FAITHFUL,
    "custom_config": {},
    "extra_preference": "",
}

# ── custom_config 白名单（TM-12 防无界存储 / DoS）──
# 客户端可 PATCH 任意 dict，必须在写入前规约成已知维度。各维度合法值与渲染器
# ``record_preference.py`` 的维度表保持同步（那里是渲染语义的权威，这里是写入侧
# 的输入校验权威；渲染器对未知值同样静默忽略，构成纵深防御）。
_CUSTOM_CONFIG_SCALAR_DIMS: Dict[str, set] = {
    "density": {"concise", "moderate", "detailed"},
    "depth": {"facts_only", "with_judgment"},
    "tone": {"objective", "natural", "warm"},
}
_CUSTOM_CONFIG_FOCUS_VALUES = {"outcome", "method", "about_user", "emotion"}
# focus 是 4 选多选；扫描上限兜底，避免恶意超大 list 在 sanitize 里被全量遍历。
_CUSTOM_CONFIG_FOCUS_SCAN_LIMIT = 64


def _sanitize_custom_config(raw: Any) -> Dict[str, Any]:
    """把客户端传入的 ``custom_config`` 规约为白名单内的安全 dict（TM-12）。

    - 非 dict → ``{}``
    - 只保留 ``density`` / ``depth`` / ``tone`` / ``focus`` 四个已知键，其余丢弃
      （防无界存储；注意标量维度按 O(1) ``get`` 取值，不遍历 raw 的全部键，
      因此「键超多」本身不构成本函数的 DoS 面）。
    - 标量维度只接受合法枚举值（与渲染器维度表对齐），非法 / 非字符串丢弃——
      顺带把「超大字符串值」一并挡掉（不在枚举内即丢）。
    - ``focus`` 多选：仅扫描前 ``_CUSTOM_CONFIG_FOCUS_SCAN_LIMIT`` 个元素、
      只保留合法值并去重，非 list 丢弃——避免超大 list 拖垮 sanitize。
    """
    if not isinstance(raw, dict):
        return {}
    clean: Dict[str, Any] = {}
    for dim, allowed in _CUSTOM_CONFIG_SCALAR_DIMS.items():
        val = raw.get(dim)
        if isinstance(val, str) and val in allowed:
            clean[dim] = val
    focus = raw.get("focus")
    if isinstance(focus, (list, tuple)):
        seen: list = []
        for f in focus[:_CUSTOM_CONFIG_FOCUS_SCAN_LIMIT]:
            if (
                isinstance(f, str)
                and f in _CUSTOM_CONFIG_FOCUS_VALUES
                and f not in seen
            ):
                seen.append(f)
        if seen:
            clean["focus"] = seen
    return clean


def _to_dict(obj: Optional[MemoRecordStyle]) -> Dict[str, Any]:
    """把模型实例（或 None）规约成 effective 配置 dict（缺省填默认）。"""
    if obj is None:
        return dict(DEFAULT_RECORD_STYLE)
    return {
        "enabled": obj.enabled,
        "style": obj.style or MemoRecordStyle.Style.FAITHFUL,
        "custom_config": obj.custom_config or {},
        "extra_preference": obj.extra_preference or "",
    }


def load_effective_record_style(user_id: str, organization_id: str) -> Dict[str, Any]:
    """后台蒸馏链路用：按 (user_id, organization_id) 直读 effective 配置。

    无 request / 权限上下文（Celery 任务调用）。三种情况区分对待：

    - **查无记录**（``.first()`` 返回 None）→ 默认开（``enabled=True`` + 忠实记录），
      符合产品默认、向后兼容存量 (user, organization)。
    - **读取异常**（DB 抖动等抛异常）→ **fail-closed**（``enabled=False``，不记）。
      ``enabled`` 是隐私闸门，读取失败时无法确认意愿，不能 fail-open 成「记」
      （TM-4）。蒸馏主流程不被阻塞——调用方据 ``enabled=False`` 安全短路跳过。
    - **入参缺失**（user_id / organization_id 为空）→ 默认开（向后兼容；正常链路上游
      已对 organization_id 为空做了跳过，到这里通常入参完整）。
    """
    if not user_id or not organization_id:
        return dict(DEFAULT_RECORD_STYLE)
    try:
        obj = MemoRecordStyle.objects.using(TABMEMO_DB).filter(
            user_id=user_id, organization_id=organization_id,
        ).first()
        return _to_dict(obj)
    except Exception as exc:  # TM-4: 读取失败 fail-closed（不记），不拖垮蒸馏
        logger.warning(
            "[RecordStyle] load failed, fail-closed (skip recording): user=%s ws=%s err=%s",
            user_id, organization_id, exc,
        )
        return dict(FAIL_CLOSED_RECORD_STYLE)


def resolve_record_preference(user_id: str, organization_id: str) -> tuple[bool, str]:
    """蒸馏链路统一入口：读 (user_id, organization_id) 的 effective 记录风格，返回
    ``(enabled, record_preference_text)``。

    把「读配置 → 判 enabled → 渲染偏好文本」三步收口到一处，供 ``capture`` /
    ``task_summary`` 两条蒸馏链路复用，避免接线在两处各写一遍、逐渐漂移（TM-16）。

    - ``enabled=False``：用户关了记忆，或 ``load_effective_record_style`` 读取
      异常 fail-closed（TM-4，不记）。调用方据此跳过整次蒸馏（不调 LLM）。
    - ``enabled=True``：``record_preference_text`` 为渲染好的注入文本；faithful /
      无可渲染内容时为空串（调用方原样传给 prompt 变量即可，模板自带空值守卫）。

    语义完全沿用 ``load_effective_record_style`` + ``render_record_preference``，
    不改变「读取异常 fail-closed / 查无记录默认开」的既有行为。

    NOTE: ``render_record_preference`` 在函数内 import——它是纯函数，延迟导入既避免
    模块级耦合，也让 wiring 测试能在源模块处 patch（见 test_record_style_wiring）。
    """
    from apps.tabmemo.services.record_preference import render_record_preference

    style_cfg = load_effective_record_style(user_id, organization_id)
    if not style_cfg.get("enabled", True):
        return False, ""
    text = render_record_preference(
        style_cfg.get("style", "faithful"),
        style_cfg.get("custom_config"),
        style_cfg.get("extra_preference", ""),
    )
    return True, text


class RecordStyleService(BaseService):
    """前台 API service：读写当前用户在某 Organization 的记录风格偏好。"""

    def get_style(self, organization_id: str) -> Dict[str, Any]:
        """读 effective 配置（缺记录返回默认）。需 organization 成员（viewer）。"""
        if not self.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403,
            )
        user_id = str(self.user.id)
        obj = MemoRecordStyle.objects.using(TABMEMO_DB).filter(
            user_id=user_id, organization_id=organization_id,
        ).first()
        return _to_dict(obj)

    def update_style(
        self,
        organization_id: str,
        *,
        enabled: Optional[bool] = None,
        style: Optional[str] = None,
        custom_config: Optional[Dict[str, Any]] = None,
        extra_preference: Optional[str] = None,
    ) -> Dict[str, Any]:
        """更新（不存在则创建）当前用户在该 Organization 的记录风格。需 organization 成员。"""
        if not self.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403,
            )

        if style is not None and style not in VALID_STYLES:
            raise ServiceError(
                ErrorCode.INVALID_INPUT,
                f"无效的记录风格: {style}",
                status=400,
            )

        user_id = str(self.user.id)
        obj, _created = MemoRecordStyle.objects.using(TABMEMO_DB).get_or_create(
            user_id=user_id, organization_id=organization_id,
        )

        if enabled is not None:
            obj.enabled = bool(enabled)
        if style is not None:
            obj.style = style
        if custom_config is not None:
            # TM-12: 键白名单 + 枚举校验，杜绝无界 dict 落库（DoS 面）
            obj.custom_config = _sanitize_custom_config(custom_config)
        if extra_preference is not None:
            obj.extra_preference = (extra_preference or "")[:EXTRA_PREFERENCE_MAX_CHARS]

        # TM-16: 非 custom 风格不保留自定义维度——切到 minimal/faithful/companion 时
        # 清空 custom_config，避免旧维度被持久化 / 回传给前端造成困惑（渲染器本就只在
        # style==custom 时读 custom_config，这里在写入侧也保证数据干净、幂等）。
        if obj.style != MemoRecordStyle.Style.CUSTOM:
            obj.custom_config = {}

        obj.save(using=TABMEMO_DB)
        return _to_dict(obj)
