"""Format registries — the single extension seam.

Two parallel registries, both keyed by file type:
  - generators: JSON spec -> file (``register`` / ``get_generator``)
  - readers:    existing file -> structured content (``register_reader`` / ``get_reader``)

Adding a new file type is: implement a ``Generator`` and/or ``Reader`` in
``generators/`` and register them at import time in ``generators/__init__.py``.
Nothing else in the CLI or the Go proxy changes.
"""

from __future__ import annotations

from typing import Any, Dict, Protocol, runtime_checkable

from tabtin_filegen.errors import UnsupportedTypeError


@runtime_checkable
class Generator(Protocol):
    """Produces one file format from a validated JSON spec."""

    #: Logical type id, e.g. ``"xlsx"``. Unique across the registry.
    file_type: str
    #: Associated extensions (with dot, lowercase), e.g. ``(".xlsx",)``.
    extensions: tuple[str, ...]

    def generate(self, spec: Dict[str, Any], out_path: str) -> None:
        """Write the file described by ``spec`` to ``out_path``."""
        ...

    def spec_help(self) -> str:
        """Human/Agent-readable description of this type's JSON spec."""
        ...


_REGISTRY: Dict[str, Generator] = {}
_BY_EXTENSION: Dict[str, Generator] = {}


def register(generator: Generator) -> None:
    """Register a generator. Rejects duplicate file types / extensions."""
    file_type = generator.file_type.lower()
    if file_type in _REGISTRY:
        raise ValueError(f"duplicate generator file_type: {file_type}")
    for ext in generator.extensions:
        ext_lower = ext.lower()
        if not ext_lower.startswith("."):
            raise ValueError(f"extension must start with '.': {ext}")
        if ext_lower in _BY_EXTENSION:
            raise ValueError(f"duplicate generator extension: {ext_lower}")
        _BY_EXTENSION[ext_lower] = generator
    _REGISTRY[file_type] = generator


def get_generator(file_type: str) -> Generator:
    """Look up a generator by file type. Raises ``UnsupportedTypeError``."""
    generator = _REGISTRY.get(file_type.lower())
    if generator is None:
        supported = ", ".join(sorted(_REGISTRY)) or "(none)"
        raise UnsupportedTypeError(
            f"unsupported file type: {file_type}. supported: {supported}"
        )
    return generator


def get_by_extension(ext: str) -> Generator | None:
    """Look up a generator by extension (with leading dot)."""
    return _BY_EXTENSION.get(ext.lower())


def list_generators() -> list[Generator]:
    """All registered generators, sorted by file type."""
    return [_REGISTRY[key] for key in sorted(_REGISTRY)]


@runtime_checkable
class Reader(Protocol):
    """Extracts structured content from one existing file format."""

    #: Logical type id, e.g. ``"xlsx"``. Unique across the reader registry.
    file_type: str
    #: Associated extensions (with dot, lowercase), e.g. ``(".xlsx",)``.
    extensions: tuple[str, ...]

    def read(self, path: str) -> Dict[str, Any]:
        """Read ``path`` and return its content as a JSON-serializable dict."""
        ...

    def read_help(self) -> str:
        """Human/Agent-readable description of this type's read output shape."""
        ...


_READERS: Dict[str, Reader] = {}
_READER_BY_EXTENSION: Dict[str, Reader] = {}


def register_reader(reader: Reader) -> None:
    """Register a reader. Rejects duplicate file types / extensions."""
    file_type = reader.file_type.lower()
    if file_type in _READERS:
        raise ValueError(f"duplicate reader file_type: {file_type}")
    for ext in reader.extensions:
        ext_lower = ext.lower()
        if not ext_lower.startswith("."):
            raise ValueError(f"extension must start with '.': {ext}")
        if ext_lower in _READER_BY_EXTENSION:
            raise ValueError(f"duplicate reader extension: {ext_lower}")
        _READER_BY_EXTENSION[ext_lower] = reader
    _READERS[file_type] = reader


def get_reader(file_type: str) -> Reader:
    """Look up a reader by file type. Raises ``UnsupportedTypeError``."""
    reader = _READERS.get(file_type.lower())
    if reader is None:
        supported = ", ".join(sorted(_READERS)) or "(none)"
        raise UnsupportedTypeError(
            f"unsupported file type for read: {file_type}. supported: {supported}"
        )
    return reader


def get_reader_by_extension(ext: str) -> Reader | None:
    """Look up a reader by extension (with leading dot)."""
    return _READER_BY_EXTENSION.get(ext.lower())


def list_readers() -> list[Reader]:
    """All registered readers, sorted by file type."""
    return [_READERS[key] for key in sorted(_READERS)]
