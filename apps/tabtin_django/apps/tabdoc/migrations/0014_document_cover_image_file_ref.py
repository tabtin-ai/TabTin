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


def normalize_document_cover_refs(apps, schema_editor):
    Document = apps.get_model("tabdoc", "Document")
    known_hosts = _known_asset_hosts()
    for doc in Document.objects.exclude(cover_image="").iterator(chunk_size=500):
        ref = (doc.cover_image or "").strip()
        parsed = urlparse(ref)
        if not (parsed.scheme and parsed.netloc):
            continue
        hostname = parsed.hostname or ""
        is_oss = ".aliyuncs.com" in hostname or ".oss-cn-" in hostname
        if not (is_oss or hostname in known_hosts):
            continue
        object_key = parsed.path.lstrip("/")
        if object_key and object_key != ref:
            doc.cover_image = object_key
            doc.save(update_fields=["cover_image"])


class Migration(migrations.Migration):
    dependencies = [
        ("tabdoc", "0013_backfill_document_owner_id"),
    ]

    operations = [
        migrations.AlterField(
            model_name="document",
            name="cover_image",
            field=models.CharField(
                blank=True,
                default="",
                help_text="优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容",
                max_length=1024,
                verbose_name="封面图片文件引用",
            ),
        ),
        migrations.RunPython(normalize_document_cover_refs, migrations.RunPython.noop),
    ]
