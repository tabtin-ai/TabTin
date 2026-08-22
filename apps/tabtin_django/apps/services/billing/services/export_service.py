"""
费用导出 / 审计报表服务。

提供 CSV 行 generator（内存 O(1)）和多维度汇总，
供 billing API 的 `/billing/export` 端点调用。

导出 schema：
- audit（默认）：机读全量列，含 user_id / task_name / biz_id 等，供成员用量与审计归因
- ledger：兼容旧客户端的 LLM 中文窄列，仅在显式 schema=ledger 时启用
- llm_usage：当前 Electron「LLM 用量」场景列表中文窄列，仅在显式 schema=llm_usage 时启用
"""

from __future__ import annotations

import logging
import json
from datetime import date, timedelta, tzinfo
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Generator, List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

logger = logging.getLogger(__name__)

MAX_EXPORT_DAYS = 90
BATCH_SIZE = 2000

EXPORT_SCHEMA_AUDIT = "audit"
EXPORT_SCHEMA_LEDGER = "ledger"
EXPORT_SCHEMA_LLM_USAGE = "llm_usage"
SUPPORTED_EXPORT_SCHEMAS = frozenset({
    EXPORT_SCHEMA_AUDIT,
    EXPORT_SCHEMA_LEDGER,
    EXPORT_SCHEMA_LLM_USAGE,
})

# 默认 / 成员导出：保留归因字段（ task_name；user_id 供成员识别）
CSV_HEADER_AUDIT = [
    "id",
    "organization_id",
    "user_id",
    "meter_key",
    "quantity",
    "unit",
    "amount",
    "currency",
    "model_name",
    "scene_key",
    # ：任务名 = metadata.session_id 反查的会话标题；
    # 非会话类消耗与历史数据为空。
    "task_name",
    "biz_type",
    "biz_id",
    "metadata",
    "charge_status",
    "occurred_at",
    "created_at",
]

# 与 Electron 用量中心「LLM 用量」列表列顺序 / 中文口径对齐
CSV_HEADER_LEDGER = [
    "计量项",
    "用量",
    "模型",
    "业务类型",
    "credits",
    "场景",
    "创建时间",
]

# 当前 Electron「LLM 用量」场景列表导出。与页面列顺序一致；不同于既有
# ledger 契约，它不展示业务类型。旧客户端仍请求 ledger，故不得修改其列。
CSV_HEADER_LLM_USAGE = [
    "计量项",
    "场景",
    "用量",
    "模型",
    "credits",
    "创建时间",
]

# 兼容旧 import：默认即 audit 契约
CSV_HEADER = CSV_HEADER_AUDIT

# 标签与 apps/tabtin-electron/.../formatBilling.ts 保持一致
_METER_KEY_LABELS = {
    "llm.tokens": "LLM Token",
    "storage.gb_day": "存储 (GB·天)",
    "storage.bytes": "存储 (字节)",
    "storage.oss.bytes": "对象存储",
}
_BIZ_TYPE_LABELS = {
    "llm_chat": "LLM 对话",
    "llm_call": "模型调用",
    "llm": "模型调用",
    "llm_blocked": "调用拦截",
    "charge_failed": "扣费失败",
    "charge_skipped": "跳过扣费",
    "storage": "存储",
    "seed": "验收数据",
}
_SCENE_KEY_LABELS = {
    "_main_chat": "主对话",
    "_sub_agent": "子 Agent",
    "_compact": "上下文压缩",
    "_summary_judge": "摘要评判",
}

# 新版场景列表与 Electron `labelSceneKey` 对齐。独立于既有 ledger 的映射，
# 以免改变已发布客户端对旧 schema 的 CSV 展示契约。
_LLM_USAGE_SCENE_KEY_LABELS = {
    **_SCENE_KEY_LABELS,
    "commit_message_generation": "Commit 信息生成",
    "memory_capture": "记忆增强",
    "diary_distill": "记忆增强",
    "user_portrait_distill": "记忆增强",
    "memory_compaction": "记忆增强",
}


def normalize_export_schema(schema: Optional[str]) -> str:
    raw = (schema or EXPORT_SCHEMA_AUDIT).strip().lower()
    if raw not in SUPPORTED_EXPORT_SCHEMAS:
        raise ValueError(
            f"unsupported export schema {schema!r}; "
            f"expected one of {sorted(SUPPORTED_EXPORT_SCHEMAS)}"
        )
    return raw


