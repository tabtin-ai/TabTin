import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

const STORAGE_KEY = 'tabtin.tableEngine.observability.v1';
const STORAGE_VERSION = 1;
const MAX_SAMPLES_PER_SERIES = 240;
const BUCKET_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BUCKETS = 48;
const SCROLL_IDLE_MS = 140;
const MIN_FRAME_DELTA_MS = 4;
const MAX_FRAME_DELTA_MS = 120;

const TABLE_ERROR_HINTS = [
  '/components/table/',
  'datagridadapter',
  'canvastableengine',
  'canvasdatagridexperimental',
  '@tabtin/table-engine',
];

type MetricOperation = 'create' | 'update';

export interface EngineBaselineBucket {
  scrollFpsSamples: number[];
  inputLatencyMsSamples: number[];
  operationTotal: number;
  operationErrors: number;
  runtimeErrors: number;
  updatedAt: number;
}

export interface ObservabilityStore {
  version: number;
  engines: Record<string, EngineBaselineBucket>;
}

export interface TableMetricSeriesSummary {
  count: number;
  latest: number | null;
  average: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export interface TableEngineErrorRateSummary {
  totalOperations: number;
  operationErrors: number;
  runtimeErrors: number;
  ratePct: number;
}

export interface TableEngineObservabilitySummary {
  bucketId: string;
  engineId: string;
  scopeId: string;
  updatedAt: number;
  scrollFps: TableMetricSeriesSummary;
  inputLatencyMs: TableMetricSeriesSummary;
  errorRate: TableEngineErrorRateSummary;
}

export interface TableEngineObservabilitySnapshot {
  version: number;
  currentBucketId: string;
  currentEngineId: string;
  currentScopeId: string;
  current: TableEngineObservabilitySummary | null;
  baseline: Record<string, TableEngineObservabilitySummary>;
}

interface UseTableEngineObservabilityInput {
  engineId: string;
  scopeId?: string | null;
  gridContainerRef: MutableRefObject<HTMLDivElement | null>;
}

interface UseTableEngineObservabilityResult {
  snapshot: TableEngineObservabilitySnapshot;
  markScrollActivity: () => void;
  trackMutationLatency: <T>(
    operation: MetricOperation,
    task: () => Promise<T>,
  ) => Promise<T>;
  reportRendererError: (source: string, error?: unknown) => void;
}

const createEmptyStore = (): ObservabilityStore => ({
  version: STORAGE_VERSION,
  engines: {},
});

const now = (): number => {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
};

const roundTo = (value: number, digits: number = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toNumberArray = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item >= 0);
};

const trimSamples = (samples: number[]): number[] => {
  if (samples.length <= MAX_SAMPLES_PER_SERIES) {
    return samples;
  }
  return samples.slice(samples.length - MAX_SAMPLES_PER_SERIES);
};

const appendSample = (samples: number[], value: number): number[] => {
  if (!Number.isFinite(value) || value < 0) {
    return samples;
  }
  return trimSamples([...samples, value]);
};

const percentile = (input: number[], ratio: number): number | null => {
  if (input.length === 0) {
    return null;
  }

  const sorted = [...input].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return roundTo(sorted[index]);
};

const average = (input: number[]): number | null => {
  if (input.length === 0) {
    return null;
  }
  const total = input.reduce((sum, value) => sum + value, 0);
  return roundTo(total / input.length);
};

const summarizeSeries = (input: number[]): TableMetricSeriesSummary => {
  const values = input.filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    return {
      count: 0,
      latest: null,
      average: null,
      p50: null,
      p95: null,
      min: null,
      max: null,
    };
  }

  return {
    count: values.length,
    latest: roundTo(values[values.length - 1]),
    average: average(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: roundTo(Math.min(...values)),
    max: roundTo(Math.max(...values)),
  };
};

export const normalizeBucket = (raw: unknown): EngineBaselineBucket => {
  const source =
    raw && typeof raw === 'object'
      ? (raw as Partial<EngineBaselineBucket>)
      : {};
  return {
    scrollFpsSamples: trimSamples(toNumberArray(source.scrollFpsSamples)),
    inputLatencyMsSamples: trimSamples(
      toNumberArray(source.inputLatencyMsSamples),
    ),
    operationTotal: Number.isFinite(Number(source.operationTotal))
      ? Math.max(0, Math.floor(Number(source.operationTotal)))
      : 0,
    operationErrors: Number.isFinite(Number(source.operationErrors))
      ? Math.max(0, Math.floor(Number(source.operationErrors)))
      : 0,
    runtimeErrors: Number.isFinite(Number(source.runtimeErrors))
      ? Math.max(0, Math.floor(Number(source.runtimeErrors)))
      : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt))
      ? Number(source.updatedAt)
      : 0,
  };
};

