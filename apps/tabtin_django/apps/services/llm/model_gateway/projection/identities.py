"""Read-only discovery and environment-scoped database target identities."""

from __future__ import annotations

import hashlib
from typing import Literal
from uuid import UUID

from pydantic import model_validator

from ..domain._base import StrictFrozenModel
from ..domain.deployments import DeploymentProfile, ModelDeploymentBinding
from .snapshot import DatabaseSnapshot

TargetType = Literal["llm-provider", "llm-model"]
DiscoveryOutcome = Literal[
    "exact_reviewed_binding",
    "unique_bootstrap_candidate",
    "ambiguous_bootstrap_candidate",
    "no_existing_candidate",
    "conflict",
]


class ManagedDatabaseTargetIdentity(StrictFrozenModel):
    """Identity of a database target in one explicitly named environment."""

    database_alias: str
    target_type: TargetType
    existing_database_uuid: UUID | None = None
    create_candidate_key: str | None = None

    @model_validator(mode="after")
    def validate_target(self) -> "ManagedDatabaseTargetIdentity":
        if not self.database_alias.strip():
            raise ValueError("database_alias is required")
        choices = (self.existing_database_uuid is not None, self.create_candidate_key is not None)
        if sum(choices) != 1:
            raise ValueError("exactly one existing UUID or create candidate is required")
        return self


class ReviewedBindingMapping(StrictFrozenModel):
    """Explicit human-reviewed mapping supplied outside factual Artifacts."""

    database_alias: str
    provider_uuid: UUID
    model_uuid: UUID


class BindingCandidate(StrictFrozenModel):
    outcome: DiscoveryOutcome
    database_alias: str
    target_type: TargetType
    existing_database_uuid: UUID | None = None
    candidate_ids: tuple[UUID, ...] = ()
    blocking: bool


class BindingDiscovery(StrictFrozenModel):
    provider: BindingCandidate
    model: BindingCandidate


def discover_bindings(
    deployment: DeploymentProfile,
    binding: ModelDeploymentBinding,
    snapshot: DatabaseSnapshot,
    *,
    database_alias: str = "default",
    reviewed_mapping: ReviewedBindingMapping | None = None,
) -> BindingDiscovery:
    """Discover candidates; uniqueness never becomes a reviewed mapping."""

    if reviewed_mapping is not None and reviewed_mapping.database_alias != database_alias:
        return BindingDiscovery(
            provider=_conflict(database_alias, "llm-provider", reviewed_mapping.provider_uuid),
            model=_conflict(database_alias, "llm-model", reviewed_mapping.model_uuid),
        )

    if reviewed_mapping is not None:
        provider = _reviewed(
            database_alias,
            "llm-provider",
            reviewed_mapping.provider_uuid,
            {row.id for row in snapshot.providers},
        )
    else:
        provider = _candidate(
            database_alias,
            "llm-provider",
            [row.id for row in snapshot.providers if row.provider_key == deployment.endpoint_key],
        )

    if reviewed_mapping is not None:
        matching_models = {
            row.id
            for row in snapshot.models
            if row.provider_id == reviewed_mapping.provider_uuid
        }
        model = _reviewed(
            database_alias,
            "llm-model",
            reviewed_mapping.model_uuid,
            matching_models,
        )
    else:
        matching_models = [
            row.id
            for row in snapshot.models
            if row.model_name == binding.upstream_model_id
            and (
                provider.existing_database_uuid is None
                or row.provider_id == provider.existing_database_uuid
            )
        ]
        model = _candidate(database_alias, "llm-model", matching_models)

    return BindingDiscovery(provider=provider, model=model)


def managed_database_target_identity(
    *,
    package_key: str,
    deployment_key: str,
    binding_key: str,
    candidate: BindingCandidate,
) -> ManagedDatabaseTargetIdentity | None:
    """Resolve an existing target or deterministic create candidate without allocation."""

    if candidate.outcome in {"ambiguous_bootstrap_candidate", "conflict"}:
        return None
    if candidate.existing_database_uuid is not None:
        return ManagedDatabaseTargetIdentity(
            database_alias=candidate.database_alias,
            target_type=candidate.target_type,
            existing_database_uuid=candidate.existing_database_uuid,
        )
    seed = "\x1f".join(
        (
            package_key,
            deployment_key,
            binding_key,
            candidate.database_alias,
            candidate.target_type,
        )
    ).encode("utf-8")
    return ManagedDatabaseTargetIdentity(
        database_alias=candidate.database_alias,
        target_type=candidate.target_type,
        create_candidate_key=f"sha256:{hashlib.sha256(seed).hexdigest()}",
    )


def _reviewed(
    database_alias: str,
    target_type: TargetType,
    reviewed_uuid: UUID,
    existing_ids: set[UUID],
) -> BindingCandidate:
    return BindingCandidate(
        outcome="exact_reviewed_binding" if reviewed_uuid in existing_ids else "conflict",
        database_alias=database_alias,
        target_type=target_type,
        existing_database_uuid=reviewed_uuid,
        blocking=reviewed_uuid not in existing_ids,
    )


def _candidate(
    database_alias: str,
    target_type: TargetType,
    ids: list[UUID],
) -> BindingCandidate:
    ordered_ids = tuple(sorted(ids, key=str))
    if not ordered_ids:
        return BindingCandidate(
            outcome="no_existing_candidate",
            database_alias=database_alias,
            target_type=target_type,
            blocking=False,
        )
    if len(ordered_ids) > 1:
        return BindingCandidate(
            outcome="ambiguous_bootstrap_candidate",
            database_alias=database_alias,
            target_type=target_type,
            candidate_ids=ordered_ids,
            blocking=True,
        )
    return BindingCandidate(
        outcome="unique_bootstrap_candidate",
        database_alias=database_alias,
        target_type=target_type,
        existing_database_uuid=ordered_ids[0],
        blocking=False,
    )


def _conflict(
    database_alias: str,
    target_type: TargetType,
    reviewed_uuid: UUID,
) -> BindingCandidate:
    return BindingCandidate(
        outcome="conflict",
        database_alias=database_alias,
        target_type=target_type,
        existing_database_uuid=reviewed_uuid,
        blocking=True,
    )