def _csv_escape(value: Any) -> str:
    """对 CSV 单元格值做最小化转义（双引号包裹含逗号/引号/换行的值）。"""
    s = str(value) if value is not None else ""
    if any(c in s for c in (",", '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


def _csv_text(value: Any) -> str:
    """文本字段防 CSV 公式注入；数值字段不要走这里，避免负数被改写。"""
    s = str(value) if value is not None else ""
    if s.startswith(("=", "+", "-", "@")):
        return "'" + s
    return s


def _format_decimal(value: Any) -> str:
    """导出金额/数量使用普通十进制字符串，避免表格软件显示成科学计数或货币符号。"""
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value or 0))
    return format(decimal_value.normalize(), "f")


def _to_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or 0))


def resolve_export_timezone(name: Optional[str]) -> tzinfo:
    """解析导出显示时区：空则回落 Django TIME_ZONE；非法 IANA 名抛 ValueError。"""
    raw = (name or "").strip()
    if not raw:
        return timezone.get_current_timezone()
    try:
        return ZoneInfo(raw)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise ValueError(f"invalid timezone: {raw}") from exc


def _format_fixed_fraction(value: Decimal, digits: int) -> str:
    """固定小数位（对齐 JS toFixed），全程 Decimal，不经 float。"""
    quant = Decimal("1").scaleb(-digits)
    rounded = value.quantize(quant, rounding=ROUND_HALF_UP)
    sign = "-" if rounded < 0 else ""
    rounded = abs(rounded)
    raw = format(rounded, "f")
    if "." in raw:
        whole, frac = raw.split(".", 1)
    else:
        whole, frac = raw, ""
    frac = (frac + ("0" * digits))[:digits]
    return f"{sign}{whole}.{frac}"


def _format_display_number(value: Any, *, maximum_fraction_digits: int = 2) -> str:
    """与 Electron `Intl.NumberFormat(..., { maximumFractionDigits })` 对齐。

    舍入：ECMA-402 默认 halfExpand ≡ Decimal ROUND_HALF_UP（避免 float 的 2.675→2.67）。
    千分位逗号 + 小数点（zh-CN / en-US 常见）；含逗号时由 `_csv_escape` 加引号。
    """
    try:
        d = _to_decimal(value)
    except (InvalidOperation, TypeError, ValueError, ArithmeticError):
        return "0"
    if d.is_nan():
        return "0"
    quant = Decimal("1").scaleb(-maximum_fraction_digits)
    rounded = d.quantize(quant, rounding=ROUND_HALF_UP)
    sign = "-" if rounded < 0 else ""
    rounded = abs(rounded)
    raw = format(rounded, "f")
    if "." in raw:
        raw = raw.rstrip("0").rstrip(".")
    if "." in raw:
        int_part, frac_part = raw.split(".", 1)
    else:
        int_part, frac_part = raw, ""
    grouped = f"{int(int_part):,}"
    body = f"{grouped}.{frac_part}" if frac_part else grouped
    return f"{sign}{body}"


def _format_credits_auto(value: Any) -> str:
    """与 Electron `formatCreditsAuto` 同口径，供 ledger CSV credits 列对齐。"""
    try:
        d = _to_decimal(value)
    except (InvalidOperation, TypeError, ValueError, ArithmeticError):
        return "0"
    if d.is_nan() or d == 0:
        return "0"
    abs_d = abs(d)
    if abs_d < Decimal("0.01"):
        return _format_fixed_fraction(d, 4)
    if abs_d < Decimal("1"):
        return _format_fixed_fraction(d, 2)
    # n >= 1：toLocaleString / Intl.NumberFormat({ maximumFractionDigits: 2 })
    return _format_display_number(d, maximum_fraction_digits=2)


def _format_dt_audit(value: Any) -> str:
    if not value:
        return ""
    return timezone.localtime(value).strftime("%Y-%m-%d %H:%M:%S")


def _format_dt_ledger(value: Any, *, tz: Optional[tzinfo] = None) -> str:
    """按客户端（或默认）时区格式化发生时间；强制文本前缀避免 Excel #####。"""
    if not value:
        return "—"
    target_tz = tz or timezone.get_current_timezone()
    local = timezone.localtime(value, target_tz)
    text = (
        f"{local.year:04d}/{local.month:02d}/{local.day:02d} "
        f"{local.strftime('%H:%M:%S')}"
    )
    return f"\t{text}"


