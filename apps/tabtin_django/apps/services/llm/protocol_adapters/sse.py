from __future__ import annotations
from typing import Iterable, Iterator

def iter_sse_data(lines: Iterable[bytes]) -> Iterator[tuple[str, str]]:
    parts = []
    for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if parts: yield "data", "\n".join(parts); parts = []
            continue
        if line.startswith(":"):
            if parts: yield "data", "\n".join(parts); parts = []
            yield "keepalive", line[1:].lstrip(); continue
        field, sep, value = line.partition(":")
        if field.strip() == "data": parts.append(value[1:] if value.startswith(" ") else value)
    if parts: yield "truncated", "\n".join(parts)
