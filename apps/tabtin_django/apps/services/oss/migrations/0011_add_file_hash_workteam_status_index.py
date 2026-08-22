# P0 IDOR / 数据泄漏修复（PRD-presign-workteam-isolation-fix.md）：
# 秒传查询补 workteam_id 过滤后，原 file_hash 单列索引在多 workteam 数据规模下
# 选择率下降。新增 (file_hash, workteam_id, status) 复合索引保证 presign_upload /
# presign_upload_batch 的秒传查询走索引。原单列索引保留 — 跨 workteam 统计、
# 后台 hash 去重观察等场景仍依赖。
#
# 不加 unique constraint：不同 workteam 同 hash 应各存一份 FileRecord 是正确行为
# （独立计费、独立生命周期、独立审计），unique 反而会破坏这层隔离。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('oss', '0010_alter_fileusage_module'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='filerecord',
            index=models.Index(
                fields=['file_hash', 'workteam_id', 'status'],
                name='oss_filerec_hash_wt_status_idx',
            ),
        ),
    ]
