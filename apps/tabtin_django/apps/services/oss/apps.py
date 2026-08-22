from django.apps import AppConfig


class OssConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.services.oss'
    verbose_name = 'OSS对象存储服务'

    # v0.1 §5.1（2026-05-07）：原 FileRecord pre_delete cascade signal 移到
    # ``apps/tabdata/signals.py``——按"声明引用方负责清理"原则
    # tabdata 是 ``AttachmentReference.file_id`` / ``AttachmentUpload.file_record_id``
    # 的声明方，cascade 应由 tabdata 注册。oss 是被引用方，不该反向 import tabdata。
