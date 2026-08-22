"""TabTin file generation toolkit — JSON spec -> xlsx/docx/pptx/pdf."""

from tabtin_filegen.errors import FileGenError, SpecError
from tabtin_filegen.registry import (
    Generator,
    Reader,
    get_generator,
    get_reader,
    list_generators,
    list_readers,
    register,
    register_reader,
)

__all__ = [
    "FileGenError",
    "SpecError",
    "Generator",
    "Reader",
    "get_generator",
    "get_reader",
    "list_generators",
    "list_readers",
    "register",
    "register_reader",
]
__version__ = "0.1.0"
