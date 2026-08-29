"""
⚠️ DEPRECATED WARNING ⚠️

This module (apps.schema_discovery) has been DEPRECATED and migrated to apps.schema.discovery

Migration Date: 2025-11-20
New Location: apps/schema/discovery

Changes:
1. TemplateManager → apps.schema.discovery.services.template_manager.TemplateManager
2. SchemaCache → apps.schema.discovery.services.schema_cache_adapter.SchemaCache
3. GeneratedSchema → apps.schema.storage.models.Schema (unified storage)
4. SchemaTemplate → apps.schema.storage.models.SchemaTemplate

Please update your imports:
    # Old (DEPRECATED)
    from apps.schema_discovery.services import SchemaCache, TemplateManager

    # New (Recommended)
    from apps.schema.discovery.services.schema_cache_adapter import SchemaCache
    from apps.schema.discovery.services.template_manager import TemplateManager

All functionality has been preserved through compatibility layers.
The old module will be removed in a future version.

For more information, see:
- apps/schema/docs/MIGRATION_PHASE_1_3_COMPLETE.md
- apps/schema/docs/SCHEMA_MODULES_MIGRATION_TODO.md
"""

import warnings

warnings.warn(
    "apps.schema_discovery is deprecated and has been migrated to apps.schema.discovery. "
    "Please update your imports to use apps.schema.discovery instead. "
    "This module will be removed in a future version.",
    DeprecationWarning,
    stacklevel=2
)
