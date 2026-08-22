"""
钱包服务基类

抽取 OrganizationWalletService 的公共逻辑，
通过 wallet_model / lookup_field / tx_wallet_field 三个类属性参数化差异。
"""

import logging
from datetime import datetime, time, timedelta
from typing import Optional, Dict, Any, Generator
from decimal import Decimal
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import Q, QuerySet
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from ..models import WalletTransaction
from ..exceptions import (
    InsufficientCreditsError,
    TransactionFailedError,
)

logger = logging.getLogger(__name__)

_TX_SEARCH_MAX_LEN = 200
_TX_EXPORT_BATCH_SIZE = 1000
_TX_EXPORT_HEADER = [
    "created_at",
    "transaction_id",
    "transaction_type",
    "description",
    "amount",
    "balance_before",
    "balance_after",
    "related_order_id",
    "reference_id",
    "usage_event_id",
]

_TX_ORDER_WHITELIST = frozenset({
    '-created_at',
    'created_at',
    '-amount_precise',
    'amount_precise',
    '-balance_after_precise',
    'balance_after_precise',
})


def _normalize_transaction_order(order_by: Optional[str]) -> str:
    if not order_by:
        return '-created_at'
    key = order_by.strip()
    return key if key in _TX_ORDER_WHITELIST else '-created_at'


