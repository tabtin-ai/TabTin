"""
初始化/更新通用计量项定价种子数据

Usage:
    python manage.py seed_meter_pricing          # 仅创建缺失的定价
    python manage.py seed_meter_pricing --force   # 覆盖已有定价
"""

from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.services.billing.models import MeterPricing
from apps.services.media_generation.pricing import IMAGE_SUCCESS_UNIT_PRICE

SEED_DATA = [
    {
        "meter_key": "speech.asr.seconds",
        "unit": "seconds",
        "unit_price": Decimal("0.0500"),
        "description": "语音识别（火山 ASR）按秒计费",
    },
    {
        "meter_key": "speech.tts.characters",
        "unit": "characters",
        "unit_price": Decimal("0.0100"),
        "description": "语音合成（火山 TTS）按百字符计费",
    },
    {
        "meter_key": "media.image.count",
        "unit": "count",
        "unit_price": IMAGE_SUCCESS_UNIT_PRICE,
        "description": "AI 图片生成按成功图片计费",
    },
    {
        "meter_key": "media.video.seconds",
        "unit": "seconds",
        "unit_price": Decimal("2.0000"),
        "description": "AI 视频生成（DashScope）按秒计费",
    },
    {
        "meter_key": "media.bgm.seconds",
        "unit": "seconds",
        "unit_price": Decimal("0.0200"),
        "description": "BGM 背景音乐生成（MiniMax）按秒计费",
    },
    {
        "meter_key": "rag.embedding.tokens",
        "unit": "k_tokens",
        "unit_price": Decimal("0.0010"),
        "description": "向量化（Embedding）按千 token 计费",
    },
    {
        "meter_key": "notification.sms.count",
        "unit": "count",
        "unit_price": Decimal("5.0000"),
        "description": "短信通知按条计费",
    },
    {
        "meter_key": "notification.email.count",
        "unit": "count",
        "unit_price": Decimal("1.0000"),
        "description": "邮件通知按封计费",
    },
    {
        "meter_key": "channel.message.count",
        "unit": "count",
        "unit_price": Decimal("1.0000"),
        "description": "渠道消息按条计费",
    },
    {
        "meter_key": "storage.gb",
        "unit": "gb",
        "unit_price": Decimal("0.1200"),
        "description": "对象存储按 GB 计量（超出套餐部分按量计费）",
    },
]


class Command(BaseCommand):
    help = "初始化通用计量项 (MeterPricing) 种子数据"

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="覆盖已有的同 meter_key 定价记录",
        )

    def handle(self, *args, **options):
        force = options["force"]
        created_count = 0
        updated_count = 0
        skipped_count = 0

        for item in SEED_DATA:
            meter_key = item["meter_key"]
            existing = MeterPricing.objects.filter(
                meter_key=meter_key,
                scope="global",
                provider_key="",
                model_name="",
            ).first()

            if existing:
                if force:
                    existing.unit = item["unit"]
                    existing.unit_price = item["unit_price"]
                    existing.is_active = True
                    existing.save(update_fields=["unit", "unit_price", "is_active", "updated_at"])
                    updated_count += 1
                    self.stdout.write(f"  [更新] {meter_key} = {item['unit_price']}/{item['unit']}")
                else:
                    skipped_count += 1
                    self.stdout.write(f"  [跳过] {meter_key} (已存在，使用 --force 覆盖)")
            else:
                MeterPricing.objects.create(
                    meter_key=meter_key,
                    scope="global",
                    unit=item["unit"],
                    unit_price=item["unit_price"],
                    currency="CREDITS",
                    is_active=True,
                    effective_from=timezone.now(),
                )
                created_count += 1
                self.stdout.write(f"  [创建] {meter_key} = {item['unit_price']}/{item['unit']}")

        self.stdout.write(self.style.SUCCESS(
            f"\n完成: 创建 {created_count}，更新 {updated_count}，跳过 {skipped_count}"
        ))
