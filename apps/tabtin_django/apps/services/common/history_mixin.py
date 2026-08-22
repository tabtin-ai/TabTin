"""
Unified Version Management Mixin

Provides consistent version history interface across all content modules:
  - TabDoc (documents)
  - TabData (tables)
  - TabSlide (presentations)
Each module implements the abstract methods to handle module-specific
data serialization and storage.
"""

import json
import logging
import zlib
from abc import ABC, abstractmethod
from datetime import timedelta
from typing import Any, Optional

from django.db import models
from django.utils import timezone

logger = logging.getLogger(__name__)


TTL_TIERS = {
    "free": timedelta(days=7),
    "pro": timedelta(days=30),
    "team": timedelta(days=90),
    "enterprise": timedelta(days=365),
}

SNAPSHOT_INTERVAL = 10
SNAPSHOT_MAX_AGE_SECONDS = 30 * 60  # 30 minutes


class HistoryMixin(ABC):
    """
    Abstract mixin for version history management.

    Subclasses implement module-specific serialization:
      - serialize_snapshot()  → data → compressed blob
      - deserialize_snapshot() → compressed blob → data
      - compute_diff()  → base_data, current_data → diff_data
      - apply_diff()  → base_data, diff_data → current_data

    Usage in a service:
      class SlideHistoryService(HistoryMixin):
          def serialize_snapshot(self, data): ...
          def deserialize_snapshot(self, blob): ...
    """

    @abstractmethod
    def serialize_snapshot(self, data: Any) -> bytes:
        """Serialize content data to compressed bytes."""
        ...

    @abstractmethod
    def deserialize_snapshot(self, blob: bytes) -> Optional[Any]:
        """Deserialize compressed bytes back to content data."""
        ...

    @abstractmethod
    def compute_diff(self, base_data: Any, current_data: Any) -> Optional[dict]:
        """Compute incremental diff between base and current data."""
        ...

    @abstractmethod
    def apply_diff(self, base_data: Any, diff_data: dict) -> Any:
        """Apply incremental diff to base data to produce current data."""
        ...

    @abstractmethod
    def get_content_stats(self, data: Any) -> dict:
        """Extract content statistics (e.g., page_count, shape_count)."""
        ...

    def compress_json(self, data: Any) -> bytes:
        """Default JSON compression using zlib."""
        json_str = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        return zlib.compress(json_str.encode("utf-8"), level=6)

    def decompress_json(self, blob: bytes) -> Optional[Any]:
        """Default JSON decompression from zlib."""
        try:
            decompressed = zlib.decompress(blob)
            return json.loads(decompressed.decode("utf-8"))
        except Exception as e:
            logger.error("Failed to decompress history blob: %s", e)
            return None

    def should_create_anchor(
        self,
        latest_snapshot_at: Optional[Any],
        diff_count_since_snapshot: int,
    ) -> bool:
        """Determine if a full snapshot anchor should be created."""
        if latest_snapshot_at is None:
            return True

        if diff_count_since_snapshot >= SNAPSHOT_INTERVAL:
            return True

        now = timezone.now()
        age = (now - latest_snapshot_at).total_seconds()
        if age >= SNAPSHOT_MAX_AGE_SECONDS:
            return True

        return False

    def get_ttl(self, tier: str = "free", is_named: bool = False) -> Optional[Any]:
        """Calculate TTL expiration datetime. Returns None for named versions."""
        if is_named:
            return None
        ttl_delta = TTL_TIERS.get(tier, TTL_TIERS["free"])
        return timezone.now() + ttl_delta


class VersionListItemSchema:
    """Standardized version list item format across all modules."""

    @staticmethod
    def from_history(
        history_id: str,
        version: int,
        is_snapshot: bool,
        is_named: bool,
        name: str,
        pinned: bool,
        content_stats: dict,
        blob_size: int,
        editor_type: str,
        editor_id: str,
        created_at: str,
        module: str,
    ) -> dict:
        return {
            "id": history_id,
            "version": version,
            "module": module,
            "is_snapshot": is_snapshot,
            "is_named": is_named,
            "name": name,
            "pinned": pinned,
            "content_stats": content_stats,
            "blob_size": blob_size,
            "editor_type": editor_type,
            "editor_id": editor_id,
            "created_at": created_at,
        }