def _csv_escape(value: Any) -> str:
    s = str(value) if value is not None else ""
    if any(c in s for c in (",", '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


def _aware_dt(dt: datetime) -> datetime:
    if timezone.is_naive(dt):
        return timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _apply_created_after_filter(qs: QuerySet, raw: str) -> QuerySet:
    d = parse_date(raw)
    if d:
        start = timezone.make_aware(datetime.combine(d, time.min))
        return qs.filter(created_at__gte=start)
    dt = parse_datetime(raw)
    if dt is None:
        return qs
    return qs.filter(created_at__gte=_aware_dt(dt))


def _apply_created_before_filter(qs: QuerySet, raw: str) -> QuerySet:
    d = parse_date(raw)
    if d:
        next_day = d + timedelta(days=1)
        boundary = timezone.make_aware(datetime.combine(next_day, time.min))
        return qs.filter(created_at__lt=boundary)
    dt = parse_datetime(raw)
    if dt is None:
        return qs
    return qs.filter(created_at__lte=_aware_dt(dt))


def validate_wallet_transaction_time_param(raw: Optional[str]) -> None:
    """
    查询参数非空时须为可解析的日历日 (YYYY-MM-DD) 或 ISO 日期时间。
    无法解析时抛出 ValueError，供 API 返回 400。
    """
    if raw is None or not str(raw).strip():
        return
    s = str(raw).strip()
    if parse_date(s) is not None:
        return
    if parse_datetime(s) is not None:
        return
    raise ValueError('invalid_wallet_transaction_time_filter')


def _parse_uuid(raw: str) -> Optional[UUID]:
    try:
        return UUID(str(raw))
    except (TypeError, ValueError, AttributeError):
        return None


def _compact_metadata(metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    clean = {k: v for k, v in metadata.items() if v not in (None, "", [])}
    return clean or None


def _usage_events_to_detail(events, aggregation_key: Optional[str] = None) -> Dict[str, Any]:
    events = list(events)
    if not events:
        return {}

    detail: Dict[str, Any] = {}
    if aggregation_key:
        detail["aggregation_key"] = aggregation_key

    statuses = {e.charge_status for e in events if e.charge_status}
    if len(statuses) == 1:
        detail["charge_status"] = next(iter(statuses))

    meter_keys = {e.meter_key for e in events if e.meter_key}
    units = {e.unit for e in events if e.unit}
    unit_prices = {e.unit_price for e in events if e.unit_price is not None}

    metadata: Dict[str, Any]
    if len(events) == 1:
        metadata = dict(events[0].metadata or {})
    else:
        metadata = {
            "event_count": len(events),
            "meter_keys": sorted(meter_keys),
        }

    if len(meter_keys) == 1:
        detail["meter_key"] = next(iter(meter_keys))
        detail["quantity"] = sum((Decimal(e.quantity) for e in events), Decimal("0"))
        if len(units) == 1:
            detail["unit"] = next(iter(units))
        if len(unit_prices) == 1:
            detail["unit_price"] = next(iter(unit_prices))

    compacted_metadata = _compact_metadata(metadata)
    if compacted_metadata:
        detail["metadata"] = compacted_metadata

    return detail


def _invoice_lines_to_detail(invoice, lines) -> Dict[str, Any]:
    lines = list(lines)
    if not invoice or not lines:
        return {}

    detail: Dict[str, Any] = {}
    meter_keys = {line.meter_key for line in lines if line.meter_key}
    units = {line.unit for line in lines if line.unit}
    unit_prices = {line.unit_price for line in lines if line.unit_price is not None}

    if len(meter_keys) == 1:
        detail["meter_key"] = next(iter(meter_keys))
        detail["quantity"] = sum((Decimal(line.quantity) for line in lines), Decimal("0"))
        if len(units) == 1:
            detail["unit"] = next(iter(units))
        if len(unit_prices) == 1:
            detail["unit_price"] = next(iter(unit_prices))

    metadata = {
        "invoice_no": invoice.invoice_no,
        "line_count": len(lines),
    }
    if len(lines) == 1 and isinstance(lines[0].metadata, dict):
        metadata.update(lines[0].metadata)
    detail["metadata"] = _compact_metadata(metadata)
    return detail


class BaseWalletService:
    """
    钱包服务抽象基类

    子类必须设置：
        wallet_model   — 钱包 Model 类
        lookup_field   — 查找钱包所用的字段名（'user_id' / 'organization_id'）
        tx_wallet_field — WalletTransaction 中的外键字段名（'wallet' / 'organization_wallet'）
    """

    wallet_model = None
    lookup_field = None
    tx_wallet_field = None

    # ── 工具方法 ──

    def _to_precise(self, value) -> Decimal:
        return self.wallet_model.quantize_credits(value)

    @staticmethod
    def _display_delta(before: int, after: int) -> int:
        return after - before

    def _resolve_tx_organization_id(self, owner_id, organization_id=None):
        """获取写入交易记录的 organization_id，子类可覆盖。

         FK 化：无归因时返回 None（NULL），不再用空串。
        """
        return organization_id or None

    # ── 钱包获取 / 创建 ──

    def _get_locked_wallet(self, owner_id):
        """获取钱包并加行锁，不存在时自动创建（并发安全）"""
        from django.db import IntegrityError

        lookup = {self.lookup_field: owner_id}
        wallet = self.wallet_model.objects.select_for_update().filter(**lookup).first()
        if wallet:
            return wallet

        try:
            defaults = {
                self.lookup_field: owner_id,
                'credits': 0,
                'credits_precise': Decimal('0.0000'),
                'credits_frozen': 0,
                'credits_frozen_precise': Decimal('0.0000'),
            }
            created = self.wallet_model.objects.create(**defaults)
        except IntegrityError:
            return self.wallet_model.objects.select_for_update().get(**lookup)

        logger.info(f"钱包创建成功: {self.lookup_field}={owner_id}")
        return self.wallet_model.objects.select_for_update().get(pk=created.pk)

    def get_or_create_wallet(self, owner_id):
        """获取或创建钱包（无锁）"""
        lookup = {self.lookup_field: owner_id}
        defaults = {
            'credits': 0,
            'credits_precise': Decimal('0.0000'),
            'credits_frozen': 0,
            'credits_frozen_precise': Decimal('0.0000'),
        }
        wallet, created = self.wallet_model.objects.get_or_create(**lookup, defaults=defaults)
        if created:
            logger.info(f"钱包创建成功: {self.lookup_field}={owner_id}")
        return wallet

    # ── 充值 ──

    @transaction.atomic
    def recharge(
        self,
        owner_id,
        credits_amount,
        order_id: Optional[str] = None,
        description: str = '点券充值',
        organization_id: Optional[str] = None,
        operator_user_id: str = '',
    ) -> WalletTransaction:
        """充值点券"""
        try:
            tx_organization_id = self._resolve_tx_organization_id(owner_id, organization_id)
            if order_id:
                existing_tx = WalletTransaction.objects.filter(
                    organization_id=tx_organization_id,
                    related_order_id=order_id,
                    transaction_type='recharge',
                ).first()
                if existing_tx:
                    logger.warning("充值幂等跳过: order_id=%s, existing_tx=%s", order_id, existing_tx.id)
                    return existing_tx

            try:
                with transaction.atomic():
                    wallet = self._get_locked_wallet(owner_id)
                    delta = self._to_precise(credits_amount)
                    if delta <= 0:
                        raise TransactionFailedError("充值点券必须大于0")

                    balance_before_precise = wallet.credits_precise
                    balance_before = wallet.credits

                    wallet.credits_precise = self._to_precise(wallet.credits_precise + delta)
                    wallet.sync_display_balances()
                    wallet.save(update_fields=['credits_precise', 'credits', 'updated_at'])

                    balance_after = wallet.credits
                    balance_after_precise = wallet.credits_precise
                    display_delta = self._display_delta(balance_before, balance_after)

                    tx_data = {
                        self.tx_wallet_field: wallet,
                        'transaction_type': 'recharge',
                        'amount': display_delta,
                        'amount_precise': delta,
                        'balance_before': balance_before,
                        'balance_before_precise': balance_before_precise,
                        'balance_after': balance_after,
                        'balance_after_precise': balance_after_precise,
                        'related_order_id': order_id or '',
                        'organization_id': tx_organization_id,
                        'operator_user_id': operator_user_id,
                        'description': description,
                    }
                    tx = WalletTransaction.objects.create(**tx_data)
            except IntegrityError:
                if order_id:
                    existing_tx = WalletTransaction.objects.filter(
                        organization_id=tx_organization_id,
                        related_order_id=order_id,
                        transaction_type='recharge',
                    ).first()
                    if existing_tx:
                        logger.warning(
                            "充值唯一约束命中，返回已有流水: order_id=%s, existing_tx=%s",
                            order_id, existing_tx.id,
                        )
                        return existing_tx
                raise

            logger.debug(
                f"点券充值成功: {self.lookup_field}={owner_id}, "
                f"amount={delta}, display={wallet.credits}, precise={wallet.credits_precise}"
            )
            self.invalidate_wallet_info_cache(owner_id)
            return tx

        except TransactionFailedError:
            raise
        except Exception as e:
            logger.error(f"点券充值失败: {self.lookup_field}={owner_id}, error={e}", exc_info=True)
            raise TransactionFailedError(f"点券充值失败: {e}") from e

    # ── 消费 ──

    @transaction.atomic
    def consume(
        self,
        owner_id,
        credits_amount,
        description: str = '点券消费',
        related_order_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        operator_user_id: str = '',
    ) -> WalletTransaction:
        """消费点券"""
        try:
            wallet = self._get_locked_wallet(owner_id)
            cost = self._to_precise(credits_amount)
            if cost <= 0:
                raise TransactionFailedError("消费点券必须大于0")

            available_precise = wallet.get_available_credits_precise()
            if available_precise < cost:
                raise InsufficientCreditsError(
                    f"credits 不足: 可用{available_precise}, 需要{cost}",
                    required=cost,
                    current=available_precise,
                )

            balance_before_precise = wallet.credits_precise
            balance_before = wallet.credits

            wallet.credits_precise = self._to_precise(wallet.credits_precise - cost)
            wallet.sync_display_balances()
            wallet.save(update_fields=['credits_precise', 'credits', 'updated_at'])

            balance_after = wallet.credits
            balance_after_precise = wallet.credits_precise
            display_delta = self._display_delta(balance_before, balance_after)

            tx_data = {
                self.tx_wallet_field: wallet,
                'transaction_type': 'consume',
                'amount': display_delta,
                'amount_precise': -cost,
                'balance_before': balance_before,
                'balance_before_precise': balance_before_precise,
                'balance_after': balance_after,
                'balance_after_precise': balance_after_precise,
                'related_order_id': related_order_id or '',
                'organization_id': self._resolve_tx_organization_id(owner_id, organization_id),
                'operator_user_id': operator_user_id,
                'description': description,
            }
            tx = WalletTransaction.objects.create(**tx_data)

            logger.debug(
                f"点券消费成功: {self.lookup_field}={owner_id}, "
                f"cost={cost}, display={wallet.credits}, precise={wallet.credits_precise}"
            )
            self.invalidate_wallet_info_cache(owner_id)
            return tx

        except InsufficientCreditsError:
            raise
        except TransactionFailedError:
            raise
        except Exception as e:
            logger.error(f"点券消费失败: {self.lookup_field}={owner_id}, error={e}", exc_info=True)
            raise TransactionFailedError(f"点券消费失败: {e}") from e

    # ── 赠送 ──

    @transaction.atomic
    def grant_credits(
        self,
        owner_id,
        credits_amount,
        description: str = '系统赠送',
        organization_id: Optional[str] = None,
        operator_user_id: str = '',
    ) -> WalletTransaction:
        """赠送点券"""
        try:
            wallet = self._get_locked_wallet(owner_id)
            delta = self._to_precise(credits_amount)
            if delta <= 0:
                raise TransactionFailedError("赠送点券必须大于0")

            balance_before_precise = wallet.credits_precise
            balance_before = wallet.credits

            wallet.credits_precise = self._to_precise(wallet.credits_precise + delta)
            wallet.sync_display_balances()
            wallet.save(update_fields=['credits_precise', 'credits', 'updated_at'])

            balance_after = wallet.credits
            balance_after_precise = wallet.credits_precise
            display_delta = self._display_delta(balance_before, balance_after)

            tx_data = {
                self.tx_wallet_field: wallet,
                'transaction_type': 'grant',
                'amount': display_delta,
                'amount_precise': delta,
                'balance_before': balance_before,
                'balance_before_precise': balance_before_precise,
                'balance_after': balance_after,
                'balance_after_precise': balance_after_precise,
                'organization_id': self._resolve_tx_organization_id(owner_id, organization_id),
                'operator_user_id': operator_user_id,
                'description': description,
            }
            tx = WalletTransaction.objects.create(**tx_data)

            logger.debug(
                f"点券赠送成功: {self.lookup_field}={owner_id}, "
                f"amount={delta}, display={wallet.credits}, precise={wallet.credits_precise}"
            )
            self.invalidate_wallet_info_cache(owner_id)
            return tx

        except TransactionFailedError:
            raise
        except Exception as e:
            logger.error(f"点券赠送失败: {self.lookup_field}={owner_id}, error={e}", exc_info=True)
            raise TransactionFailedError(f"点券赠送失败: {e}") from e

    # ── 退款 ──

    @transaction.atomic
    def refund(
        self,
        owner_id,
        credits_amount,
        description: str = '账单退款',
        related_order_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        operator_user_id: str = '',
    ) -> WalletTransaction:
        """退款（返还点券到钱包）"""
        try:
            wallet = self._get_locked_wallet(owner_id)
            delta = self._to_precise(credits_amount)
            if delta <= 0:
                raise TransactionFailedError("退款点券必须大于0")

            balance_before_precise = wallet.credits_precise
            balance_before = wallet.credits

            wallet.credits_precise = self._to_precise(wallet.credits_precise + delta)
            wallet.sync_display_balances()
            wallet.save(update_fields=['credits_precise', 'credits', 'updated_at'])

            balance_after = wallet.credits
            balance_after_precise = wallet.credits_precise
            display_delta = self._display_delta(balance_before, balance_after)

            tx_data = {
                self.tx_wallet_field: wallet,
                'transaction_type': 'refund',
                'amount': display_delta,
                'amount_precise': delta,
                'balance_before': balance_before,
                'balance_before_precise': balance_before_precise,
                'balance_after': balance_after,
                'balance_after_precise': balance_after_precise,
                'related_order_id': related_order_id or '',
                'organization_id': self._resolve_tx_organization_id(owner_id, organization_id),
                'operator_user_id': operator_user_id,
                'description': description,
            }
            tx = WalletTransaction.objects.create(**tx_data)

            logger.debug(
                f"点券退款成功: {self.lookup_field}={owner_id}, "
                f"amount={delta}, display={wallet.credits}, precise={wallet.credits_precise}"
            )
            self.invalidate_wallet_info_cache(owner_id)
            return tx

        except TransactionFailedError:
            raise
        except Exception as e:
            logger.error(f"点券退款失败: {self.lookup_field}={owner_id}, error={e}", exc_info=True)
            raise TransactionFailedError(f"点券退款失败: {e}") from e

    # ── 查询 ──

    _WALLET_INFO_CACHE_TTL = 30  # seconds

    def _wallet_info_cache_key(self, owner_id) -> str:
        model_name = self.wallet_model.__name__.lower()
        return f"wallet:info:{model_name}:{owner_id}"

    def invalidate_wallet_info_cache(self, owner_id) -> None:
        """充值/扣费后主动失效缓存"""
        try:
            from django.core.cache import cache
            cache.delete(self._wallet_info_cache_key(owner_id))
        except Exception:
            pass

    def get_wallet_info(self, owner_id) -> Dict[str, Any]:
        """获取钱包信息（WAL-13: 30s TTL 短缓存，减少高频 SELECT）"""
        from django.core.cache import cache

        cache_key = self._wallet_info_cache_key(owner_id)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        lookup = {self.lookup_field: owner_id}
        try:
            wallet = self.wallet_model.objects.get(**lookup)
            info = {
                'credits': wallet.credits,
                'credits_precise': wallet.credits_precise,
                'credits_frozen': wallet.credits_frozen,
                'credits_frozen_precise': wallet.credits_frozen_precise,
                'available_credits': wallet.get_available_credits(),
                'available_credits_precise': wallet.get_available_credits_precise(),
            }
        except self.wallet_model.DoesNotExist:
            info = {
                'credits': 0,
                'credits_precise': Decimal('0.0000'),
                'credits_frozen': 0,
                'credits_frozen_precise': Decimal('0.0000'),
                'available_credits': 0,
                'available_credits_precise': Decimal('0.0000'),
            }

        try:
            cache.set(cache_key, info, self._WALLET_INFO_CACHE_TTL)
        except Exception:
            pass
        return info

    # ── WAL-15: 主动初始化钱包 ──

    def ensure_wallet_exists(self, owner_id) -> None:
        """确保钱包记录存在（用于 organization 创建时主动初始化，余额为 0）。
        调用方应在 organization 创建流程中调用此方法。
        """
        self.get_or_create_wallet(owner_id)

    def get_transaction_history(
        self,
        owner_id,
        transaction_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        *,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        search: Optional[str] = None,
        order_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """获取交易历史"""
        try:
            queryset = self.build_transaction_queryset(
                owner_id,
                transaction_type=transaction_type,
                created_after=created_after,
                created_before=created_before,
                search=search,
                order_by=order_by,
            )

            total = queryset.count()
            transactions = list(queryset[offset:offset + limit])
            billing_detail_by_tx_id = self._build_transaction_billing_details(transactions)

            return {
                'total': total,
                'transactions': [
                    {
                        'id': t.id,
                        'transaction_type': t.transaction_type,
                        'amount': t.amount,
                        'amount_precise': t.amount_precise,
                        'balance_before': t.balance_before,
                        'balance_before_precise': t.balance_before_precise,
                        'balance_after': t.balance_after,
                        'balance_after_precise': t.balance_after_precise,
                        # Organization.id 为 UUIDField：FK 收敛后 t.organization_id
                        # 是 UUID，而 TransactionResponse.organization_id 要 str；
                        # legacy 流水可能为 NULL，落空串避免列表接口 500。
                        'organization_id': (
                            str(t.organization_id) if t.organization_id is not None else ''
                        ),
                        'description': t.description,
                        'created_at': t.created_at,
                        'related_order_id': t.related_order_id or None,
                        'reference_id': t.reference_key or None,
                        'usage_event_id': t.usage_event_id or None,
                        **billing_detail_by_tx_id.get(t.id, {}),
                    }
                    for t in transactions
                ],
            }

        except self.wallet_model.DoesNotExist:
            return {'total': 0, 'transactions': []}

    def build_transaction_queryset(
        self,
        owner_id,
        transaction_type: Optional[str] = None,
        *,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        search: Optional[str] = None,
        order_by: Optional[str] = None,
    ) -> QuerySet:
        """构建钱包流水查询；列表和导出必须共用，避免筛选口径漂移。"""
        lookup = {self.lookup_field: owner_id}
        wallet = self.wallet_model.objects.get(**lookup)
        queryset = WalletTransaction.objects.filter(**{self.tx_wallet_field: wallet})

        if transaction_type:
            queryset = queryset.filter(transaction_type=transaction_type)

        if created_after and str(created_after).strip():
            queryset = _apply_created_after_filter(queryset, str(created_after).strip())

        if created_before and str(created_before).strip():
            queryset = _apply_created_before_filter(queryset, str(created_before).strip())

        if search and str(search).strip():
            term = str(search).strip()[:_TX_SEARCH_MAX_LEN]
            queryset = queryset.filter(
                Q(description__icontains=term) | Q(id__icontains=term)
            )

        return queryset.order_by(_normalize_transaction_order(order_by))

    def generate_transaction_csv_rows(
        self,
        owner_id,
        transaction_type: Optional[str] = None,
        *,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        search: Optional[str] = None,
        order_by: Optional[str] = None,
    ) -> Generator[str, None, None]:
        """导出所有匹配筛选条件的钱包流水；不接受分页参数。"""
        yield "\ufeff" + ",".join(_TX_EXPORT_HEADER) + "\r\n"
        try:
            queryset = self.build_transaction_queryset(
                owner_id,
                transaction_type=transaction_type,
                created_after=created_after,
                created_before=created_before,
                search=search,
                order_by=order_by,
            )
        except self.wallet_model.DoesNotExist:
            return

        for tx in queryset.iterator(chunk_size=_TX_EXPORT_BATCH_SIZE):
            row = [
                tx.created_at.isoformat(),
                tx.id,
                tx.transaction_type,
                tx.description,
                tx.amount_precise,
                tx.balance_before_precise,
                tx.balance_after_precise,
                tx.related_order_id or "",
                tx.reference_key or "",
                tx.usage_event_id or "",
            ]
            yield ",".join(_csv_escape(v) for v in row) + "\r\n"

    def _build_transaction_billing_details(self, transactions) -> Dict[str, Dict[str, Any]]:
        """
        为钱包流水补充真实可追溯的计量明细。

        只使用稳定外键：
        - 小额异步聚合：WalletTransaction.related_order_id == BillingUsageEvent.aggregation_key
        - 同步扣款：WalletTransaction.usage_event_id == BillingUsageEvent.id
        - 账单自动扣款：WalletTransaction.related_order_id == BillingInvoice.id
        """
        txs = [
            t for t in transactions
            if t.transaction_type == "consume" and (t.related_order_id or t.usage_event_id)
        ]
        if not txs:
            return {}

        related_ids = list({t.related_order_id for t in txs if t.related_order_id})
        usage_event_ids = list({t.usage_event_id for t in txs if t.usage_event_id})
        organization_ids = list({t.organization_id for t in txs if t.organization_id})
        details: Dict[str, Dict[str, Any]] = {}

        try:
            from apps.services.billing.models import (
                BillingInvoice,
                BillingInvoiceLine,
                BillingUsageEvent,
            )
        except Exception as exc:
            logger.warning("[WalletTransaction] 计量明细模型加载失败: %s", exc)
            return details

        events_by_aggregation_key: Dict[str, list] = {}
        if related_ids and organization_ids:
            events = BillingUsageEvent.objects.filter(
                organization_id__in=organization_ids,
                aggregation_key__in=related_ids,
            ).only(
                "aggregation_key",
                "meter_key",
                "quantity",
                "unit",
                "unit_price",
                "charge_status",
                "metadata",
            )
            for event in events:
                events_by_aggregation_key.setdefault(event.aggregation_key, []).append(event)

        events_by_id: Dict[str, Any] = {}
        if usage_event_ids and organization_ids:
            events = BillingUsageEvent.objects.filter(
                id__in=usage_event_ids,
                organization_id__in=organization_ids,
            ).only(
                "id",
                "meter_key",
                "quantity",
                "unit",
                "unit_price",
                "charge_status",
                "metadata",
            )
            events_by_id = {str(event.id): event for event in events}

        raw_to_invoice_uuid: Dict[str, UUID] = {}
        for raw in related_ids:
            parsed = _parse_uuid(raw)
            if parsed:
                raw_to_invoice_uuid[raw] = parsed

        invoices_by_id: Dict[str, Any] = {}
        lines_by_invoice_id: Dict[str, list] = {}
        if raw_to_invoice_uuid:
            invoices = BillingInvoice.objects.filter(
                id__in=list(raw_to_invoice_uuid.values()),
                organization_id__in=organization_ids,
            ).only("id", "invoice_no", "organization_id")
            invoices_by_id = {str(invoice.id): invoice for invoice in invoices}
            if invoices_by_id:
                lines = BillingInvoiceLine.objects.filter(
                    invoice_id__in=list(invoices_by_id.keys()),
                ).only(
                    "invoice_id",
                    "meter_key",
                    "quantity",
                    "unit",
                    "unit_price",
                    "metadata",
                )
                for line in lines:
                    lines_by_invoice_id.setdefault(str(line.invoice_id), []).append(line)

        for tx in txs:
            direct_event = events_by_id.get(tx.usage_event_id)
            if direct_event:
                details[tx.id] = _usage_events_to_detail([direct_event])
                details[tx.id]["usage_event_id"] = tx.usage_event_id
                continue

            usage_events = events_by_aggregation_key.get(tx.related_order_id)
            if usage_events:
                details[tx.id] = _usage_events_to_detail(
                    usage_events,
                    aggregation_key=tx.related_order_id,
                )
                continue

            invoice_uuid = raw_to_invoice_uuid.get(tx.related_order_id)
            invoice = invoices_by_id.get(str(invoice_uuid)) if invoice_uuid else None
            if invoice:
                details[tx.id] = _invoice_lines_to_detail(
                    invoice,
                    lines_by_invoice_id.get(str(invoice.id), []),
                )

        return details
