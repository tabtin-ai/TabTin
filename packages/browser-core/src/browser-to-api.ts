import type { NetworkLogEntry } from './runtime/NetworkLog';

export interface BrowserToApiOptions {
  title?: string;
  version?: string;
}

export interface BrowserToApiResult {
  openapi: '3.1.0';
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  'x-tabtin-browser-to-api': {
    source: 'network-log';
    entryCount: number;
    analyzedEntryCount: number;
    ignoredEntryCount: number;
    traceCompatibility: {
      reads: 'NetworkLogEntry[]';
      readsProjectedTraceNetworkData: boolean;
    };
  };
}

export interface OpenApiOperation {
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: Record<string, { schema: JsonSchema }>;
    'x-tabtin-inferred'?: InferenceMetadata;
  };
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, { schema: JsonSchema }>;
    }
  >;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  'x-tabtin-sample-derived'?: boolean;
  'x-tabtin-inferred'?: InferenceMetadata;
};

export interface InferenceMetadata {
  source: 'network-samples';
  sampleCount: number;
  missingBodyCount?: number;
  truncatedBodyCount?: number;
}

type EntryWithParsedUrl = NetworkLogEntry & {
  parsedUrl: URL;
  pathTemplate: string;
  pathParams: string[];
};

const JSON_CONTENT_TYPE_RE = /(^|[/+])json($|;)/i;
const SENSITIVE_KEY_RE =
  /(?:^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|auth|cookie|session|csrf|xsrf|credential)(?:$|[_-])/i;

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function analyzeBrowserNetworkToOpenApi(
  input: unknown,
  options: BrowserToApiOptions = {},
): BrowserToApiResult {
  const entries = normalizeBrowserNetworkEntries(input);
  const usable = entries
    .map((entry) => withParsedUrl(entry))
    .filter((entry): entry is EntryWithParsedUrl => Boolean(entry))
    .filter((entry) => shouldAnalyzeEntry(entry));

  const servers = Array.from(
    new Set(usable.map((entry) => entry.parsedUrl.origin)),
  ).sort();
  const groups = new Map<string, EntryWithParsedUrl[]>();
  for (const entry of usable) {
    const key = `${entry.method.toUpperCase()} ${entry.pathTemplate}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  const paths: BrowserToApiResult['paths'] = {};
  for (const groupEntries of groups.values()) {
    const first = groupEntries[0];
    const method = first.method.toLowerCase();
    const pathItem = paths[first.pathTemplate] ?? {};
    pathItem[method] = buildOperation(first.pathTemplate, method, groupEntries);
    paths[first.pathTemplate] = pathItem;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title || 'TabTin Browser Observed API',
      version: options.version || '0.1.0',
    },
    ...(servers.length > 0 ? { servers: servers.map((url) => ({ url })) } : {}),
    paths: sortObject(paths),
    'x-tabtin-browser-to-api': {
      source: 'network-log',
      entryCount: entries.length,
      analyzedEntryCount: usable.length,
      ignoredEntryCount: entries.length - usable.length,
      traceCompatibility: {
        reads: 'NetworkLogEntry[]',
        readsProjectedTraceNetworkData: true,
      },
    },
  };
}

export function normalizeBrowserNetworkEntries(
  input: unknown,
): NetworkLogEntry[] {
  if (Array.isArray(input))
    return input.map(normalizeEntry).filter(isNetworkLogEntry);
  if (!input || typeof input !== 'object') return [];

  const obj = input as Record<string, unknown>;
  const candidates = [
    obj.data,
    (obj.data as Record<string, unknown> | undefined)?.data,
    (obj.data as Record<string, unknown> | undefined)?.requests,
    obj.requests,
    obj.entries,
    obj.result,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate))
      return candidate.map(normalizeEntry).filter(isNetworkLogEntry);
  }

  if (
    typeof obj.type === 'string' &&
    obj.type.startsWith('network.') &&
    obj.data
  ) {
    const entry = normalizeEntry(obj.data);
    return isNetworkLogEntry(entry) ? [entry] : [];
  }

  return [];
}

function normalizeEntry(value: unknown): NetworkLogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const data =
    typeof obj.type === 'string' && obj.type.startsWith('network.') && obj.data
      ? (obj.data as Record<string, unknown>)
      : obj;
  const method =
    typeof data.method === 'string' ? data.method.toUpperCase() : undefined;
  const url = typeof data.url === 'string' ? data.url : undefined;
  if (!method || !url) return null;
  const requestHeaders = asStringRecord(data.requestHeaders);
  const responseHeaders = asStringRecord(data.responseHeaders);
  return {
    requestId:
      typeof data.requestId === 'string' ? data.requestId : `${method}:${url}`,
    url,
    method,
    ...(typeof data.status === 'number' ? { status: data.status } : {}),
    ...(typeof data.resourceType === 'string'
      ? { resourceType: data.resourceType }
      : {}),
    ...(typeof data.mimeType === 'string' ? { mimeType: data.mimeType } : {}),
    ...(typeof data.size === 'number' ? { size: data.size } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(typeof data.requestBody === 'string'
      ? { requestBody: data.requestBody }
      : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(typeof data.responseBody === 'string'
      ? { responseBody: data.responseBody }
      : {}),
    ...(typeof data.responseBodyBase64Encoded === 'boolean'
      ? { responseBodyBase64Encoded: data.responseBodyBase64Encoded }
      : {}),
    ...(typeof data.bodyTruncated === 'boolean'
      ? { bodyTruncated: data.bodyTruncated }
      : {}),
    ...(typeof data.responseBodyError === 'string'
      ? { responseBodyError: data.responseBodyError }
      : {}),
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
    ...(typeof data.runId === 'string' ? { runId: data.runId } : {}),
  };
}

function isNetworkLogEntry(
  value: NetworkLogEntry | null,
): value is NetworkLogEntry {
  return Boolean(value?.url && value?.method);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || child === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof child))
      return undefined;
    out[key] = String(child);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function withParsedUrl(entry: NetworkLogEntry): EntryWithParsedUrl | null {
  try {
    const parsedUrl = new URL(entry.url);
    const { pathTemplate, pathParams } = templatePath(parsedUrl.pathname);
    return {
      ...entry,
      method: entry.method.toUpperCase(),
      parsedUrl,
      pathTemplate,
      pathParams,
    };
  } catch {
    return null;
  }
}

function shouldAnalyzeEntry(entry: EntryWithParsedUrl): boolean {
  if (!/^https?:$/.test(entry.parsedUrl.protocol)) return false;
  if (entry.responseBodyBase64Encoded) return false;
  const resourceType = entry.resourceType?.toLowerCase();
  if (
    resourceType &&
    ['image', 'font', 'stylesheet', 'media'].includes(resourceType)
  )
    return false;
  const mimeType = entry.mimeType?.toLowerCase() ?? '';
  if (
    mimeType &&
    !JSON_CONTENT_TYPE_RE.test(mimeType) &&
    !mimeType.startsWith('text/') &&
    !mimeType.includes('graphql')
  ) {
    return false;
  }
  return true;
}

function templatePath(pathname: string): {
  pathTemplate: string;
  pathParams: string[];
} {
  const rawSegments = pathname.split('/').filter(Boolean);
  const pathParams: string[] = [];
  const paramCounts = new Map<string, number>();
  const segments = rawSegments.map((segment, index) => {
    const decoded = safeDecode(segment);
    if (!looksDynamicSegment(decoded)) return encodePathSegment(decoded);
    const base = parameterBaseName(rawSegments[index - 1], decoded);
    const count = (paramCounts.get(base) ?? 0) + 1;
    paramCounts.set(base, count);
    const name = count === 1 ? base : `${base}${count}`;
    pathParams.push(name);
    return `{${name}}`;
  });
  return { pathTemplate: `/${segments.join('/')}`, pathParams };
}

function looksDynamicSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segment,
    ) ||
    /^[0-9a-f]{16,}$/i.test(segment) ||
    looksTokenSegment(segment) ||
    /^[A-Za-z0-9_-]{18,}$/.test(segment)
  );
}

function looksTokenSegment(segment: string): boolean {
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment)) {
    return true;
  }
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(segment)) {
    const hasMixedAlphabet = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
    const hasDigit = /\d/.test(segment);
    return hasMixedAlphabet && hasDigit;
  }
  return false;
}

function parameterBaseName(
  previousRaw: string | undefined,
  value: string,
): string {
  if (looksTokenSegment(value)) return 'token';
  if (/^[0-9a-f-]{32,36}$/i.test(value)) return 'id';
  const previous = previousRaw
    ? safeDecode(previousRaw).replace(/[^A-Za-z0-9_-]/g, '')
    : '';
  if (!previous) return 'id';
  const singular = previous.endsWith('ies')
    ? `${previous.slice(0, -3)}y`
    : previous.endsWith('s')
      ? previous.slice(0, -1)
      : previous;
  const camel = singular.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) =>
    c.toUpperCase(),
  );
  return `${camel || 'id'}Id`;
}

function buildOperation(
  pathTemplate: string,
  method: string,
  entries: EntryWithParsedUrl[],
): OpenApiOperation {
  const parameters = buildParameters(entries);
  const requestBody = buildRequestBody(entries);
  const responses = buildResponses(entries);
  return {
    operationId: operationIdFor(method, pathTemplate),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
}

function buildParameters(entries: EntryWithParsedUrl[]): OpenApiParameter[] {
  const first = entries[0];
  const parameters: OpenApiParameter[] = first.pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: name.toLowerCase().includes('id') ? 'string' : 'string' },
  }));

  const queryValues = new Map<string, unknown[]>();
  for (const entry of entries) {
    for (const [key, value] of entry.parsedUrl.searchParams.entries()) {
      if (isSensitiveKey(key)) continue;
      const values = queryValues.get(key) ?? [];
      values.push(coerceScalar(value));
      queryValues.set(key, values);
    }
  }

  for (const [name, values] of Array.from(queryValues.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    parameters.push({
      name,
      in: 'query',
      required: entries.every((entry) =>
        entry.parsedUrl.searchParams.has(name),
      ),
      schema: mergeSchemas(values.map(inferJsonSchema)),
    });
  }
  return parameters;
}

function buildRequestBody(
  entries: EntryWithParsedUrl[],
): OpenApiOperation['requestBody'] | undefined {
  const bodyEntries = entries.filter((entry) =>
    METHODS_WITH_BODY.has(entry.method),
  );
  if (bodyEntries.length === 0) return undefined;

  const parsedByContentType = new Map<string, unknown[]>();
  let missingBodyCount = 0;
  let truncatedBodyCount = 0;
  for (const entry of bodyEntries) {
    if (entry.bodyTruncated) truncatedBodyCount += 1;
    const parsed = parseBody(entry.requestBody);
    if (!parsed) {
      missingBodyCount += 1;
      continue;
    }
    const values = parsedByContentType.get(parsed.contentType) ?? [];
    values.push(parsed.value);
    parsedByContentType.set(parsed.contentType, values);
  }
  if (parsedByContentType.size === 0) return undefined;

  const content: Record<string, { schema: JsonSchema }> = {};
  for (const [contentType, values] of Array.from(
    parsedByContentType.entries(),
  ).sort(([a], [b]) => a.localeCompare(b))) {
    const schema = inferPayloadSchema(values);
    if (schema) content[contentType] = { schema };
  }
  if (Object.keys(content).length === 0) return undefined;

  return {
    // Observed samples prove a body can exist, not that every valid request requires one.
    required: false,
    content,
    'x-tabtin-inferred': {
      source: 'network-samples',
      sampleCount: bodyEntries.length,
      ...(missingBodyCount > 0 ? { missingBodyCount } : {}),
      ...(truncatedBodyCount > 0 ? { truncatedBodyCount } : {}),
    },
  };
}

function buildResponses(
  entries: EntryWithParsedUrl[],
): OpenApiOperation['responses'] {
  const byStatus = new Map<string, unknown[]>();
  for (const entry of entries) {
    const status = entry.status ? String(entry.status) : 'default';
    const values = byStatus.get(status) ?? [];
    const parsed = parseBody(entry.responseBody);
    if (parsed !== undefined) values.push(parsed.value);
    byStatus.set(status, values);
  }
  if (byStatus.size === 0) {
    return { default: { description: 'Observed response' } };
  }

  const responses: OpenApiOperation['responses'] = {};
  for (const [status, values] of Array.from(byStatus.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const schema = inferPayloadSchema(values);
    responses[status] = {
      description:
        status === 'default'
          ? 'Observed response'
          : `Observed HTTP ${status} response`,
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    };
  }
  return responses;
}

function parseBody(
  body: string | undefined,
): { value: unknown; contentType: string } | undefined {
  if (typeof body !== 'string') return undefined;
  const trimmed = body.trim();
  if (!trimmed || trimmed === '[redacted]') return undefined;
  try {
    return {
      value: stripSensitiveValue(JSON.parse(trimmed)),
      contentType: 'application/json',
    };
  } catch {
    if (!trimmed.includes('=')) return undefined;
    const params = new URLSearchParams(trimmed);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      if (!isSensitiveKey(key)) obj[key] = coerceScalar(value);
    }
    return Object.keys(obj).length > 0
      ? { value: obj, contentType: 'application/x-www-form-urlencoded' }
      : undefined;
  }
}

function stripSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(stripSensitiveValue).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const stripped = stripSensitiveValue(child);
    if (stripped !== undefined) out[key] = stripped;
  }
  return out;
}

function inferPayloadSchema(values: unknown[]): JsonSchema | undefined {
  const present = values.filter((value) => value !== undefined);
  if (present.length === 0) return undefined;
  return {
    ...mergeSchemas(present.map(inferJsonSchema)),
    'x-tabtin-sample-derived': true,
    'x-tabtin-inferred': {
      source: 'network-samples',
      sampleCount: present.length,
    },
  };
}

function inferJsonSchema(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value))
    return {
      type: 'array',
      items: mergeSchemas(value.map(inferJsonSchema)) || {},
    };
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'string':
      return inferStringSchema(value);
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (isSensitiveKey(key)) continue;
        properties[key] = inferJsonSchema(child);
      }
      return {
        type: 'object',
        properties: sortObject(properties),
        additionalProperties: true,
      };
    }
    default:
      return {};
  }
}

function inferStringSchema(value: string): JsonSchema {
  if (/^\d{4}-\d{2}-\d{2}T/.test(value))
    return { type: 'string', format: 'date-time' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return { type: 'string', format: 'date' };
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return { type: 'string', format: 'uuid' };
  }
  return { type: 'string' };
}

function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  const filtered = schemas.filter((schema) => Object.keys(schema).length > 0);
  if (filtered.length === 0) return {};
  if (filtered.length === 1) return filtered[0];

  const types = Array.from(
    new Set(
      filtered.flatMap((schema) =>
        Array.isArray(schema.type)
          ? schema.type
          : schema.type
            ? [schema.type]
            : [],
      ),
    ),
  );
  if (types.length === 1 && types[0] === 'object')
    return mergeObjectSchemas(filtered);
  if (types.length === 1 && types[0] === 'array') {
    return {
      type: 'array',
      items: mergeSchemas(
        filtered.map((schema) => schema.items ?? {}).filter(Boolean),
      ),
    };
  }
  if (types.length === 1) {
    const formats = Array.from(
      new Set(filtered.map((schema) => schema.format).filter(Boolean)),
    );
    return {
      type: types[0],
      ...(formats.length === 1 ? { format: formats[0] } : {}),
    };
  }
  return types.length > 0 ? { type: types.sort() } : {};
}

function mergeObjectSchemas(schemas: JsonSchema[]): JsonSchema {
  const propertyNames = new Set<string>();
  for (const schema of schemas) {
    for (const key of Object.keys(schema.properties ?? {}))
      propertyNames.add(key);
  }
  const properties: Record<string, JsonSchema> = {};
  for (const key of Array.from(propertyNames).sort()) {
    const childSchemas = schemas
      .map((schema) => schema.properties?.[key])
      .filter((schema): schema is JsonSchema => Boolean(schema));
    properties[key] = mergeSchemas(childSchemas);
  }
  return {
    type: 'object',
    properties,
    additionalProperties: true,
  };
}

function coerceScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_RE.test(key)) return true;
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sensitiveNeedles = [
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'authtoken',
    'token',
    'clientsecret',
    'secret',
    'password',
    'passwordhash',
    'passwd',
    'apikey',
    'authorization',
    'auth',
    'cookie',
    'session',
    'csrf',
    'csrftoken',
    'xsrf',
    'xsrftoken',
    'credential',
  ];
  return sensitiveNeedles.some((needle) => compact.includes(needle));
}

function operationIdFor(method: string, pathTemplate: string): string {
  const clean = pathTemplate
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, ' '))
    .flatMap((part) => part.split(' '))
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${method.toLowerCase()}${clean || 'Root'}`;
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}
