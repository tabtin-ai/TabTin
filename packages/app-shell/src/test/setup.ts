const createMemoryStorage = (): Storage => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      backing.delete(String(key));
    },
    clear: () => {
      backing.clear();
    },
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    get length() {
      return backing.size;
    },
  };
  return storage as Storage;
};

const ensureWebStorage = (name: 'localStorage' | 'sessionStorage') => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  const current =
    descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const hasApis =
    current &&
    typeof current.getItem === 'function' &&
    typeof current.setItem === 'function' &&
    typeof current.removeItem === 'function' &&
    typeof current.clear === 'function';

  if (hasApis) return;

  const memoryStorage = createMemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: memoryStorage,
    writable: true,
    configurable: true,
  });

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, {
      value: memoryStorage,
      writable: true,
      configurable: true,
    });
  }
};

ensureWebStorage('localStorage');
ensureWebStorage('sessionStorage');
