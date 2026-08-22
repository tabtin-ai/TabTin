"""
Tests for V2 Import/Export P0 fixes.

F3-01: _read_binary_source_for_write must reject local file paths
       to prevent arbitrary file read (security vulnerability).
"""
import base64
import importlib.util
import sys
from pathlib import Path
from unittest import TestCase

_PPTX_IO_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("_pptx_io_f301", _PPTX_IO_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_PPTX_IO_PATH}")

_mod = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _mod
_SPEC.loader.exec_module(_mod)

_read_binary_source_for_write = _mod._read_binary_source_for_write


class TestReadBinarySourceForWriteSecurityF301(TestCase):
    """F3-01: local file paths must be rejected to prevent arbitrary file read."""

    def test_rejects_absolute_path(self):
        import tempfile, os
        fd, path = tempfile.mkstemp()
        try:
            os.write(fd, b"sensitive data")
            os.close(fd)
            result = _read_binary_source_for_write(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_rejects_etc_passwd(self):
        result = _read_binary_source_for_write("/etc/passwd")
        self.assertIsNone(result)

    def test_rejects_relative_path(self):
        result = _read_binary_source_for_write("../../etc/shadow")
        self.assertIsNone(result)

    def test_accepts_data_url(self):
        payload = base64.b64encode(b"hello world").decode()
        data_url = f"data:application/octet-stream;base64,{payload}"
        result = _read_binary_source_for_write(data_url)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], b"hello world")

    def test_rejects_empty_string(self):
        result = _read_binary_source_for_write("")
        self.assertIsNone(result)

    def test_rejects_non_string(self):
        result = _read_binary_source_for_write(12345)
        self.assertIsNone(result)

    def test_rejects_path_traversal(self):
        result = _read_binary_source_for_write("../../../etc/hosts")
        self.assertIsNone(result)

    def test_rejects_home_directory_path(self):
        result = _read_binary_source_for_write("/home/user/.ssh/id_rsa")
        self.assertIsNone(result)
