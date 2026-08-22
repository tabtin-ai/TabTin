import base64
import importlib.util
import os
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_media_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write
_encode_media_alt_text = _PPTX_IO._encode_media_alt_text
_decode_media_alt_text = _PPTX_IO._decode_media_alt_text


class TestPptxMediaChain(TestCase):
    def _data_url(self, mime_type: str, payload: bytes) -> str:
        return f"data:{mime_type};base64,{base64.b64encode(payload).decode('ascii')}"

    def _write_and_read(self, pages):
        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
                image_handler=None,
            )
            return out_pages, pptx_path
        except Exception:
            try:
                os.remove(pptx_path)
            except Exception:
                pass
            raise

    def test_media_alt_text_metadata_roundtrip(self):
        encoded = _encode_media_alt_text("audio", {
            "autoplay": True,
            "loop": True,
            "fixedRatio": True,
            "color": "#123456",
            "ext": "mp3",
        })
        self.assertIsInstance(encoded, str)
        decoded = _decode_media_alt_text(encoded)
        self.assertIsNotNone(decoded)
        assert decoded is not None
        self.assertEqual(decoded.get("type"), "audio")
        self.assertEqual(decoded.get("autoplay"), True)
        self.assertEqual(decoded.get("loop"), True)
        self.assertEqual(decoded.get("fixedRatio"), True)
        self.assertEqual(decoded.get("color"), "#123456")
        self.assertEqual(decoded.get("ext"), "mp3")

    def test_write_read_preserves_video_audio_chain_and_embeds_media(self):
        video_bytes = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
        audio_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x0fTIT2\x00\x00\x00\x05\x00\x00test"
        poster_png = bytes.fromhex(
            "89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE"
            "0000000C49444154789C6360600000000400010D0A2DB40000000049454E44AE426082"
        )

        pages = [
            {
                "id": "page-1",
                "background": {"type": "color", "value": "#ffffff"},
                "elements": [
                    {
                        "id": "video-1",
                        "type": "video",
                        "x": 120,
                        "y": 100,
                        "width": 640,
                        "height": 360,
                        "rotate": 7,
                        "opacity": 0.92,
                        "zIndex": 0,
                        "props": {
                            "src": self._data_url("video/mp4", video_bytes),
                            "poster": self._data_url("image/png", poster_png),
                            "autoplay": True,
                            "ext": "mp4",
                        },
                    },
                    {
                        "id": "audio-1",
                        "type": "audio",
                        "x": 140,
                        "y": 520,
                        "width": 180,
                        "height": 52,
                        "rotate": 0,
                        "opacity": 1,
                        "zIndex": 1,
                        "props": {
                            "src": self._data_url("audio/mpeg", audio_bytes),
                            "color": "#123456",
                            "fixedRatio": True,
                            "loop": True,
                            "autoplay": True,
                            "ext": "mp3",
                        },
                    },
                ],
            }
        ]

        out_pages, pptx_path = self._write_and_read(pages)
        try:
            self.assertEqual(len(out_pages), 1)
            out_elements = out_pages[0].get("elements", [])
            self.assertGreaterEqual(len(out_elements), 2)

            out_video = next((el for el in out_elements if el.get("type") == "video"), None)
            out_audio = next((el for el in out_elements if el.get("type") == "audio"), None)
            self.assertIsNotNone(out_video)
            self.assertIsNotNone(out_audio)

            assert out_video is not None and out_audio is not None
            video_props = out_video.get("props", {})
            audio_props = out_audio.get("props", {})

            self.assertTrue(str(video_props.get("src", "")).startswith("data:video/"))
            self.assertTrue(str(video_props.get("poster", "")).startswith("data:image/"))
            self.assertEqual(video_props.get("autoplay"), True)
            self.assertEqual(video_props.get("ext"), "mp4")

            self.assertTrue(str(audio_props.get("src", "")).startswith("data:audio/"))
            self.assertEqual(audio_props.get("color"), "#123456")
            self.assertEqual(audio_props.get("fixedRatio"), True)
            self.assertEqual(audio_props.get("loop"), True)
            self.assertEqual(audio_props.get("autoplay"), True)
            self.assertEqual(audio_props.get("ext"), "mp3")

            # 验证导出文件确实嵌入了媒体资源，而非仅占位图形
            with zipfile.ZipFile(pptx_path, "r") as zf:
                media_files = [n for n in zf.namelist() if n.startswith("ppt/media/")]
                self.assertTrue(any(n.endswith(".mp4") for n in media_files), media_files)
                self.assertTrue(any(n.endswith(".mp3") for n in media_files), media_files)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

