"""Exact, deterministic in-memory artifact registry."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from pydantic import BaseModel

from ..canonical import calculate_canonical_hash
from ..domain.identities import ArtifactIdentity
from .loader import ArtifactLoadError, load_artifact_file


@dataclass(frozen=True)
class RegistryIssue:
    code: str
    message: str
    path: str | None = None


class RegistryError(ValueError):
    def __init__(self, issue: RegistryIssue):
        super().__init__(issue.message)
        self.issue = issue


_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")


class ArtifactRegistry:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self._items: dict[tuple[str, str, str], BaseModel] = {}
        self._paths: dict[tuple[str, str, str], Path] = {}
        self.issues: tuple[RegistryIssue, ...] = ()
        self._index()

    def _index(self) -> None:
        issues: list[RegistryIssue] = []
        files = sorted(p for p in self.root.rglob("*") if p.is_file() and p.suffix in {".json", ".yaml", ".yml"})
        for path in files:
            try:
                resolved = path.resolve(strict=True)
                if self.root not in resolved.parents: raise RegistryError(RegistryIssue("path_escape", "artifact escapes configured root", str(path)))
                artifact = load_artifact_file(path)
                identity = artifact.identity
                key = (identity.kind, identity.key, identity.revision)
                expected_parts = path.relative_to(self.root).parts
                if len(expected_parts) >= 4 and expected_parts[-4:-1] == (identity.kind, identity.key, identity.revision):
                    pass
                elif len(expected_parts) >= 3 and expected_parts[-3:-1] == (identity.key, identity.revision):
                    pass
                else:
                    raise RegistryError(RegistryIssue("path_identity_mismatch", "file path does not match artifact identity", str(path)))
                if len(expected_parts) >= 6:
                    protocol_dir, role_dir = expected_parts[-6], expected_parts[-5]
                    protocol = getattr(artifact, "protocol_type", None)
                    role = getattr(artifact, "mapping_role", None)
                    if protocol is not None and protocol_dir != protocol:
                        raise RegistryError(RegistryIssue("protocol_directory_mismatch", "protocol directory does not match artifact protocol", str(path)))
                    if role is not None and role_dir != role:
                        raise RegistryError(RegistryIssue("mapping_role_directory_mismatch", "mapping role directory does not match artifact role", str(path)))
                if key in self._items:
                    existing_hash = calculate_canonical_hash(self._items[key])
                    incoming_hash = calculate_canonical_hash(artifact)
                    code = "duplicate_identity" if existing_hash == incoming_hash else "conflicting_identity"
                    message = "duplicate logical artifact identity" if code == "duplicate_identity" else "same identity has different content"
                    raise RegistryError(RegistryIssue(code, message, str(path)))
                self._items[key] = artifact
                self._paths[key] = path
            except (ArtifactLoadError, RegistryError) as exc:
                issues.append(exc.issue if isinstance(exc, RegistryError) else RegistryIssue("load_error", str(exc), str(path)))
        self.issues = tuple(sorted(issues, key=lambda issue: (issue.code, issue.path or "")))

    def load_exact(self, kind: str, key: str, revision: str, expected_hash: str) -> BaseModel:
        if not all((kind, key, revision, expected_hash)) or revision == "latest" or not _HASH.fullmatch(expected_hash):
            raise RegistryError(RegistryIssue("invalid_exact_reference", "kind, key, revision and full SHA-256 hash are required"))
        identity_key = (kind, key, revision)
        artifact = self._items.get(identity_key)
        if artifact is None:
            raise RegistryError(RegistryIssue("missing_artifact", "exact artifact was not found"))
        actual = calculate_canonical_hash(artifact)
        if actual != expected_hash:
            raise RegistryError(RegistryIssue("hash_mismatch", "artifact hash does not match expected hash", str(self._paths[identity_key])))
        return artifact

    def items(self) -> tuple[BaseModel, ...]:
        return tuple(self._items[key] for key in sorted(self._items))
