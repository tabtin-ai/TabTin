"""A2 三视角 Review 修复：补 ``workteam_id`` / ``domain`` / ``verb`` 顶层提级 + index。

A2 启动包初版（0002）受 PRD §5.1 第 5 项伪代码字段集驱动，**漏掉**：
- **P0**：``workteam_id`` 顶层字段（PRD §5.5「授权数据 PII 隔离」要求所有
  admin 查询 API 按 ``request.user.workteam_id == row.workteam_id`` 过滤；
  缺顶层 ``workteam_id`` → AdminDash E3 必须经 thread/user 反查跨库，违反
  PRD §5.5 + N10 「避免 JSONB 解析」精神）。
- **P1**：``domain`` / ``verb`` 顶层提级（N10 决策延伸 — AdminDash 主统计维度
  「按 domain / verb 维度」直接走 index，无需 ``spec_json->>'domain'``）。
- **P1**：``inner_binary`` 加 ``db_index``（落地总控 § E3 启动包要求按 inner_binary 过滤）。

复合 index 增补：
- ``(workteam_id, created_at)`` — 租户维度审计时间线（AdminDash 默认按 admin
  自己 workteam 过滤 + 时间排序）。
- ``(workteam_id, risk_level)`` — 「我们 workteam 这周 review 路径多少条」。

迁移命令：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings \\
        python manage.py migrate agent_engine --database=postgresql

向后兼容：``workteam_id`` / ``domain`` / ``verb`` 三个新字段对历史数据均允许 NULL
或空字符串，不需要 backfill；新写入由 ``audit.py`` 的 ``emit_cli_audit_event``
统一注入。
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0002_cli_audit_event"),
    ]

    operations = [
        # ── 新增字段 ───────────────────────────────────────────────
        migrations.AddField(
            model_name="cliauditevent",
            name="workteam_id",
            field=models.UUIDField(
                null=True,
                blank=True,
                help_text=(
                    "租户 ID（跨库软引用 tabtinspace.Workteam.id）。"
                    "PRD §5.5 「授权数据 PII 隔离」硬性要求：所有 admin 查询 API "
                    "必须按 request.user.workteam_id == row.workteam_id 过滤，"
                    "因此审计行必须含 workteam_id 一等字段，"
                    "避免 admin 通过 thread/user 反查跨库"
                ),
            ),
        ),
        migrations.AddField(
            model_name="cliauditevent",
            name="domain",
            field=models.CharField(
                max_length=64,
                # 历史 0002 数据无 domain，给空字符串默认值
                default="",
                db_index=True,
                help_text=(
                    "spec.domain 顶层化（如 'im' / 'vc' / 'table'）。"
                    "AdminDash 「按 domain 域统计」直接走 index，"
                    "无需 spec_json->>'domain'"
                ),
            ),
            # 不需要 preserve_default：domain 字段后续应由 audit.py 写入实际值
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="cliauditevent",
            name="verb",
            field=models.CharField(
                max_length=64,
                default="",
                db_index=True,
                help_text=(
                    "spec.verb 顶层化（如 'send' / 'delete' / 'create'）。"
                    "AdminDash 「本周 delete 操作 TOP 10」走 index"
                ),
            ),
            preserve_default=False,
        ),
        # ── inner_binary 加 db_index（P1 修复）────────────────────
        migrations.AlterField(
            model_name="cliauditevent",
            name="inner_binary",
            field=models.CharField(
                max_length=64,
                null=True,
                blank=True,
                db_index=True,
                help_text=(
                    "fork 子进程实际 binary（顶层入口与子进程 binary 不同的场景）；"
                    "非 fork 场景为 NULL；K7 决策"
                ),
            ),
        ),
        # ── binary / hitl_user_decision help_text 同步刷新（不改 schema）────
        migrations.AlterField(
            model_name="cliauditevent",
            name="binary",
            field=models.CharField(
                max_length=64,
                db_index=True,
                help_text=(
                    "用户调用入口可执行（K7：永远是用户最外层敲的 binary，"
                    "如 'tabtin' / 第三方 CLI 直跑场景）。"
                    "AdminDash 主审计 SQL `WHERE binary IN (...)` 走该 index。"
                    "通过 emit_cli_audit_event 的 entry_binary 参数显式传入；"
                    "未传时 fallback 到 spec.binary"
                ),
            ),
        ),
        migrations.AlterField(
            model_name="cliauditevent",
            name="hitl_user_decision",
            field=models.CharField(
                max_length=16,
                null=True,
                blank=True,
                help_text=(
                    "HITL 路径最终结果：allow / deny / timeout（PRD §5.1 第 6 项）；"
                    "allow / deny 是用户主动选择，timeout 是用户超时未响应（A4 注入）。"
                    "review 路径完成后必填；非 review 路径保持 NULL"
                ),
            ),
        ),
        # ── 复合 index 增补 ────────────────────────────────────────
        migrations.AddIndex(
            model_name="cliauditevent",
            index=models.Index(
                fields=["workteam_id", "created_at"],
                name="idx_cliaudit_wt_created",
            ),
        ),
        migrations.AddIndex(
            model_name="cliauditevent",
            index=models.Index(
                fields=["workteam_id", "risk_level"],
                name="idx_cliaudit_wt_risk",
            ),
        ),
    ]
