"""Kimi 图/视频：wire_adapter 配置 upload_mode。

不写死 provider_key 分支——适配走 ``ImageCaps`` / ``VideoCaps.upload_mode``。
本 migration 给 Moonshot Kimi 写入可配置 caps：

- video：``files_api`` + ``ms://``（官方大视频 Files API）
- image：``inline_base64``（官方图片 base64；与  本机直读一致）
"""

from __future__ import annotations

from django.db import migrations

# 官方：大视频 POST /files purpose=video → video_url.url = ms://{file_id}
KIMI_VIDEO_WIRE = {
    "enabled": True,
    "input_via": ["url", "file_id", "base64"],
    "upload_mode": "files_api",
    "files_api": {
        "endpoint": "/files",
        "purpose": "video",
        "url_scheme": "ms://",
        "id_field": "id",
        "timeout_s": 180.0,
    },
    "max_size_mb": 100,
    "native_url_prefixes": ["ms://", "data:video/"],
}

# 官方图片示例用 data:image/...;base64；本机 OSS 不可达时由 upload_mode 驱动改写
KIMI_IMAGE_UPLOAD = {
    "upload_mode": "inline_base64",
    "native_url_prefixes": ["ms://", "data:image/"],
    "files_api": {
        "endpoint": "/files",
        "purpose": "file-extract",
        "url_scheme": "ms://",
        "id_field": "id",
        "timeout_s": 180.0,
    },
}

KIMI_MODEL_NAMES = ("kimi-k2.5", "kimi-k2.6")


def upgrade_kimi_media_upload_caps(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    providers = LLMProvider.objects.filter(
        provider_key="moonshot",
        scope="global",
    )
    if not providers.exists():
        return

    for model in LLMModel.objects.filter(
        provider__in=providers,
        model_name__in=KIMI_MODEL_NAMES,
    ):
        cfg = dict(model.capabilities_config or {})
        cfg["supports_video_input"] = True
        video_top = dict(cfg.get("video") or {})
        video_top["enabled"] = True
        cfg["video"] = video_top

        wire = dict(cfg.get("wire_adapter") or {})
        wire["video"] = dict(KIMI_VIDEO_WIRE)

        image = dict(wire.get("image") or {})
        image.setdefault("enabled", True)
        if not image.get("input_via"):
            image["input_via"] = ["base64", "file_id"]
        image.update(KIMI_IMAGE_UPLOAD)
        wire["image"] = image

        cfg["wire_adapter"] = wire
        model.capabilities_config = cfg
        model.save(update_fields=["capabilities_config", "updated_at"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0045_kimi_video_input_caps"),
    ]

    operations = [
        migrations.RunPython(upgrade_kimi_media_upload_caps, noop_reverse),
    ]
