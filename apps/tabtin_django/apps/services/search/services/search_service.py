from __future__ import annotations

import hashlib
import logging
from dataclasses import asdict
from decimal import Decimal
from typing import Iterable

from apps.services.search.constants import (
    DEFAULT_SEARCH_COUNT,
    DEFAULT_SEARCH_FRESHNESS,
    SEARCH_BILLING_METER_KEY,
    SEARCH_SERVICE_KEY,
)
from apps.services.search.services.base import (
    SearchProviderError,
    SearchProviderOutcomeUnknown,
)
from apps.services.search.services.invocation_identity import (
    VerifiedSearchInvocationIdentity,
    build_search_request_fingerprint,
)
from apps.services.search.services.runtime import SearchProviderRuntime
from apps.services.search.services.types import (
    SearchInvocationContext,
    SearchImageResult,
    SearchRequest,
    SearchResponse,
    SearchVideoResult,
    SearchWebPageResult,
)

logger = logging.getLogger(__name__)


class SearchService:
    @classmethod
    def search(
        cls,
        query: str,
        *,
        provider_key: str | None = None,
        count: int | None = None,
        summary: bool | None = None,
        freshness: str | None = None,
        include_domains: Iterable[str] | None = None,
        exclude_domains: Iterable[str] | None = None,
        organization_id: str | None = None,
        user_id: str | None = None,
        thread_id: str | None = None,
        biz_type: str = "search.web",
        charge_billing: bool = True,
        verified_invocation: VerifiedSearchInvocationIdentity | None = None,
    ) -> SearchResponse:
        normalized_query = (query or "").strip()
        if not normalized_query:
            raise SearchProviderError("query 不能为空", code="search_query_required")
        if verified_invocation is not None and not isinstance(
            verified_invocation,
            VerifiedSearchInvocationIdentity,
        ):
            raise TypeError("verified_invocation 必须来自认证搜索边界")

        config = SearchProviderRuntime.get_global_config()
        runtime_provider = SearchProviderRuntime.resolve_provider(provider_key or config.default_provider_key)
        if not runtime_provider.api_key:
            raise SearchProviderError(
                f"搜索提供商 {runtime_provider.provider_key} 未配置 API Key",
                provider_key=runtime_provider.provider_key,
                code="search_provider_api_key_missing",
            )

        normalized_count = cls._normalize_count(count or config.default_count or DEFAULT_SEARCH_COUNT)
        normalized_summary = config.default_summary_enabled if summary is None else bool(summary)
        normalized_freshness = (freshness or config.default_freshness or DEFAULT_SEARCH_FRESHNESS).strip()

        include = cls._join_domains(include_domains)
        exclude = cls._join_domains(exclude_domains)
        effective_request = SearchRequest(
            query=normalized_query,
            count=normalized_count,
            summary=normalized_summary,
            freshness=normalized_freshness,
            include=include,
            exclude=exclude,
        )
        fingerprint = (
            build_search_request_fingerprint(effective_request)
            if verified_invocation is not None
            else None
        )
        if charge_billing:
            cls._billing_precheck(
                organization_id=organization_id,
                user_id=user_id,
                provider_key=runtime_provider.provider_key,
                reservation_backed=verified_invocation is not None,
            )

        reservation = None
        if charge_billing and verified_invocation is not None:
            reservation, replay = cls._prepare_reserved_execution(
                organization_id=organization_id or "",
                user_id=user_id or "",
                thread_id=thread_id or "",
                biz_type=biz_type,
                provider_key=runtime_provider.provider_key,
                verified_invocation=verified_invocation,
                fingerprint=fingerprint,
                normalized_query=normalized_query,
            )
            if replay is not None:
                return replay

        if (
            reservation is not None
            and reservation.provider_key != runtime_provider.provider_key
        ):
            try:
                runtime_provider = SearchProviderRuntime.resolve_provider(
                    reservation.provider_key
                )
                if not runtime_provider.api_key:
                    raise SearchProviderError(
                        f"搜索提供商 {runtime_provider.provider_key} 未配置 API Key",
                        provider_key=runtime_provider.provider_key,
                        code="search_provider_api_key_missing",
                    )
            except SearchProviderError as exc:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.record_provider_failure(
                    reservation.id,
                    error_code=exc.code,
                )
                raise

        try:
            provider = SearchProviderRuntime.create_provider_client(
                runtime_provider,
                single_attempt=reservation is not None,
            )
        except Exception as exc:
            if reservation is not None:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.record_provider_failure(
                    reservation.id,
                    error_code="search_provider_client_init_failed",
                )
            raise SearchProviderError(
                f"搜索 Provider 初始化失败: {exc}",
                provider_key=runtime_provider.provider_key,
                code="search_provider_client_init_failed",
            ) from exc
        try:
            response = provider.search(effective_request)
        except SearchProviderOutcomeUnknown as exc:
            if reservation is not None:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.mark_unknown(
                    reservation.id,
                    reason=exc.code,
                )
            raise
        except SearchProviderError as exc:
            if reservation is not None:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.record_provider_failure(
                    reservation.id,
                    error_code=exc.code,
                )
            raise
        except Exception as exc:
            if reservation is not None:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.mark_unknown(
                    reservation.id,
                    reason=type(exc).__name__,
                )
            raise

        if (
            charge_billing
            and not response.web_pages
            and not response.images
            and not response.videos
        ):
            if reservation is not None:
                from apps.services.billing.services.search_reservation_service import (
                    SearchBillingReservationService,
                )

                SearchBillingReservationService.record_provider_failure(
                    reservation.id,
                    error_code="search_empty_result",
                )
            raise SearchProviderError(
                "搜索 Provider 未返回有效业务结果",
                provider_key=runtime_provider.provider_key,
                code="search_empty_result",
            )
        if verified_invocation is not None:
            response.invocation_context = SearchInvocationContext(
                logical_search_invocation_id=(
                    verified_invocation.logical_search_invocation_id
                ),
                agent_run_id=verified_invocation.agent_run_id,
                fingerprint_version=fingerprint.fingerprint_version,
                meter_key=fingerprint.meter_key,
                query_sha256=fingerprint.query_sha256,
                request_fingerprint=fingerprint.request_fingerprint,
            )

        if reservation is not None:
            response.billing_result = cls._settle_reserved_response(
                reservation_id=reservation.id,
                response=response,
            )
        elif charge_billing:
            response.billing_result = cls._charge_request(
                result=response,
                organization_id=organization_id or "",
                user_id=user_id or "",
                thread_id=thread_id or "",
                biz_type=biz_type,
            )
        return response

    # 预检层 → search 错误码映射；均含 "billing"/"disabled"，search API 统一映射 402。
    _BILLING_BLOCK_CODES = {
        "guard": "search_billing_blocked",
        "service_guard": "search_service_disabled",
        "budget": "search_billing_budget_exceeded",
        "member_budget": "search_billing_member_budget",
        "balance": "search_billing_insufficient_balance",
    }

    @classmethod
    def _billing_precheck(
        cls,
        *,
        organization_id: str | None,
        user_id: str | None,
        provider_key: str,
        reservation_backed: bool = False,
    ) -> None:
        """付费搜索调用前的统一五层计费预检（fail-closed）。

        E1：搜索此前仅检查 Guard/ServiceGuard，缺月度预算 / 余额 /
        成员预算预检，且无 organization_id 时整段跳过——导致余额为 0 也能无限发起
        付费搜索、烧共享搜索渠道 key。改为：无可计费 organization 直接拒绝；
        有则在调用 provider 之前跑统一五层预检，任一层阻断即拒绝。
        """
        if not organization_id:
            raise SearchProviderError(
                "联网搜索需要可计费的组织上下文",
                provider_key=provider_key,
                code="search_billing_organization_required",
            )

        from apps.services.billing.services.billing_precheck import (
            LAYER_BALANCE,
            billing_precheck,
        )

        user_role = None
        if user_id:
            try:
                from apps.services.billing.services.member_budget_service import MemberBudgetService
                user_role = MemberBudgetService.resolve_user_role(organization_id, user_id)
            except Exception:
                user_role = None

        result = billing_precheck(
            organization_id,
            user_id or "",
            service_key=SEARCH_SERVICE_KEY,
            context="search.web",
            user_role=user_role,
            skip_layers=(frozenset({LAYER_BALANCE}) if reservation_backed else frozenset()),
        )
        if result.blocked:
            raise SearchProviderError(
                result.reason or "联网搜索因计费限制被拦截",
                provider_key=provider_key,
                code=cls._BILLING_BLOCK_CODES.get(result.layer, "search_billing_blocked"),
            )

    @classmethod
    def _prepare_reserved_execution(
        cls,
        *,
        organization_id: str,
        user_id: str,
        thread_id: str,
        biz_type: str,
        provider_key: str,
        verified_invocation: VerifiedSearchInvocationIdentity,
        fingerprint,
        normalized_query: str,
    ):
        from apps.services.billing.models import BillingReservation
        from apps.services.billing.services.search_reservation_service import (
            SearchBillingReservationService,
            SearchReservationConflict,
            SearchReservationInsufficientFunds,
        )

        try:
            reservation = SearchBillingReservationService.reserve(
                organization_id=organization_id,
                user_id=user_id,
                logical_search_invocation_id=(
                    verified_invocation.logical_search_invocation_id
                ),
                request_fingerprint=fingerprint.request_fingerprint,
                fingerprint_version=fingerprint.fingerprint_version,
                meter_key=fingerprint.meter_key,
                provider_key=provider_key,
                quantity=Decimal("1"),
                biz_type=biz_type,
                thread_id=thread_id,
            )
        except SearchReservationConflict as exc:
            raise SearchProviderError(
                str(exc),
                provider_key=provider_key,
                status_code=409,
                code="idempotency_key_conflict",
            ) from exc
        except SearchReservationInsufficientFunds as exc:
            raise SearchProviderError(
                "组织可用点券不足",
                provider_key=provider_key,
                status_code=402,
                code="search_billing_insufficient_balance",
            ) from exc

        if reservation.status == BillingReservation.Status.COMMITTED:
            return reservation, cls._restore_reserved_response(
                reservation,
                normalized_query=normalized_query,
            )
        if reservation.status == BillingReservation.Status.SETTLEMENT_PENDING:
            try:
                settlement = SearchBillingReservationService.settle(reservation.id)
            except Exception as exc:
                raise SearchProviderError(
                    "搜索结果已生成，计费结算等待重试",
                    provider_key=provider_key,
                    status_code=503,
                    code="search_billing_settlement_pending",
                ) from exc
            reservation.refresh_from_db()
            replay = cls._restore_reserved_response(
                reservation,
                normalized_query=normalized_query,
            )
            replay.billing_result = cls._billing_result_from_settlement(settlement)
            return reservation, replay

        reservation, _attempt, acquired = (
            SearchBillingReservationService.acquire_execution(reservation.id)
        )
        if not acquired:
            status_code = 409
            code = "search_invocation_in_progress"
            message = "同一联网搜索正在执行或等待人工核查"
            if reservation.status in {
                BillingReservation.Status.RELEASED,
                BillingReservation.Status.EXPIRED,
            }:
                code = "search_invocation_closed"
                message = "该联网搜索调用已关闭，不能重复执行"
            raise SearchProviderError(
                message,
                provider_key=provider_key,
                status_code=status_code,
                code=code,
            )
        return reservation, None

    @classmethod
    def _settle_reserved_response(
        cls,
        *,
        reservation_id,
        response: SearchResponse,
    ) -> dict[str, str | bool]:
        from apps.services.billing.services.search_reservation_service import (
            SearchBillingReservationService,
        )

        SearchBillingReservationService.record_provider_success(
            reservation_id,
            provider_request_id=response.provider_log_id or response.request_id,
            result_reference=response.request_id,
            result_metadata={"response_snapshot": cls._safe_response_snapshot(response)},
        )
        try:
            settlement = SearchBillingReservationService.settle(reservation_id)
        except Exception as exc:
            logger.exception(
                "[SearchService] provider succeeded but settlement is pending: reservation=%s",
                reservation_id,
            )
            raise SearchProviderError(
                "搜索结果已生成，计费结算等待重试",
                provider_key=response.provider_key,
                status_code=503,
                code="search_billing_settlement_pending",
            ) from exc
        return cls._billing_result_from_settlement(settlement)

    @staticmethod
    def _billing_result_from_settlement(settlement) -> dict[str, str | bool]:
        event = settlement.get("event")
        return {
            "charged": bool(event),
            "event_id": str(event.id) if event is not None else "",
            "amount": str(event.amount) if event is not None else "0",
            "currency": "CREDITS",
        }

    @staticmethod
    def _safe_response_snapshot(response: SearchResponse) -> dict:
        """仅保存已返回给用户的结果，不保存 query、raw 或 Provider 凭证。"""
        return {
            "provider_key": response.provider_key,
            "provider_type": response.provider_type,
            "provider_display_name": response.provider_display_name,
            "request_id": response.request_id,
            "count": response.count,
            "summary_enabled": response.summary_enabled,
            "freshness": response.freshness,
            "total_estimated_matches": response.total_estimated_matches,
            "web_pages": [asdict(item) for item in response.web_pages],
            "images": [asdict(item) for item in response.images],
            "videos": [asdict(item) for item in response.videos],
            "provider_log_id": response.provider_log_id,
            "latency_ms": response.latency_ms,
        }

    @staticmethod
    def _restore_reserved_response(reservation, *, normalized_query: str) -> SearchResponse:
        from apps.services.billing.models import BillingUsageEvent

        snapshot = dict((reservation.result_metadata or {}).get("response_snapshot") or {})
        if not snapshot:
            raise SearchProviderError(
                "搜索结果引用缺失，需要人工核查",
                provider_key=reservation.provider_key,
                status_code=503,
                code="search_result_replay_unavailable",
            )
        response = SearchResponse(
            provider_key=str(snapshot.get("provider_key") or reservation.provider_key),
            provider_type=str(snapshot.get("provider_type") or ""),
            provider_display_name=str(snapshot.get("provider_display_name") or ""),
            request_id=str(snapshot.get("request_id") or reservation.result_reference),
            query=normalized_query,
            count=int(snapshot.get("count") or reservation.quantity or 1),
            summary_enabled=bool(snapshot.get("summary_enabled")),
            freshness=str(snapshot.get("freshness") or ""),
            total_estimated_matches=int(snapshot.get("total_estimated_matches") or 0),
            web_pages=[SearchWebPageResult(**item) for item in snapshot.get("web_pages", [])],
            images=[SearchImageResult(**item) for item in snapshot.get("images", [])],
            videos=[SearchVideoResult(**item) for item in snapshot.get("videos", [])],
            provider_log_id=str(snapshot.get("provider_log_id") or ""),
            latency_ms=snapshot.get("latency_ms"),
        )
        event = BillingUsageEvent.objects.filter(
            idempotency_key=f"search-reservation:{reservation.id}"
        ).first()
        response.billing_result = {
            "charged": event is not None,
            "event_id": str(event.id) if event is not None else "",
            "amount": str(event.amount) if event is not None else "0",
            "currency": "CREDITS",
        }
        return response

    @classmethod
    def format_for_llm(cls, result: SearchResponse) -> str:
        if not result.web_pages and not result.images and not result.videos:
            return f"未找到与“{result.query}”相关的搜索结果。"

        lines = [
            f"搜索结果（{result.provider_display_name}）",
            f"查询：{result.query}",
        ]
        if result.total_estimated_matches:
            lines.append(f"网页预估总量：{result.total_estimated_matches}")
        if result.latency_ms is not None:
            lines.append(f"耗时：{result.latency_ms}ms")
        lines.append("")

        for index, item in enumerate(result.web_pages[: result.count], start=1):
            lines.append(f"{index}. [{item.name}]({item.url})")
            meta_parts = [part for part in [item.site_name, item.date_published] if part]
            if meta_parts:
                lines.append(f"   来源：{' | '.join(meta_parts)}")
            snippet = item.summary or item.snippet
            if snippet:
                lines.append(f"   摘要：{cls._trim_text(snippet, 260)}")

        if result.images:
            lines.append("")
            lines.append(f"图片结果：{min(len(result.images), 5)} 条")
            for image in result.images[:5]:
                label = image.name or image.host_page_url or image.content_url
                size = ""
                if image.width and image.height:
                    size = f" ({image.width}x{image.height})"
                lines.append(f"- [{label}]({image.content_url}){size}")

        if result.videos:
            lines.append("")
            lines.append(f"视频结果：{min(len(result.videos), 5)} 条")
            for video in result.videos[:5]:
                label = video.name or video.host_page_url or video.content_url
                duration = f" | 时长：{video.duration}" if video.duration else ""
                lines.append(f"- [{label}]({video.host_page_url or video.content_url}){duration}")

        return "\n".join(lines)

    @staticmethod
    def _normalize_count(count: int) -> int:
        return max(1, min(int(count or DEFAULT_SEARCH_COUNT), 50))

    @staticmethod
    def _join_domains(domains: Iterable[str] | None) -> str:
        if not domains:
            return ""
        normalized = [str(domain).strip() for domain in domains if str(domain).strip()]
        return ",".join(normalized[:100])

    @staticmethod
    def _trim_text(text: str, max_length: int) -> str:
        normalized = " ".join(str(text).split())
        if len(normalized) <= max_length:
            return normalized
        return normalized[: max_length - 1].rstrip() + "…"

    @classmethod
    def _charge_request(
        cls,
        *,
        result: SearchResponse,
        organization_id: str,
        user_id: str,
        thread_id: str,
        biz_type: str,
    ) -> dict[str, str | bool]:
        from apps.services.billing.services import BillingUsageService, MeterPricingService
        from apps.services.billing.services.degradation_tracker import track_billing_degradation

        try:
            unit_price = MeterPricingService.get_unit_price(
                SEARCH_BILLING_METER_KEY,
                organization_id=organization_id or None,
                provider_key=result.provider_key,
                default_price=Decimal("0"),
            ) or Decimal("0")
            amount = unit_price
            event = BillingUsageService.record_event(
                organization_id=organization_id,
                user_id=user_id,
                meter_key=SEARCH_BILLING_METER_KEY,
                quantity=Decimal("1"),
                unit="request",
                unit_price=unit_price,
                amount=amount,
                currency="CREDITS",
                provider_key=result.provider_key,
                biz_type=biz_type,
                biz_id=result.request_id,
                charge_status="pending",
                metadata={
                    "query_sha256": hashlib.sha256(result.query.encode("utf-8")).hexdigest(),
                    "thread_id": thread_id,
                    "result_count": len(result.web_pages),
                    "image_count": len(result.images),
                    "video_count": len(result.videos),
                    "freshness": result.freshness,
                    "summary_enabled": result.summary_enabled,
                    "requested_count": result.count,
                    "provider_log_id": result.provider_log_id,
                },
            )
            return {
                "charged": True,
                "event_id": str(event.id),
                "amount": str(amount),
                "currency": "CREDITS",
            }
        except Exception as exc:
            logger.warning("[SearchService] billing record failed: %s", exc, exc_info=True)
            track_billing_degradation(
                meter_key="search.billing",
                organization_id=organization_id or "",
                biz_type=biz_type,
                error=str(exc),
            )
            return {
                "charged": False,
                "error": str(exc),
            }
