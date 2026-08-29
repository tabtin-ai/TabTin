"""
⚠️ DEPRECATED WARNING ⚠️

This module (apps.schema_market) has been DEPRECATED and migrated to apps.schema.market

Migration Date: 2025-11-20
New Location: apps/schema/market

Changes:
1. MarketTemplate → apps.schema.market.models.MarketTemplate (updated foreign keys)
2. TemplateUsage → apps.schema.market.models.TemplateUsage
3. TemplateService → apps.schema.market.services.template_service.TemplateService
4. Market API → /api/schema/* (unified endpoint)

Please update your imports:
    # Old (DEPRECATED)
    from apps.schema_market.models import MarketTemplate
    from apps.schema_market.services import TemplateService

    # New (Recommended)
    from apps.schema.market.models import MarketTemplate
    from apps.schema.market.services.template_service import TemplateService

All functionality has been preserved and enhanced in the new location.
The old module will be removed in a future version.

For more information, see:
- apps/schema/docs/MIGRATION_PHASE_1_3_COMPLETE.md
- apps/schema/docs/SCHEMA_MODULES_MIGRATION_TODO.md
"""

import warnings

warnings.warn(
    "apps.schema_market is deprecated and has been migrated to apps.schema.market. "
    "Please update your imports to use apps.schema.market instead. "
    "This module will be removed in a future version.",
    DeprecationWarning,
    stacklevel=2
)
