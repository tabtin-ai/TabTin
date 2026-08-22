"""Pure, offline legacy-equivalence shadow comparison."""

from .classification import DifferenceClassification, DifferenceSeverity
from .observations import ArtifactObservation, LegacyObservation, ObservabilityStatus
from .shadow import ShadowComparisonResult, ShadowDifference, compare_observations

__all__ = [
    "ArtifactObservation",
    "DifferenceClassification",
    "DifferenceSeverity",
    "LegacyObservation",
    "ObservabilityStatus",
    "ShadowComparisonResult",
    "ShadowDifference",
    "compare_observations",
]
