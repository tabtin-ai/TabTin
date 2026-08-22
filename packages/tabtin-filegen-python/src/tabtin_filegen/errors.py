"""Structured errors for the file generation CLI.

Errors carry a stable ``code`` so the Go proxy / Agent can branch on failure
type instead of parsing free-form messages. Messages stay user-facing and must
not leak absolute paths or environment details beyond what the caller provided.
"""

from __future__ import annotations


class FileGenError(Exception):
    """Base error for all file generation failures."""

    code = "filegen_error"


class SpecError(FileGenError):
    """The provided JSON spec is missing, malformed, or semantically invalid."""

    code = "spec_error"


class UnsupportedTypeError(FileGenError):
    """No generator is registered for the requested file type."""

    code = "unsupported_type"
