"""应急中心 API — v0.1 AdminDash

宪法 v0.1 §07 §2.4 + §5.9 应急中心 2 个端点：
- GET /admin/incidents/error-stats     — 错误码 24h/7d 聚合
- GET /admin/incidents/circuit-breaks  — 当前生效的所有熔断列表
"""

import logging

from django.db.models import Count
from django.utils import timezone
from ninja import Router

from apps.i18n.response import success_response
from apps.users.auth.permissions import StaffAuth

from ..models import LLMProvider, LLMUsageFact

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Incidents"], auth=StaffAuth())


@router.get("/admin/incidents/error-stats")
def error_stats(request):
    now = timezone.now()
    cutoff_24h = now - timezone.timedelta(hours=24)
    cutoff_7d = now - timezone.timedelta(days=7)

    errors_7d = LLMUsageFact.objects.filter(
        status='failed',
        occurred_at__gte=cutoff_7d,
    ).exclude(error_code__isnull=True).exclude(error_code='')

    errors_24h = errors_7d.filter(occurred_at__gte=cutoff_24h)

    by_code_7d = dict(
        errors_7d.values_list('error_code').annotate(cnt=Count('id')).values_list('error_code', 'cnt')
    )
    by_code_24h = dict(
        errors_24h.values_list('error_code').annotate(cnt=Count('id')).values_list('error_code', 'cnt')
    )

    all_codes = set(by_code_7d.keys()) | set(by_code_24h.keys())

    result = {}
    for code in sorted(all_codes):
        top_scenes_qs = (
            errors_7d.filter(error_code=code)
            .values('scene_key')
            .annotate(cnt=Count('id'))
            .order_by('-cnt')[:5]
        )
        last_seen = errors_7d.filter(error_code=code).order_by('-occurred_at').values('occurred_at').first()

        result[code] = {
            "count_24h": by_code_24h.get(code, 0),
            "count_7d": by_code_7d.get(code, 0),
            "last_seen": last_seen['occurred_at'].isoformat() if last_seen and last_seen['occurred_at'] else None,
            "top_scenes": [
                {"scene_key": s["scene_key"], "count": s["cnt"]}
                for s in top_scenes_qs
            ],
        }

    return success_response(data={"errors_by_code": result})


@router.get("/admin/incidents/circuit-breaks")
def list_circuit_breaks(request):
    """v0.1 当前生效的所有熔断列表（宪法 §07 §5.9）。

    数据来源：LLMProvider.runtime_status='unhealthy' AND
              runtime_cooldown_until > now()

    返回字段对齐 AdminDash IncidentPage：
      - provider_id / display_name / provider_key
      - capability_domain / scope
      - runtime_status / cooldown_until / cooldown_multiplier
      - last_error（脱敏后的错误摘要，前端只展示前 500 字符）
    """
    now = timezone.now()
    qs = LLMProvider.objects.filter(
        runtime_status='unhealthy',
        runtime_cooldown_until__gt=now,
    ).order_by('-runtime_cooldown_until')

    items = []
    for p in qs:
        _caps = list(p.capability_domains or [])
        items.append({
            'provider_id': str(p.id),
            'display_name': p.display_name or p.name,
            'provider_key': p.provider_key,
            'capability_domains': _caps,
            # 兼容旧前端：返回首个 domain
            'capability_domain': _caps[0] if _caps else '',
            'scope': p.scope,
            'runtime_status': p.runtime_status,
            'cooldown_until': p.runtime_cooldown_until.isoformat()
                if p.runtime_cooldown_until else None,
            'cooldown_multiplier': p.runtime_cooldown_multiplier,
            'last_error': (p.health_last_error or '')[:500],
        })

    return success_response(data={
        'circuit_breaks': items,
        'total': len(items),
        'generated_at': now.isoformat(),
    })
