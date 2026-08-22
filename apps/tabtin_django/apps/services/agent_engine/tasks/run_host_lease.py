"""Run Host lease 周期收敛。"""

from celery import shared_task

from apps.services.agent_engine.services.run_host_lease_service import (
    RunHostLeaseService,
)


@shared_task(ignore_result=True, time_limit=25, soft_time_limit=20)
def sweep_expired_run_host_leases():
    expired = RunHostLeaseService.expire_due(limit=100)
    return {"expired_run_ids": expired}


RUN_HOST_LEASE_BEAT_SCHEDULE = {
    "agent-engine-sweep-expired-run-host-leases": {
        "task": (
            "apps.services.agent_engine.tasks.run_host_lease."
            "sweep_expired_run_host_leases"
        ),
        "schedule": 15.0,
        "options": {"queue": "default"},
    },
}
