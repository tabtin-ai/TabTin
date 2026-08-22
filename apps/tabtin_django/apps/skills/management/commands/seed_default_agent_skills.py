"""#8726: 为全部（或指定）默认 Agent 幂等回填 platform + 已装 App skill。

容器部署曾因仓库根双 SSoT 导致 ``list_app_skills()=0``，默认小Tin 只挂 platform。
修好路径解析后，对存量默认 Agent 跑一次本命令补齐携带集。
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "幂等 seed 默认 Agent 的 platform + 已装 App skill（ 回填）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只探测 need_repair / expected 数量，不写库",
        )
        parser.add_argument(
            "--agent-id",
            type=str,
            default=None,
            help="只处理指定默认 Agent UUID",
        )
        parser.add_argument(
            "--organization-id",
            type=str,
            default=None,
            help="只处理指定组织下的默认 Agent",
        )

    def handle(self, *args, **options):
        from apps.agent.models import Agent
        from apps.skills.services.app_package_skills import clear_app_payloads_cache
        from apps.skills.services.default_agent_skill_seed import (
            _expected_default_skill_keys,
            default_agent_skills_need_repair,
            seed_default_agent_skills,
        )
        from apps.skills.services.registry_service import SkillsRegistryService

        dry_run = bool(options["dry_run"])
        agent_id = options.get("agent_id")
        organization_id = options.get("organization_id")

        # 同进程热修时清掉错误根路径下缓存的空 payloads
        clear_app_payloads_cache()

        app_n = len(SkillsRegistryService.list_app_skills())
        platform_n = len(SkillsRegistryService.list_platform_skills())
        self.stdout.write(f"registry: platform={platform_n} app={app_n}")
        if app_n == 0:
            self.stdout.write(
                self.style.WARNING(
                    "list_app_skills() 仍为 0——请先确认 TABTIN_REPO_ROOT / packages/apps 布局"
                )
            )

        qs = Agent.objects.filter(is_default=True, is_active=True)
        if agent_id:
            try:
                qs = qs.filter(id=UUID(str(agent_id)))
            except (TypeError, ValueError) as exc:
                raise CommandError(f"invalid --agent-id: {agent_id}") from exc
        if organization_id:
            try:
                qs = qs.filter(organization_id=UUID(str(organization_id)))
            except (TypeError, ValueError) as exc:
                raise CommandError(
                    f"invalid --organization-id: {organization_id}"
                ) from exc

        agents = list(qs.order_by("created_at"))
        self.stdout.write(f"default agents to process: {len(agents)}")

        seeded = 0
        unchanged = 0
        errors = 0
        for agent in agents:
            expected = _expected_default_skill_keys(agent)
            need = default_agent_skills_need_repair(agent)
            self.stdout.write(
                f"agent={agent.id} name={agent.name!r} org={agent.organization_id} "
                f"expected={len(expected)} need_repair={need}"
            )
            if dry_run:
                if need or len(expected) > 0:
                    seeded += 1
                else:
                    unchanged += 1
                continue

            user = SimpleNamespace(id=agent.owner_user_id)
            try:
                result = seed_default_agent_skills(agent, user)
            except Exception as exc:  # noqa: BLE001 — 单 Agent 失败不阻断整批
                errors += 1
                logger.exception(
                    "seed_default_agent_skills.command_failed agent=%s", agent.id
                )
                self.stdout.write(self.style.ERROR(f"  failed: {exc}"))
                continue

            attached = int(result.get("attached") or 0)
            skipped_n = int(result.get("skipped") or 0)
            err_list = result.get("errors") or []
            self.stdout.write(
                f"  seeded attached={attached} skipped={skipped_n} "
                f"errors={len(err_list)}"
            )
            if attached or need:
                seeded += 1
            else:
                unchanged += 1

        style = self.style.WARNING if dry_run else self.style.SUCCESS
        self.stdout.write(
            style(
                f"Done{' (dry-run)' if dry_run else ''}: "
                f"seeded={seeded} unchanged={unchanged} errors={errors}"
            )
        )
