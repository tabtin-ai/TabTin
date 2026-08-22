"""Exact reference closure, cycles, and reverse-reference index."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from .domain.identities import ArtifactIdentity, ExactRef
from .loading.registry import ArtifactRegistry, RegistryIssue


@dataclass(frozen=True)
class ReferenceIssue:
    code: str
    message: str
    path: str
    related: tuple[ArtifactIdentity, ...] = ()


def _refs(value: Any, path: str = "") -> list[tuple[ExactRef, str]]:
    found: list[tuple[ExactRef, str]] = []
    if isinstance(value, ExactRef): found.append((value, path))
    elif isinstance(value, BaseModel):
        for name in value.model_fields:
            found.extend(_refs(getattr(value, name), f"{path}.{name}" if path else name))
    elif isinstance(value, (tuple, list)):
        for index, item in enumerate(value): found.extend(_refs(item, f"{path}[{index}]"))
    return found


class ReferenceGraph:
    def __init__(self, registry: ArtifactRegistry):
        self.registry = registry
        self.edges: dict[tuple[str, str, str], tuple[tuple[tuple[str, str, str], str], ...]] = {}
        self.reverse: dict[tuple[str, str, str], tuple[tuple[tuple[str, str, str], str], ...]] = {}
        self.issues: tuple[ReferenceIssue, ...] = ()

    def build(self, roots: tuple[BaseModel, ...] | list[BaseModel]) -> tuple[BaseModel, ...]:
        issues: list[ReferenceIssue] = []
        loaded: dict[tuple[str, str, str], BaseModel] = {}
        reverse: dict[tuple[str, str, str], list[tuple[tuple[str, str, str], str]]] = {}
        pending = list(sorted(roots, key=lambda item: (item.identity.kind, item.identity.key, item.identity.revision)))
        while pending:
            artifact = pending.pop(0)
            source = artifact.identity
            source_key = (source.kind, source.key, source.revision)
            if source_key in loaded: continue
            loaded[source_key] = artifact
            unique: dict[tuple[str, str, str], str] = {}
            for ref, path in _refs(artifact):
                target_key = (ref.kind, ref.key, ref.revision)
                unique.setdefault(target_key, path)
            edges = []
            for target_key, path in sorted(unique.items()):
                ref = next(r for r, p in _refs(artifact) if (r.kind, r.key, r.revision) == target_key and p == path)
                try:
                    target = self.registry.load_exact(ref.kind, ref.key, ref.revision, ref.expected_hash)
                    pending.append(target)
                    edges.append((target_key, path))
                    reverse.setdefault(target_key, []).append((source_key, path))
                except Exception as exc:
                    issue = exc.issue if hasattr(exc, "issue") else RegistryIssue("reference_load_error", str(exc))
                    issues.append(ReferenceIssue(issue.code, issue.message, path))
            self.edges[source_key] = tuple(edges)
        issues.extend(self._cycles(loaded))
        self.reverse = {k: tuple(sorted(v)) for k, v in sorted(reverse.items())}
        self.issues = tuple(sorted(issues, key=lambda i: (i.code, i.path, i.message)))
        return tuple(loaded[key] for key in sorted(loaded))

    def _cycles(self, loaded: dict[tuple[str, str, str], BaseModel]) -> list[ReferenceIssue]:
        issues: list[ReferenceIssue] = []
        visiting: list[tuple[str, str, str]] = []
        done: set[tuple[str, str, str]] = set()
        def visit(node: tuple[str, str, str]) -> None:
            if node in visiting:
                cycle = visiting[visiting.index(node):] + [node]
                issues.append(ReferenceIssue("dependency_cycle", "dependency cycle: " + " -> ".join(":".join(x) for x in cycle), "graph"))
                return
            if node in done: return
            visiting.append(node)
            for child, _ in self.edges.get(node, ()): visit(child)
            visiting.pop(); done.add(node)
        for node in sorted(loaded): visit(node)
        return issues

