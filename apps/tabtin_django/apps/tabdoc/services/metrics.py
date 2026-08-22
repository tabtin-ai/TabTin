from __future__ import annotations

from dataclasses import dataclass, field
from statistics import quantiles
from threading import Lock
from typing import Any


@dataclass
class TabdocMetrics:
    """Tabdoc 轻量指标聚合器（进程内）。"""

    save_attempts: int = 0
    save_successes: int = 0
    save_conflicts: int = 0
    save_failures: int = 0

    search_requests: int = 0
    search_latency_total_ms: float = 0.0
    search_latency_samples_ms: list[float] = field(default_factory=list)

    import_attempts: int = 0
    import_successes: int = 0
    import_failures: int = 0

    _lock: Lock = field(default_factory=Lock, repr=False)

    def record_save_success(self) -> None:
        with self._lock:
            self.save_attempts += 1
            self.save_successes += 1

    def record_save_conflict(self) -> None:
        with self._lock:
            self.save_attempts += 1
            self.save_conflicts += 1

    def record_save_failure(self) -> None:
        with self._lock:
            self.save_attempts += 1
            self.save_failures += 1

    def record_search_latency(self, latency_ms: float) -> None:
        normalized = max(0.0, float(latency_ms or 0.0))
        with self._lock:
            self.search_requests += 1
            self.search_latency_total_ms += normalized
            self.search_latency_samples_ms.append(normalized)
            if len(self.search_latency_samples_ms) > 500:
                self.search_latency_samples_ms = self.search_latency_samples_ms[-500:]

    def record_import_success(self) -> None:
        with self._lock:
            self.import_attempts += 1
            self.import_successes += 1

    def record_import_failure(self) -> None:
        with self._lock:
            self.import_attempts += 1
            self.import_failures += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            save_attempts = self.save_attempts
            save_successes = self.save_successes
            save_conflicts = self.save_conflicts
            save_failures = self.save_failures

            search_requests = self.search_requests
            search_total = self.search_latency_total_ms
            search_samples = list(self.search_latency_samples_ms)

            import_attempts = self.import_attempts
            import_successes = self.import_successes
            import_failures = self.import_failures

        save_success_rate = (save_successes / save_attempts) if save_attempts else 0.0
        import_failure_rate = (import_failures / import_attempts) if import_attempts else 0.0
        search_avg_ms = (search_total / search_requests) if search_requests else 0.0
        if len(search_samples) >= 2:
            p95 = quantiles(search_samples, n=100)[94]
        elif len(search_samples) == 1:
            p95 = search_samples[0]
        else:
            p95 = 0.0

        return {
            "save": {
                "attempts": save_attempts,
                "successes": save_successes,
                "conflicts": save_conflicts,
                "failures": save_failures,
                "success_rate": round(save_success_rate, 4),
            },
            "search": {
                "requests": search_requests,
                "avg_latency_ms": round(search_avg_ms, 2),
                "p95_latency_ms": round(float(p95), 2),
            },
            "import": {
                "attempts": import_attempts,
                "successes": import_successes,
                "failures": import_failures,
                "failure_rate": round(import_failure_rate, 4),
            },
        }

    def reset(self) -> None:
        with self._lock:
            self.save_attempts = 0
            self.save_successes = 0
            self.save_conflicts = 0
            self.save_failures = 0

            self.search_requests = 0
            self.search_latency_total_ms = 0.0
            self.search_latency_samples_ms.clear()

            self.import_attempts = 0
            self.import_successes = 0
            self.import_failures = 0


_tabdoc_metrics = TabdocMetrics()


def get_tabdoc_metrics() -> TabdocMetrics:
    return _tabdoc_metrics


__all__ = ["TabdocMetrics", "get_tabdoc_metrics"]
