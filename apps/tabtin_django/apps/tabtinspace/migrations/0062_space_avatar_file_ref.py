from urllib.parse import urlparse

from django.conf import settings
from django.db import migrations, models


def _known_asset_hosts() -> set[str]:
    hosts: set[str] = set()
    bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or ""
    endpoint = (getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or "").removeprefix("https://").removeprefix("http://").strip("/")
    for value in (
        getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "") or "",
        getattr(settings, "ASSET_PUBLIC_DOMAIN", "") or "",
    ):
        parsed = urlparse(value if "://" in value else f"https://{value}")
        if parsed.hostname:
            hosts.add(parsed.hostname)
    if bucket and endpoint:
        hosts.add(f"{bucket}.{endpoint}")
    return hosts


def normalize_space_avatar_refs(apps, schema_editor):
    Space = apps.get_model("tabtinspace", "Space")
    known_hosts = _known_asset_hosts()
    for space in Space.objects.exclude(avatar="").iterator(chunk_size=500):
        ref = (space.avatar or "").strip()
        parsed = urlparse(ref)
        if not (parsed.scheme and parsed.netloc):
            continue
        hostname = parsed.hostname or ""
        is_oss = ".aliyuncs.com" in hostname or ".oss-cn-" in hostname
        if not (is_oss or hostname in known_hosts):
            continue
        object_key = parsed.path.lstrip("/")
        if object_key and object_key != ref:
            space.avatar = object_key
            space.save(update_fields=["avatar"])


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0061_workteam_status"),
    ]

    operations = [
        migrations.AlterField(
            model_name="space",
            name="avatar",
            field=models.CharField(
                blank=True,
                default="",
                help_text="优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容",
                max_length=500,
                verbose_name="头像文件引用",
            ),
        ),
        migrations.RunPython(normalize_space_avatar_refs, migrations.RunPython.noop),
    ]
