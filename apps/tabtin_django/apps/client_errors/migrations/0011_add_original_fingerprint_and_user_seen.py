# Generated for Wave 6 Round 2: 错误监控收敛
#
# 1. P1-2: ``ClientErrorEvent.original_fingerprint`` —— merge 操作可逆契约信号。
#    merge 时 source events 的当前 fingerprint 备份到本字段（仅在为空时写，
#    后续 merge 不覆盖），让 admindash 能展示"已并入 target group, 原 fingerprint=xxx"
#    + 运维能根据备份重建原 group。
#
# 2. P1-4: ``ClientErrorGroupUserSeen`` / ``ClientErrorReleaseUserSeen`` ——
#    user_count TOCTOU race 的兜底表。本 migration 创建表 + state-only 约束声明；
#    DB 物理 partial unique 索引由 0012 用 CREATE INDEX CONCURRENTLY 建立，参考
#    Wave 2 migration 0009 的纪律——表新建瞬间 size=0，CONCURRENTLY 没必要，
#    但保留拆分可让"约束创建瞬间"与"表创建瞬间"独立观察、未来类似新表表更
#    一致。
#
# AddField original_fingerprint default="" → PG 11+ 走 fast path（O(1) 元数据），
# 不重写表，长期累积的 client_error_event 表也能秒级完成。

import django.utils.timezone
from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ('client_errors', '0010_add_fingerprint_algo_version'),
    ]

    operations = [
        # ── P1-2: original_fingerprint 字段 ──
        migrations.AddField(
            model_name='clienterrorevent',
            name='original_fingerprint',
            field=models.CharField(
                blank=True,
                default='',
                max_length=64,
                verbose_name='原始指纹（merge 前备份）',
            ),
        ),

        # ── P1-4: 两张 UserSeen 表 ──
        migrations.CreateModel(
            name='ClientErrorGroupUserSeen',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_id', models.CharField(max_length=64, verbose_name='用户ID')),
                ('first_seen', models.DateTimeField(default=django.utils.timezone.now, verbose_name='首次见到')),
                ('group', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='seen_users',
                    to='client_errors.clienterrorgroup',
                )),
            ],
            options={'db_table': 'client_error_group_user_seen'},
        ),
        migrations.CreateModel(
            name='ClientErrorReleaseUserSeen',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_id', models.CharField(max_length=64, verbose_name='用户ID')),
                ('first_seen', models.DateTimeField(default=django.utils.timezone.now, verbose_name='首次见到')),
                ('release', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='seen_users',
                    to='client_errors.release',
                )),
            ],
            options={'db_table': 'client_error_release_user_seen'},
        ),
        # 约束声明留在 state——0012 用 RunSQL CREATE INDEX CONCURRENTLY 实际建立，
        # SeparateDatabaseAndState 让后续 makemigrations diff 不会重复尝试创建。
    ]
