"""Retired cross-Space tool domain.

SF-1 removed Space-level sharing/delegation, so no cross_space/cross_device
tools are exposed to Agent runtime.
"""
from typing import List

from apps.services.tools import BaseTool


def get_cross_space_tools() -> List[BaseTool]:
    return []


__all__ = [
    "get_cross_space_tools",
]
