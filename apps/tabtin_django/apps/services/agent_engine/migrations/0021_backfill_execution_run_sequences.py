from django.db import migrations


def backfill_execution_run_sequences(apps, schema_editor):
    ExecutionRun = apps.get_model("agent_engine", "ExecutionRun")
    # 历史调用方曾用空串表达“无会话”。唯一约束把空串视为同一 session，
    # 必须先归一成 NULL（PostgreSQL UNIQUE 允许多条 NULL）。
    ExecutionRun.objects.filter(session_id="").update(session_id=None)
    ExecutionRun.objects.filter(status="error").update(status="failed")
    counters = {}
    pending = []
    for run in (
        ExecutionRun.objects.exclude(session_id__isnull=True)
        .order_by("session_id", "started_at", "run_id")
        .iterator(chunk_size=1000)
    ):
        next_sequence = counters.get(run.session_id, 0) + 1
        counters[run.session_id] = next_sequence
        run.sequence = next_sequence
        pending.append(run)
        if len(pending) >= 1000:
            ExecutionRun.objects.bulk_update(pending, ["sequence"])
            pending = []
    if pending:
        ExecutionRun.objects.bulk_update(pending, ["sequence"])


class Migration(migrations.Migration):
    dependencies = [
        ("agent_engine", "0020_session_run_projection"),
    ]

    operations = [
        migrations.RunPython(
            backfill_execution_run_sequences,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
