from urllib.parse import urlparse

from django.conf import settings
from django.db import migrations, models


def _known_asset_hosts() -> set[str]:
    hosts: set[str] = set()
    bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or ""
    endpoint = getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or ""
    cdn_domain = getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "") or ""
    asset_domain = getattr(settings, "ASSET_PUBLIC_DOMAIN", "") or ""

    for value in (cdn_domain, asset_domain):
        if value:
            hosts.add(value)
    if bucket and endpoint:
        hosts.add(f"{bucket}.{endpoint}")
    return hosts


def normalize_user_avatar_refs(apps, schema_editor):
    User = apps.get_model("users_auth", "User")
    known_hosts = _known_asset_hosts()

    for user in User.objects.exclude(avatar="").iterator(chunk_size=500):
        ref = (user.avatar or "").strip()
        parsed = urlparse(ref)
        if not (parsed.scheme and parsed.netloc):
            continue

        hostname = parsed.hostname or ""
        is_oss = ".aliyuncs.com" in hostname or ".oss-cn-" in hostname
        is_known_asset = hostname in known_hosts
        if not (is_oss or is_known_asset):
            continue

        object_key = parsed.path.lstrip("/")
        if object_key and object_key != ref:
            user.avatar = object_key
            user.save(update_fields=["avatar"])


class Migration(migrations.Migration):

    dependencies = [
        ("users_auth", "0011_userprofile_personal_rules"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="avatar",
            field=models.CharField(
                blank=True,
                help_text="优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容",
                max_length=500,
                verbose_name="头像文件引用",
            ),
        ),
        migrations.RunPython(normalize_user_avatar_refs, migrations.RunPython.noop),
    ]
