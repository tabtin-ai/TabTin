from __future__ import annotations

from importlib import import_module, util

import pytest


def _edition_module():
    assert util.find_spec("tabtin.edition") is not None, "edition boundary is missing"
    return import_module("tabtin.edition")


def test_missing_edition_keeps_saas_as_the_default() -> None:
    edition = _edition_module()

    configuration = edition.resolve_edition_configuration({})

    assert configuration.edition is edition.TabTinEdition.SAAS


def test_community_edition_is_case_and_whitespace_insensitive() -> None:
    edition = _edition_module()

    configuration = edition.resolve_edition_configuration(
        {"TABTIN_EDITION": "  COMMUNITY  "}
    )

    assert configuration.edition is edition.TabTinEdition.COMMUNITY


def test_explicit_saas_edition_is_supported() -> None:
    edition = _edition_module()

    configuration = edition.resolve_edition_configuration(
        {"TABTIN_EDITION": "saas"}
    )

    assert configuration.edition is edition.TabTinEdition.SAAS


def test_unknown_edition_fails_deterministically() -> None:
    edition = _edition_module()

    with pytest.raises(ValueError, match="Unsupported TABTIN_EDITION"):
        edition.resolve_edition_configuration(
            {"TABTIN_EDITION": "self_hosted"}
        )
