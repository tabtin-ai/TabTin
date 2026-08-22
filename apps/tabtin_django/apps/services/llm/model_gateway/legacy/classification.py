"""Fixed shadow-difference vocabulary and reviewed normalization rules."""

from enum import StrEnum


class DifferenceClassification(StrEnum):
    EQUIVALENT = "equivalent"
    REPRESENTATION_ONLY = "representation_only"
    LEGACY_COMPATIBLE_DIFFERENCE = "legacy_compatible_difference"
    INTENTIONAL_FUTURE_DIFFERENCE = "intentional_future_difference"
    PROVISIONAL = "provisional"
    UNKNOWN = "unknown"
    UNOBSERVABLE = "unobservable"
    NOT_RUNTIME_PRESENT = "not_runtime_present"
    BEHAVIOR_BLOCKING_MISMATCH = "behavior_blocking_mismatch"


class DifferenceSeverity(StrEnum):
    INFORMATIONAL = "informational"
    WARNING = "warning"
    BLOCKING = "blocking"


NON_SEMANTIC_NORMALIZATIONS = frozenset({
    "canonical-json",
    "enum-string",
    "implicit-default-omission",
    "database-empty-endpoint",
})


def severity_for(classification: DifferenceClassification) -> DifferenceSeverity:
    if classification == DifferenceClassification.BEHAVIOR_BLOCKING_MISMATCH:
        return DifferenceSeverity.BLOCKING
    if classification in {
        DifferenceClassification.PROVISIONAL,
        DifferenceClassification.UNKNOWN,
        DifferenceClassification.UNOBSERVABLE,
        DifferenceClassification.NOT_RUNTIME_PRESENT,
        DifferenceClassification.INTENTIONAL_FUTURE_DIFFERENCE,
    }:
        return DifferenceSeverity.WARNING
    return DifferenceSeverity.INFORMATIONAL
