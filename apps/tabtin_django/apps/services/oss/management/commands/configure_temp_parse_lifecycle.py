"""
File Pipeline W3 — 配置 OSS bucket 的 `temp-parse/` 前缀 lifecycle policy。

业务背景：
  W3 临时通道（`POST /services/oss/temp-parse-presign` + `POST /services/docparse/
  parse-sync-temp`）让 Agent `read_file('./foo.pptx')` 能拿到 PPT 文本——客户端
  把 PPTX 直传到 OSS `temp-parse/` 前缀，后端同步解析后**主动删除**对象。

  本 lifecycle policy 是**defense-in-depth 兜底**——主防线是 parse-sync 完成
  后立即调 `oss_service.delete_file()`；如果 parse-sync 因为进程崩 / 网络断
  等极端情况没删成，bucket 端 lifecycle 兜底过期清理。

  T4 决策：临时 OSS TTL 1h。
  阿里云 OSS lifecycle 最小粒度是 **1 天**（`Days` 字段），所以 bucket 端
  实际配置 1 day expiration——主清理（parse-sync 主动 delete）即时执行
  让用户感知到的 TTL 是 1h，bucket lifecycle 兜底 1 day 是工程现实。

用法：
    # 查看当前 lifecycle 规则（dry-run）
    python manage.py configure_temp_parse_lifecycle --dry-run

    # 应用 / 更新规则
    python manage.py configure_temp_parse_lifecycle --apply

    # 移除规则（仅运维使用，慎用）
    python manage.py configure_temp_parse_lifecycle --remove

幂等：apply 多次结果一致（rule_id 'tabtin-temp-parse-cleanup' 唯一）。

注意：本命令仅适用于阿里云 OSS。其他后端（如本地文件 / S3）的 lifecycle
配置由各自后端独立管理，本命令不强制要求所有后端实现。
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError


# 与 `apps.services.oss.temp_parse_api.TEMP_PARSE_OBJECT_KEY_PREFIX` 同源
# （这里 import 会触发 ninja Router 加载，所以用裸字符串字面值——通过测试钉死
# 一致性，避免运维脚本依赖 web router 才能跑）
TEMP_PARSE_PREFIX = "temp-parse/"
LIFECYCLE_RULE_ID = "tabtin-temp-parse-cleanup"
EXPIRATION_DAYS = 1  # OSS lifecycle 最小粒度（>1h 主防线已即时清理，这里是兜底）


class Command(BaseCommand):
    help = "配置 OSS bucket `temp-parse/` 前缀的 lifecycle policy（W3 临时通道兜底清理）"

    def add_arguments(self, parser):
        action = parser.add_mutually_exclusive_group(required=True)
        action.add_argument("--dry-run", action="store_true", help="查看现有规则，不变更")
        action.add_argument("--apply", action="store_true", help="新增 / 更新 lifecycle 规则")
        action.add_argument("--remove", action="store_true", help="移除 tabtin-temp-parse-cleanup 规则")

    def handle(self, *args, **options):
        from apps.services.oss.services.factory import get_oss_service

        oss_service = get_oss_service()
        bucket = getattr(oss_service, "bucket", None)
        if bucket is None:
            raise CommandError(
                "当前 OSS service 没有 bucket 句柄（可能是 LocalFileSystem 后端，无需 lifecycle）"
            )

        if options.get("dry_run"):
            self._show_existing(bucket)
            return

        if options.get("apply"):
            self._apply_rule(bucket)
            return

        if options.get("remove"):
            self._remove_rule(bucket)
            return

    # ------------------------------------------------------------------
    # apply / remove / dry-run
    # ------------------------------------------------------------------

    def _show_existing(self, bucket) -> None:
        try:
            import oss2  # type: ignore
            result = bucket.get_bucket_lifecycle()
            self.stdout.write(self.style.SUCCESS("当前 bucket lifecycle 规则:"))
            for rule in result.rules:
                marker = "  ← TabTin 临时通道兜底" if rule.id == LIFECYCLE_RULE_ID else ""
                expiration = (
                    f"days={rule.expiration.days}" if rule.expiration and rule.expiration.days
                    else "无 expiration"
                )
                self.stdout.write(
                    f"  - id={rule.id} prefix={rule.prefix!r} status={rule.status} "
                    f"{expiration}{marker}"
                )
        except Exception as exc:
            if "NoSuchLifecycle" in type(exc).__name__ or "NoSuchLifecycle" in str(exc):
                self.stdout.write(self.style.WARNING("Bucket 当前未配置任何 lifecycle 规则"))
                return
            raise CommandError(f"查询 lifecycle 失败: {exc}")

    def _apply_rule(self, bucket) -> None:
        import oss2  # type: ignore
        from oss2.models import BucketLifecycle, LifecycleRule, LifecycleExpiration

        # 先 read 现有规则，把 TabTin 那条替换 / 新增
        existing_rules = []
        try:
            existing_rules = bucket.get_bucket_lifecycle().rules
        except Exception as exc:
            if "NoSuchLifecycle" not in type(exc).__name__ and "NoSuchLifecycle" not in str(exc):
                raise CommandError(f"读取现有 lifecycle 失败: {exc}")

        # 移除旧的 TabTin 规则（同 id 替换）
        new_rules = [r for r in existing_rules if r.id != LIFECYCLE_RULE_ID]

        new_rules.append(
            LifecycleRule(
                LIFECYCLE_RULE_ID,
                TEMP_PARSE_PREFIX,
                status=LifecycleRule.ENABLED,
                expiration=LifecycleExpiration(days=EXPIRATION_DAYS),
            )
        )

        bucket.put_bucket_lifecycle(BucketLifecycle(new_rules))
        self.stdout.write(self.style.SUCCESS(
            f"已配置 lifecycle 规则: id={LIFECYCLE_RULE_ID} prefix={TEMP_PARSE_PREFIX!r} "
            f"expiration_days={EXPIRATION_DAYS}"
        ))
        self.stdout.write(
            "（W3 主防线：parse-sync-temp 完成后即时 delete；本 lifecycle 仅为 defense-in-depth 兜底）"
        )

    def _remove_rule(self, bucket) -> None:
        import oss2  # type: ignore
        from oss2.models import BucketLifecycle

        try:
            existing_rules = bucket.get_bucket_lifecycle().rules
        except Exception as exc:
            if "NoSuchLifecycle" in type(exc).__name__ or "NoSuchLifecycle" in str(exc):
                self.stdout.write(self.style.WARNING("Bucket 已无 lifecycle 规则，无需移除"))
                return
            raise CommandError(f"读取现有 lifecycle 失败: {exc}")

        new_rules = [r for r in existing_rules if r.id != LIFECYCLE_RULE_ID]
        if len(new_rules) == len(existing_rules):
            self.stdout.write(self.style.WARNING(f"未找到 id={LIFECYCLE_RULE_ID} 规则，无需移除"))
            return

        if not new_rules:
            bucket.delete_bucket_lifecycle()
            self.stdout.write(self.style.SUCCESS(
                f"已移除 lifecycle 规则 {LIFECYCLE_RULE_ID}（bucket 现无任何 lifecycle）"
            ))
            return

        bucket.put_bucket_lifecycle(BucketLifecycle(new_rules))
        self.stdout.write(self.style.SUCCESS(f"已移除 lifecycle 规则 {LIFECYCLE_RULE_ID}"))
