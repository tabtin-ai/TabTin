"""
Skills Celery 异步任务

将耗时的 AgentSync 操作从请求路径中移出，避免阻塞 upload_local_skills_index API。
"""

import logging
from typing import Any, Dict, List

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    name="skills.sync_local_agents",
    max_retries=2,
    default_retry_delay=5,
    acks_late=True,
)
def sync_local_agents_task(self, *, space_id: str, skills: List[Dict[str, Any]]):
    """异步同步本地 Skill 中的 Agent 定义到 SubAgentTemplate。"""
    try:
        from apps.skills.services.agent_sync_service import AgentSyncService

        AgentSyncService.sync_all_local_agents(
            space_id=space_id,
            skills=skills,
        )
        logger.info(
            "[skills.tasks] sync_local_agents completed (space=%s, skills=%d)",
            space_id,
            len(skills),
        )
    except Exception as exc:
        logger.warning(
            "[skills.tasks] sync_local_agents failed (space=%s), retry=%d/%d",
            space_id,
            self.request.retries,
            self.max_retries,
            exc_info=True,
        )
        raise self.retry(exc=exc)