export const normalizeStore = (raw: unknown): ObservabilityStore => {
  if (!raw || typeof raw !== 'object') {
    return createEmptyStore();
  }

  const source = raw as Partial<ObservabilityStore> & {
    engines?: Record<string, unknown>;
  };
  const normalizedEngines: Record<string, EngineBaselineBucket> = {};

  if (source.engines && typeof source.engines === 'object') {
    for (const [engineId, bucket] of Object.entries(source.engines)) {
      if (typeof engineId !== 'string' || engineId.trim().length === 0) {
        continue;
      }
      normalizedEngines[engineId] = normalizeBucket(bucket);
    }
  }

  return {
    version: STORAGE_VERSION,
    engines: normalizedEngines,
  };
};

export const pruneObservabilityStore = (
  raw: unknown,
  options: {
    now?: number;
    ttlMs?: number;
    maxBuckets?: number;
  } = {},
): ObservabilityStore => {
  const normalized = normalizeStore(raw);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? BUCKET_TTL_MS;
  const maxBuckets = options.maxBuckets ?? MAX_BUCKETS;

  const engines = Object.fromEntries(
    Object.entries(normalized.engines)
      .filter(([, bucket]) => {
        if (!Number.isFinite(bucket.updatedAt) || bucket.updatedAt <= 0) {
          return false;
        }
        return now - bucket.updatedAt <= ttlMs;
      })
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, maxBuckets),
  );

  return {
    version: STORAGE_VERSION,
    engines,
  };
};

const readStore = (): ObservabilityStore => {
  if (typeof window === 'undefined') {
    return createEmptyStore();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createEmptyStore();
    }

    return pruneObservabilityStore(JSON.parse(raw));
  } catch {
    return createEmptyStore();
  }
};

const writeStore = (store: ObservabilityStore): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(pruneObservabilityStore(store)),
    );
  } catch {
    // ignore write failures (private mode / quota)
  }
};

const ensureBucket = (
  store: ObservabilityStore,
  bucketId: string,
): EngineBaselineBucket => {
  const normalizedId = bucketId.trim().toLowerCase() || 'unknown::global';
  if (!store.engines[normalizedId]) {
    store.engines[normalizedId] = normalizeBucket({});
  }
  return store.engines[normalizedId];
};

const normalizeScopeId = (scopeId: string | null | undefined): string => {
  const normalized = typeof scopeId === 'string' ? scopeId.trim().toLowerCase() : '';
  return normalized || 'global';
};

const buildBucketId = (engineId: string, scopeId: string | null | undefined): string => {
  const normalizedEngineId = engineId.trim().toLowerCase() || 'unknown';
  return `${normalizedEngineId}::${normalizeScopeId(scopeId)}`;
};

const parseBucketId = (
  bucketId: string,
): { engineId: string; scopeId: string } => {
  const [rawEngineId, ...rest] = bucketId.split('::');
  const engineId = rawEngineId?.trim().toLowerCase() || 'unknown';
  const scopeId = normalizeScopeId(rest.join('::'));
  return { engineId, scopeId };
};

const createEngineSummary = (
  bucketId: string,
  bucket: EngineBaselineBucket,
): TableEngineObservabilitySummary => {
  const { engineId, scopeId } = parseBucketId(bucketId);
  const totalSamples = bucket.operationTotal + bucket.runtimeErrors;
  const errorCount = bucket.operationErrors + bucket.runtimeErrors;
  const ratePct =
    totalSamples > 0 ? roundTo((errorCount / totalSamples) * 100) : 0;

  return {
    bucketId,
    engineId,
    scopeId,
    updatedAt: bucket.updatedAt,
    scrollFps: summarizeSeries(bucket.scrollFpsSamples),
    inputLatencyMs: summarizeSeries(bucket.inputLatencyMsSamples),
    errorRate: {
      totalOperations: bucket.operationTotal,
      operationErrors: bucket.operationErrors,
      runtimeErrors: bucket.runtimeErrors,
      ratePct,
    },
  };
};

