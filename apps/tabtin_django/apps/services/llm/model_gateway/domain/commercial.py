from typing import Literal

from ._base import ArtifactBase, DecimalString, UTCValidityInterval
from .identities import ArtifactIdentity, ExactRef


class RateLine(ArtifactBase):
    unit: Literal["input-token", "output-token", "cached-input-token", "request"]
    amount: DecimalString
    currency: str


class RateCard(ArtifactBase):
    identity: ArtifactIdentity
    binding_ref: ExactRef
    validity: UTCValidityInterval
    rates: tuple[RateLine, ...]
    pricing_scheme: Literal["metered", "non-billed"] = "metered"
    non_billed_reason: str | None = None
    deployment_ref: ExactRef | None = None
    service_profile: str | None = None
