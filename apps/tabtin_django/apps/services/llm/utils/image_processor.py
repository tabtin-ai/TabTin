"""
图片文件预处理工具
"""

import math
import os
import mimetypes
import time
import uuid
from typing import Dict, List, Optional, Tuple, Any
from django.conf import settings
import logging

from apps.i18n import get_text

logger = logging.getLogger(__name__)

_IMAGE_MAGIC_BYTES: List[Tuple[bytes, str]] = [
    (b'\xff\xd8\xff', 'image/jpeg'),
    (b'\x89PNG\r\n\x1a\n', 'image/png'),
    (b'GIF89a', 'image/gif'),
    (b'GIF87a', 'image/gif'),
]

_CLEANUP_INTERVAL_SECONDS = 3600
_TEMP_FILE_MAX_AGE_SECONDS = 86400


class ImageProcessor:
    """图片预处理器"""

    def __init__(self):
        self.max_file_size = getattr(settings, 'LLM_MAX_FILE_SIZE', 50 * 1024 * 1024)  # 50MB
        self.temp_dir = getattr(settings, 'LLM_TEMP_DIR', '/tmp/llm_files')
        os.makedirs(self.temp_dir, exist_ok=True)
        self._last_cleanup: float = 0.0

    def validate_image(self, file_path: str) -> Dict[str, Any]:
        """
        验证图片文件是否符合要求

        Args:
            file_path: 图片文件路径

        Returns:
            Dict: 验证结果
        """
        result = {
            'valid': False,
            'error': None,
            'file_info': {}
        }

        try:
            if not os.path.exists(file_path):
                result['error'] = get_text('llm.file_not_found')
                return result

            # 检查文件大小
            file_size = os.path.getsize(file_path)
            if file_size > self.max_file_size:
                result['error'] = get_text('llm.file_size_exceeded', size=file_size, max_size=self.max_file_size)
                return result

            mime_type, _ = mimetypes.guess_type(file_path)
            magic_mime = self._detect_mime_from_magic(file_path)

            if magic_mime:
                if mime_type and mime_type != magic_mime:
                    logger.warning(
                        "MIME 不一致: 扩展名=%s, 魔数=%s, 文件=%s — 以魔数为准",
                        mime_type, magic_mime, file_path,
                    )
                mime_type = magic_mime
            elif not mime_type:
                result['error'] = get_text('llm.file_type_unknown')
                return result

            validation = self._validate_image_format(file_path, mime_type)

            if not validation['valid']:
                result['error'] = validation['error']
                return result

            result['valid'] = True
            result['file_info'] = {
                'size': file_size,
                'mime_type': mime_type,
                'extension': os.path.splitext(file_path)[1].lower(),
                **validation.get('info', {})
            }

        except Exception as e:
            logger.error("文件验证异常: %s", e)
            result['error'] = get_text('llm.file_validation_failed', detail="文件处理异常")

        return result

    def _validate_image_format(self, file_path: str, mime_type: str) -> Dict[str, Any]:
        """验证图片文件"""
        supported_types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

        if mime_type not in supported_types:
            return {'valid': False, 'error': get_text('llm.image_format_unsupported', mime_type=mime_type)}

        try:
            from PIL import Image
            with Image.open(file_path) as img:
                width, height = img.size
                return {
                    'valid': True,
                    'info': {
                        'width': width,
                        'height': height,
                        'format': img.format,
                        'mode': img.mode
                    }
                }
        except Exception as e:
            return {'valid': False, 'error': get_text('llm.image_file_corrupted', detail="无法解析图片")}

    @staticmethod
    def _detect_mime_from_magic(file_path: str) -> Optional[str]:
        """通过文件魔数检测真实 MIME 类型，防止扩展名伪造。"""
        try:
            with open(file_path, 'rb') as f:
                header = f.read(12)
            for magic, mime in _IMAGE_MAGIC_BYTES:
                if header.startswith(magic):
                    return mime
            if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
                return 'image/webp'
        except Exception:
            pass
        return None

    def calculate_image_tokens(self, file_info: Dict,
                               provider: str = 'openai',
                               detail: str = 'auto') -> int:
        """按 provider 计算图片 token。

        provider 分档：
          - openai: GPT-4V 规则（low=85 固定; high=170*tiles+85）
          - claude: ceil(width*height/750), 范围 [85, 5000]
          - 其他:   ceil(width*height/750), 范围 [85, 5000]（通用估算）
        """
        try:
            width = file_info.get('width', 0)
            height = file_info.get('height', 0)
            provider_lower = provider.lower()

            if provider_lower in ('openai', 'moonshot', 'minimax'):
                return self._openai_image_tokens(width, height, detail)
            elif provider_lower == 'claude':
                return self._claude_image_tokens(width, height)
            else:
                return self._generic_image_tokens(width, height)

        except Exception as e:
            logger.error("图片Token计算异常: %s", e)
            return 85

    @staticmethod
    def _openai_image_tokens(width: int, height: int, detail: str = 'auto') -> int:
        """GPT-4V 图片 token 计算规则。"""
        if detail == 'low':
            return 85
        if width <= 0 or height <= 0:
            return 85
        scale = min(2048 / max(width, height), 1.0)
        w, h = width * scale, height * scale
        short_side_scale = 768 / min(w, h)
        if short_side_scale < 1.0:
            w, h = w * short_side_scale, h * short_side_scale
        tiles_w = math.ceil(w / 512)
        tiles_h = math.ceil(h / 512)
        return 170 * tiles_w * tiles_h + 85

    @staticmethod
    def _claude_image_tokens(width: int, height: int) -> int:
        """Anthropic 图片 token：ceil(pixels / 750)，范围 [85, 5000]。"""
        if width <= 0 or height <= 0:
            return 85
        tokens = math.ceil((width * height) / 750)
        return max(85, min(tokens, 5_000))

    @staticmethod
    def _generic_image_tokens(width: int, height: int) -> int:
        """通用图片 token 估算。"""
        if width <= 0 or height <= 0:
            return 85
        tokens = math.ceil((width * height) / 750)
        return max(85, min(tokens, 5_000))

    def compress_image(self, file_path: str, max_size: int = 20 * 1024 * 1024,
                       max_width: int = 2048, max_height: int = 2048) -> str:
        """压缩图片文件。

        Args:
            file_path: 原始图片路径
            max_size: 最大文件大小（字节）
            max_width: 最大宽度
            max_height: 最大高度

        Returns:
            str: 压缩后的图片路径
        """
        self._lazy_cleanup_temp_files()

        try:
            from PIL import Image

            with Image.open(file_path) as img:
                if img.mode in ('RGBA', 'LA', 'P'):
                    img = img.convert('RGB')

                width, height = img.size
                if width > max_width or height > max_height:
                    ratio = min(max_width / width, max_height / height)
                    new_width = int(width * ratio)
                    new_height = int(height * ratio)
                    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

                base_name = os.path.splitext(os.path.basename(file_path))[0]
                unique_id = uuid.uuid4().hex[:8]
                compressed_path = os.path.join(
                    self.temp_dir, f"{base_name}_{unique_id}_compressed.jpg"
                )

                quality = 85
                while quality > 10:
                    img.save(compressed_path, 'JPEG', quality=quality, optimize=True)
                    if os.path.getsize(compressed_path) <= max_size:
                        break
                    quality -= 10

                return compressed_path

        except Exception as e:
            logger.error("图片压缩异常: %s", e)
            return file_path

    def _lazy_cleanup_temp_files(self) -> None:
        """惰性清理过期临时文件（间隔 >= 1 小时触发，删除 > 24 小时的文件）。"""
        now = time.time()
        if now - self._last_cleanup < _CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup = now
        self.cleanup_temp_files()

    def cleanup_temp_files(self, max_age_seconds: int = _TEMP_FILE_MAX_AGE_SECONDS) -> int:
        """清理 temp_dir 中超过 max_age_seconds 的文件，返回删除数量。"""
        removed = 0
        cutoff = time.time() - max_age_seconds
        try:
            for fname in os.listdir(self.temp_dir):
                fpath = os.path.join(self.temp_dir, fname)
                if not os.path.isfile(fpath):
                    continue
                try:
                    if os.path.getmtime(fpath) < cutoff:
                        os.remove(fpath)
                        removed += 1
                except OSError:
                    pass
            if removed:
                logger.info("清理临时图片文件: 删除 %d 个过期文件", removed)
        except Exception as e:
            logger.error("清理临时文件异常: %s", e)
        return removed


def get_image_processor() -> ImageProcessor:
    """获取图片处理器实例"""
    return ImageProcessor()
