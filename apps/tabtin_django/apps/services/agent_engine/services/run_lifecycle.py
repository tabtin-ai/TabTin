import logging

from apps.services.agent_engine.models import ExecutionRun
from apps.services.agent_engine.services.run_service import RunService

logger = logging.getLogger(__name__)


def cancel_agent_active_runs(agent_id: str, reason: str) -> int:
    """取消指定 Agent 的所有活跃 Run（通过 Redis cancel marker）。"""
    cancelled = 0
    try:
        active_runs = ExecutionRun.objects.filter(
            instance_id=agent_id,
            status__in=['running', 'cancelling'],
        )
        for run in active_runs:
            try:
                RunService.request_cancel(str(run.run_id), reason=reason)
                cancelled += 1
            except Exception:
                logger.warning(
                    "Failed to cancel run %s for agent %s",
                    run.run_id, agent_id, exc_info=True,
                )
    except Exception:
        logger.warning(
            "Failed to query active runs for agent %s",
            agent_id, exc_info=True,
        )
    return cancelled