const buildSnapshot = (
  store: ObservabilityStore,
  currentBucketId: string,
): TableEngineObservabilitySnapshot => {
  const normalizedStore = pruneObservabilityStore(store);
  const baseline: Record<string, TableEngineObservabilitySummary> = {};

  for (const [bucketId, bucket] of Object.entries(normalizedStore.engines)) {
    baseline[bucketId] = createEngineSummary(bucketId, bucket);
  }

  const normalizedCurrentBucketId = currentBucketId.trim().toLowerCase() || 'unknown::global';
  const { engineId, scopeId } = parseBucketId(normalizedCurrentBucketId);
  const current = baseline[normalizedCurrentBucketId] ?? null;

  return {
    version: STORAGE_VERSION,
    currentBucketId: normalizedCurrentBucketId,
    currentEngineId: engineId,
    currentScopeId: scopeId,
    current,
    baseline,
  };
};

const normalizeErrorText = (value: unknown): string => {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const isTableRelatedError = (text: string): boolean => {
  if (!text) {
    return false;
  }

  const normalizedText = text.toLowerCase();
  return TABLE_ERROR_HINTS.some((hint) => normalizedText.includes(hint));
};

const updateWindowSnapshot = (
  snapshot: TableEngineObservabilitySnapshot,
): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const rows = Object.values(snapshot.baseline).map((item) => ({
    bucket: item.bucketId,
    engine: item.engineId,
    scope: item.scopeId,
    scrollFpsP95: item.scrollFps.p95,
    inputLatencyP95Ms: item.inputLatencyMs.p95,
    errorRatePct: item.errorRate.ratePct,
    operations: item.errorRate.totalOperations,
    operationErrors: item.errorRate.operationErrors,
    runtimeErrors: item.errorRate.runtimeErrors,
    updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : '-',
  }));

  window.__TABTIN_TABLE_ENGINE_METRICS__ = snapshot;
  window.__TABTIN_TABLE_ENGINE_METRICS_PRINT__ = () => {
    console.table(rows);
    return snapshot;
  };

  window.dispatchEvent(
    new CustomEvent('tabtin:table-engine-metrics', { detail: snapshot }),
  );
};

const isMetricsDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return (
      window.localStorage.getItem('tabtin.tableEngineMetricsDebug') === '1'
    );
  } catch {
    return false;
  }
};

