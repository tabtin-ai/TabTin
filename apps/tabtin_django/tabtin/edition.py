"""TabTin edition resolution.

Keep edition parsing independent from Django settings so every process entry
point can make the same decision before importing optional integrations.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Mapping


class TabTinEdition(StrEnum):
    SAAS = "saas"
    COMMUNITY = "community"


@dataclass(frozen=True)
class EditionConfiguration:
    edition: TabTinEdition


def resolve_edition_configuration(
    environ: Mapping[str, str],
) -> EditionConfiguration:
    raw_edition = environ.get("TABTIN_EDITION", "").strip().lower()
    normalized = raw_edition or TabTinEdition.SAAS.value
    try:
        edition = TabTinEdition(normalized)
    except ValueError as exc:
        supported = ", ".join(item.value for item in TabTinEdition)
        raise ValueError(
            f"Unsupported TABTIN_EDITION={raw_edition!r}; expected one of: {supported}"
        ) from exc
    return EditionConfiguration(edition=edition)
