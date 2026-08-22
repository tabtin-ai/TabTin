"""媒体 Scene 的正式后端计价常量。"""

from decimal import Decimal

IMAGE_SUCCESS_METER_KEY = "media.image.count"
IMAGE_SUCCESS_UNIT_PRICE = Decimal("25.0000")

__all__ = ["IMAGE_SUCCESS_METER_KEY", "IMAGE_SUCCESS_UNIT_PRICE"]