def _format_json(value: Any) -> str:
    if value in (None, ""):
        return ""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _label_meter_key(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        return "—"
    return _METER_KEY_LABELS.get(key, key)


def _label_biz_type(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        return "—"
    return _BIZ_TYPE_LABELS.get(key, key)


def _label_scene_key(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        return "—"
    return _SCENE_KEY_LABELS.get(key, key)


def _label_llm_usage_scene_key(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        return "—"
    return _LLM_USAGE_SCENE_KEY_LABELS.get(key, key)


def _format_quantity_with_unit(quantity: Any, unit: Any) -> str:
    """对齐客户端用量列：`formatNumber(quantity, { maximumFractionDigits: 2 }) {unit}`。"""
    try:
        d = _to_decimal(quantity)
        if d.is_nan():
            d = Decimal("0")
    except (InvalidOperation, TypeError, ValueError, ArithmeticError):
        d = Decimal("0")
    qty_text = _format_display_number(d, maximum_fraction_digits=2)
    unit_text = str(unit or "").strip()
    return f"{qty_text} {unit_text}".strip() if unit_text else qty_text


class BillingExportService:
    """费用导出服务，不持有状态，所有方法均为 classmethod。"""

    # ── 日期辅助 ──────────────────────────────────────────

    @staticmethod
    def last_month_range() -> Tuple[date, date]:
        """返回上个月的 (首日, 末日)，用于"上月"快捷按钮。"""
        today = timezone.localdate()
        first_of_this_month = today.replace(day=1)
        last_day_of_prev = first_of_this_month - timedelta(days=1)
        first_of_prev = last_day_of_prev.replace(day=1)
        return first_of_prev, last_day_of_prev

    @staticmethod
    def validate_date_range(start_date: date, end_date: date) -> None:
        """校验日期范围，超过 MAX_EXPORT_DAYS 天抛 ValueError。"""
        if start_date > end_date:
            raise ValueError("start_date must be <= end_date")
        delta = (end_date - start_date).days
        if delta > MAX_EXPORT_DAYS:
            raise ValueError(
                f"Date range exceeds maximum of {MAX_EXPORT_DAYS} days "
                f"(requested {delta} days)"
            )

    # ── CSV generator ────────────────────────────────────

    @classmethod
    def generate_csv_rows(
        cls,
        organization_id: str,
        start_date: date,
        end_date: date,
        *,
        user_id: Optional[str] = None,
        meter_key: Optional[str] = None,
        biz_type: Optional[str] = None,
        scene_key: Optional[str] = None,
        schema: Optional[str] = None,
        display_timezone: Optional[tzinfo] = None,
    ) -> Generator[str, None, None]:
        """
        以 generator 方式逐行产出 CSV 文本（含 BOM 表头），
        内存占用 O(batch_size) 而非 O(N)。

        Parameters
        ----------
        organization_id : 组织 ID
        start_date / end_date : 日期范围（含两端）
        user_id : 可选，仅导出该用户的记录（editor 自助导出场景）
        meter_key : 可选，仅导出指定计量项（如 llm.tokens，避免存储审计混入 LLM 导出）
        scene_key : 可选，仅导出指定 LLM 场景（如 _main_chat）
        schema : audit（默认，成员/审计全量列）、ledger（兼容旧 LLM 窄列）或
            llm_usage（当前 LLM 场景列表窄列）
        display_timezone : LLM 窄列时间列显示时区（客户端 IANA）；缺省用 Django TIME_ZONE
        """
        from apps.services.billing.api_utils import usage_event_display_credits
        from apps.services.billing.models import BillingUsageEvent

        cls.validate_date_range(start_date, end_date)
        export_schema = normalize_export_schema(schema)
        is_llm_usage_export = export_schema in {
            EXPORT_SCHEMA_LEDGER,
            EXPORT_SCHEMA_LLM_USAGE,
        }
        is_scene_usage_export = export_schema == EXPORT_SCHEMA_LLM_USAGE
        if export_schema == EXPORT_SCHEMA_LLM_USAGE:
            header = CSV_HEADER_LLM_USAGE
        elif export_schema == EXPORT_SCHEMA_LEDGER:
            header = CSV_HEADER_LEDGER
        else:
            header = CSV_HEADER_AUDIT
        ledger_tz = display_timezone or timezone.get_current_timezone()

        # 筛选项不写入表格；仅通过 start/end/meter_key/biz_type 过滤数据行
        yield "\ufeff" + ",".join(header) + "\r\n"

        start_dt = timezone.make_aware(
            timezone.datetime.combine(start_date, timezone.datetime.min.time())
        )
        end_dt = timezone.make_aware(
            timezone.datetime.combine(end_date, timezone.datetime.max.time())
        )

        # keyset 翻页：游标字段必须与排序字段一致。
        # LLM 窄列与用量列表默认一致新→旧；audit 保持历史契约旧→新。
        # only() 避开宽 JSON / 无关列，缩短首批静默窗口（Electron 代理读超时敏感）。
        export_only = (
            "id",
            "organization_id",
            "user_id",
            "meter_key",
            "quantity",
            "unit",
            "amount",
            "currency",
            "model_name",
            "scene_key",
            "biz_type",
            "biz_id",
            "metadata",
            "charge_status",
            "occurred_at",
            "created_at",
        )
        base_filter = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start_dt,
            occurred_at__lte=end_dt,
        ).only(*export_only)
        if is_llm_usage_export:
            # 与用户侧用量列表一致：资金模式快照占位不是实际用量，不能导出成
            # ``0 token / 0 credits / 空模型`` 的伪账单。audit schema 保留原始行。
            qs = base_filter.exclude(
                metadata__status="pending_deduction",
            ).order_by("-occurred_at", "-id")
        else:
            qs = base_filter.order_by("occurred_at", "id")
        if user_id:
            qs = qs.filter(user_id=user_id)
        if meter_key:
            qs = qs.filter(meter_key=meter_key)
        if biz_type:
            from apps.services.billing.usage_event_filters import resolve_usage_event_biz_types

            biz_types = resolve_usage_event_biz_types(biz_type)
            if len(biz_types) == 1:
                qs = qs.filter(biz_type=biz_types[0])
            elif biz_types:
                qs = qs.filter(biz_type__in=biz_types)
        if scene_key:
            qs = qs.filter(scene_key=scene_key)

        last_occurred_at = None
        last_id = None
        while True:
            batch_qs = qs
            if last_id is not None:
                if is_llm_usage_export:
                    batch_qs = batch_qs.filter(
                        Q(occurred_at__lt=last_occurred_at)
                        | Q(occurred_at=last_occurred_at, id__lt=last_id)
                    )
                else:
                    batch_qs = batch_qs.filter(
                        Q(occurred_at__gt=last_occurred_at)
                        | Q(occurred_at=last_occurred_at, id__gt=last_id)
                    )
            batch = list(batch_qs[:BATCH_SIZE])
            if not batch:
                break

            task_names: Dict[str, str] = {}
            if not is_llm_usage_export:
                # ：按批反查会话标题作「任务名」列（每批一次 IN 查询）。
                from apps.services.billing.services.task_name_resolver import (
                    resolve_task_names_for_events,
                )
                task_names = resolve_task_names_for_events(batch, organization_id)

            for event in batch:
                last_occurred_at = event.occurred_at
                last_id = event.pk
                if is_llm_usage_export:
                    display_credits = _format_credits_auto(usage_event_display_credits(event))
                    model_name = (event.model_name or "").strip() or "—"
                    meter = _csv_text(_label_meter_key(event.meter_key))
                    scene_label = (
                        _label_llm_usage_scene_key(event.scene_key)
                        if is_scene_usage_export
                        else _label_scene_key(event.scene_key)
                    )
                    scene = _csv_text(scene_label)
                    quantity = _csv_text(_format_quantity_with_unit(event.quantity, event.unit))
                    model = _csv_text(model_name)
                    created_at = _csv_text(
                        _format_dt_ledger(
                            event.occurred_at or event.created_at,
                            tz=ledger_tz,
                        )
                    )
                    row = (
                        [
                            meter,
                            scene,
                            quantity,
                            model,
                            display_credits,
                            created_at,
                        ]
                        if is_scene_usage_export
                        else [
                            meter,
                            quantity,
                            model,
                            _csv_text(_label_biz_type(event.biz_type)),
                            display_credits,
                            scene,
                            created_at,
                        ]
                    )
                else:
                    row = [
                        str(event.id),
                        event.organization_id,
                        event.user_id or "",
                        event.meter_key,
                        _format_decimal(event.quantity),
                        event.unit,
                        _format_decimal(event.amount),
                        event.currency,
                        _csv_text(event.model_name or ""),
                        _csv_text(event.scene_key or ""),
                        _csv_text(task_names.get(str(event.id), "")),
                        _csv_text(event.biz_type or ""),
                        _csv_text(event.biz_id or ""),
                        _csv_text(_format_json(event.metadata or {})),
                        _csv_text(event.charge_status or ""),
                        _format_dt_audit(event.occurred_at),
                        _format_dt_audit(event.created_at),
                    ]
                yield ",".join(_csv_escape(v) for v in row) + "\r\n"
            if len(batch) < BATCH_SIZE:
                break

    # ── 汇总 ──────────────────────────────────────────────

    @classmethod
    def generate_summary(
        cls,
        organization_id: str,
        start_date: date,
        end_date: date,
        *,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        生成三个维度的汇总数据：按成员 / 按模型 / 按日期。

        Returns
        -------
        {
            "by_member": [...],
            "by_model": [...],
            "by_date": [...],
            "total_credits": "...",
            "total_events": N,
            "period": {"start": "...", "end": "..."},
        }
        """
        from apps.services.billing.models import BillingUsageEvent

        cls.validate_date_range(start_date, end_date)

        start_dt = timezone.make_aware(
            timezone.datetime.combine(start_date, timezone.datetime.min.time())
        )
        end_dt = timezone.make_aware(
            timezone.datetime.combine(end_date, timezone.datetime.max.time())
        )

        base_qs = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start_dt,
            occurred_at__lte=end_dt,
        )
        if user_id:
            base_qs = base_qs.filter(user_id=user_id)

        by_member_raw = list(
            base_qs
            .exclude(user_id="")
            .values("user_id")
            .annotate(
                total_credits=Sum("amount"),
                total_quantity=Sum("quantity"),
                event_count=Count("id"),
            )
            .order_by("-total_credits")[:100]
        )

        member_ids = [r["user_id"] for r in by_member_raw if r["user_id"]]
        user_info = cls._build_user_info_map_from_ids(member_ids)

        by_member: List[Dict[str, Any]] = []
        for row in by_member_raw:
            uid = row["user_id"]
            info = user_info.get(uid, {})
            by_member.append({
                "user_id": uid,
                "display_name": info.get("display_name", uid[:8]),
                "total_credits": str(row["total_credits"] or Decimal("0")),
                "total_quantity": str(row["total_quantity"] or Decimal("0")),
                "event_count": row["event_count"],
            })

        by_model = list(
            base_qs
            .exclude(model_name="")
            .values("model_name")
            .annotate(
                total_credits=Sum("amount"),
                total_quantity=Sum("quantity"),
                event_count=Count("id"),
            )
            .order_by("-total_credits")[:50]
        )
        by_model_out: List[Dict[str, Any]] = [
            {
                "model_name": r["model_name"],
                "total_credits": str(r["total_credits"] or Decimal("0")),
                "total_quantity": str(r["total_quantity"] or Decimal("0")),
                "event_count": r["event_count"],
            }
            for r in by_model
        ]

        by_date = list(
            base_qs
            .annotate(usage_date=TruncDate("occurred_at"))
            .values("usage_date")
            .annotate(
                total_credits=Sum("amount"),
                event_count=Count("id"),
            )
            .order_by("usage_date")
        )
        by_date_out: List[Dict[str, Any]] = [
            {
                "date": r["usage_date"].isoformat() if r["usage_date"] else "",
                "total_credits": str(r["total_credits"] or Decimal("0")),
                "event_count": r["event_count"],
            }
            for r in by_date
        ]

        totals = base_qs.aggregate(
            total_credits=Sum("amount"),
            total_events=Count("id"),
        )

        return {
            "by_member": by_member,
            "by_model": by_model_out,
            "by_date": by_date_out,
            "total_credits": str(totals["total_credits"] or Decimal("0")),
            "total_events": totals["total_events"] or 0,
            "period": {
                "start": start_date.isoformat(),
                "end": end_date.isoformat(),
            },
        }

    # ── 内部辅助 ──────────────────────────────────────────

    @classmethod
    def _build_user_info_map_lazy(
        cls,
        organization_id: str,
        start_date: date,
        end_date: date,
        user_id: Optional[str],
    ) -> Dict[str, Dict[str, str]]:
        """预加载日期范围内涉及的用户信息，避免 N+1。"""
        from apps.services.billing.models import BillingUsageEvent

        start_dt = timezone.make_aware(
            timezone.datetime.combine(start_date, timezone.datetime.min.time())
        )
        end_dt = timezone.make_aware(
            timezone.datetime.combine(end_date, timezone.datetime.max.time())
        )

        qs = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start_dt,
            occurred_at__lte=end_dt,
        ).exclude(user_id="")
        if user_id:
            qs = qs.filter(user_id=user_id)

        user_ids = list(qs.values_list("user_id", flat=True).distinct()[:200])
        return cls._build_user_info_map_from_ids(user_ids)

    @staticmethod
    def _build_user_info_map_from_ids(
        user_ids: List[str],
    ) -> Dict[str, Dict[str, str]]:
        """复用 member_usage_service 的用户信息查询逻辑。"""
        if not user_ids:
            return {}
        try:
            from apps.services.billing.services.member_usage_service import (
                build_user_info_map,
            )
            return build_user_info_map(user_ids)
        except Exception:
            logger.warning("Failed to load user info for export", exc_info=True)
            return {}
