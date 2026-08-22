import { withTableRequestHeaders } from '@tabtin/table-core';

export function bindTableRequestHeaders<T extends object>(
  service: T,
  headers?: Record<string, string>,
): T {
  if (!headers || Object.keys(headers).length === 0) return service;

  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        withTableRequestHeaders(headers, () =>
          Reflect.apply(value, target, args),
        );
    },
  });
}