export const useTableEngineObservability = ({
  engineId,
  scopeId,
  gridContainerRef,
}: UseTableEngineObservabilityInput): UseTableEngineObservabilityResult => {
  const normalizedEngineId = useMemo(
    () => engineId.trim().toLowerCase() || 'unknown',
    [engineId],
  );
  const normalizedScopeId = useMemo(
    () => normalizeScopeId(scopeId),
    [scopeId],
  );
  const currentBucketId = useMemo(
    () => buildBucketId(normalizedEngineId, normalizedScopeId),
    [normalizedEngineId, normalizedScopeId],
  );
  const storeRef = useRef<ObservabilityStore>(readStore());
  const [revision, setRevision] = useState(0);

  const frameRafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const lastScrollTsRef = useRef(0);
  const frameDeltasRef = useRef<number[]>([]);

  const persist = useCallback(() => {
    storeRef.current = pruneObservabilityStore(storeRef.current);
    writeStore(storeRef.current);
    setRevision((value) => value + 1);
  }, []);

  const recordRuntimeError = useCallback(
    (source: string, error?: unknown) => {
      const bucket = ensureBucket(storeRef.current, currentBucketId);
      bucket.runtimeErrors += 1;
      bucket.updatedAt = Date.now();
      persist();

      if (isMetricsDebugEnabled()) {
        console.error(
          `[table-engine-observability][${currentBucketId}] ${source}`,
          error,
        );
      }
    },
    [currentBucketId, persist],
  );

  const recordScrollFpsSample = useCallback(
    (fps: number) => {
      if (!Number.isFinite(fps) || fps <= 0) {
        return;
      }

      const bucket = ensureBucket(storeRef.current, currentBucketId);
      bucket.scrollFpsSamples = appendSample(bucket.scrollFpsSamples, fps);
      bucket.updatedAt = Date.now();
      persist();
    },
    [currentBucketId, persist],
  );

  const flushScrollSampling = useCallback(() => {
    const fpsSamples = frameDeltasRef.current
      .filter(
        (delta) => delta >= MIN_FRAME_DELTA_MS && delta <= MAX_FRAME_DELTA_MS,
      )
      .map((delta) => 1000 / delta);

    frameDeltasRef.current = [];
    lastFrameTsRef.current = null;

    if (fpsSamples.length === 0) {
      return;
    }

    const avgFps =
      fpsSamples.reduce((sum, fps) => sum + fps, 0) / fpsSamples.length;
    recordScrollFpsSample(avgFps);
  }, [recordScrollFpsSample]);

  const stopScrollSampling = useCallback(() => {
    if (
      frameRafRef.current != null &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(frameRafRef.current);
    }
    frameRafRef.current = null;
    flushScrollSampling();
  }, [flushScrollSampling]);

  const stepScrollSampling = useCallback(
    (timestamp: number) => {
      if (lastFrameTsRef.current != null) {
        frameDeltasRef.current.push(timestamp - lastFrameTsRef.current);
      }
      lastFrameTsRef.current = timestamp;

      if (timestamp - lastScrollTsRef.current > SCROLL_IDLE_MS) {
        stopScrollSampling();
        return;
      }

      frameRafRef.current = requestAnimationFrame(stepScrollSampling);
    },
    [stopScrollSampling],
  );

  const markScrollActivity = useCallback(() => {
    if (
      typeof window === 'undefined' ||
      typeof requestAnimationFrame !== 'function'
    ) {
      return;
    }

    lastScrollTsRef.current = now();

    if (frameRafRef.current != null) {
      return;
    }

    frameDeltasRef.current = [];
    lastFrameTsRef.current = null;
    frameRafRef.current = requestAnimationFrame(stepScrollSampling);
  }, [stepScrollSampling]);

  const trackMutationLatency = useCallback(
    async <T>(
      operation: MetricOperation,
      task: () => Promise<T>,
    ): Promise<T> => {
      const startedAt = now();
      let hasError = false;

      try {
        const result = await task();
        const duration = now() - startedAt;
        const bucket = ensureBucket(storeRef.current, currentBucketId);
        bucket.operationTotal += 1;

        if (result == null) {
          bucket.operationErrors += 1;
        }

        bucket.inputLatencyMsSamples = appendSample(
          bucket.inputLatencyMsSamples,
          duration,
        );
        bucket.updatedAt = Date.now();
        persist();

        return result;
      } catch (error) {
        hasError = true;
        const duration = now() - startedAt;
        const bucket = ensureBucket(storeRef.current, currentBucketId);
        bucket.operationTotal += 1;
        bucket.operationErrors += 1;
        bucket.inputLatencyMsSamples = appendSample(
          bucket.inputLatencyMsSamples,
          duration,
        );
        bucket.updatedAt = Date.now();
        persist();

        if (isMetricsDebugEnabled()) {
          console.error(
            `[table-engine-observability][${currentBucketId}] ${operation} failed`,
            error,
          );
        }

        throw error;
      } finally {
        if (!hasError && isMetricsDebugEnabled()) {
          const bucket = storeRef.current.engines[currentBucketId];
          if (bucket && bucket.operationTotal % 25 === 0) {
            console.info(
              `[table-engine-observability][${currentBucketId}] operation samples: ${bucket.operationTotal}`,
            );
          }
        }
      }
    },
    [currentBucketId, persist],
  );

  const reportRendererError = useCallback(
    (source: string, error?: unknown) => {
      recordRuntimeError(source, error);
    },
    [recordRuntimeError],
  );

  useEffect(() => {
    ensureBucket(storeRef.current, currentBucketId);
    persist();
  }, [currentBucketId, persist]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const container = gridContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      markScrollActivity();
    };

    container.addEventListener('scroll', handleScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      container.removeEventListener('scroll', handleScroll, true);
    };
  }, [gridContainerRef, markScrollActivity]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleWindowError = (event: ErrorEvent) => {
      const text = [
        event.message,
        event.filename,
        normalizeErrorText(event.error),
      ]
        .filter(Boolean)
        .join('\n');
      if (isTableRelatedError(text)) {
        recordRuntimeError('window.error', event.error ?? event.message);
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const text = normalizeErrorText(event.reason);
      if (isTableRelatedError(text)) {
        recordRuntimeError('window.unhandledrejection', event.reason);
      }
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener(
        'unhandledrejection',
        handleUnhandledRejection,
      );
    };
  }, [recordRuntimeError]);

  useEffect(() => {
    return () => {
      stopScrollSampling();
    };
  }, [stopScrollSampling]);

  const snapshot = useMemo(
    () => buildSnapshot(storeRef.current, currentBucketId),
    [currentBucketId, revision],
  );

  useEffect(() => {
    updateWindowSnapshot(snapshot);
  }, [snapshot]);

  return {
    snapshot,
    markScrollActivity,
    trackMutationLatency,
    reportRendererError,
  };
};
