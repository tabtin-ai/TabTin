"""#2574：存量 cron Tracker 补齐 trigger_config.timezone，并重算 next_run_at。

历史默认缺 timezone 时按 UTC 解析墙钟，东八区「每天 09:00」实际 17:00。
本迁移：
1. 对 trigger_type=cron 且缺/空 timezone 的行写入 settings.TIME_ZONE
2. 对 active/paused 行按新时区重算 next_run_at（否则要等下次跑完才纠正）

回滚为 noop：无法区分「迁移补上的」与「用户显式写的」同一 IANA 名。
"""

from __future__ import annotations

from django.conf import settings
from django.db import migrations


def _forward_backfill_cron_timezone(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != "postgresql":
        return

    db_alias = connection.alias
    Tracker = apps.get_model("tracker", "Tracker")
    default_tz = (getattr(settings, "TIME_ZONE", None) or "Asia/Shanghai").strip() or "Asia/Shanghai"

    # 用当前实现重算，避免在 migration 内复制 croniter 逻辑。
    from apps.tracker.utils import compute_next_run_at

    qs = Tracker.objects.using(db_alias).filter(trigger_type="cron")
    for tracker in qs.iterator():
        cfg = tracker.trigger_config if isinstance(tracker.trigger_config, dict) else {}
        cfg = dict(cfg)
        tz = cfg.get("timezone")
        if isinstance(tz, str) and tz.strip():
            continue

        cfg["timezone"] = default_tz
        update_fields = ["trigger_config"]
        tracker.trigger_config = cfg

        if tracker.status in ("active", "paused"):
            tracker.next_run_at = compute_next_run_at("cron", cfg, fail_loud=False)
            update_fields.append("next_run_at")

        tracker.save(using=db_alias, update_fields=update_fields)


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0038_rename_tracker_worktea_367d8f_idx_tracker_organiz_6b1f4b_idx_and_more"),
    ]

    operations = [
        migrations.RunPython(
            _forward_backfill_cron_timezone,
            migrations.RunPython.noop,
        ),
    ]
