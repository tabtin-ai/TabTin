/**
 * Section collapse persistence helpers.
 *
 * Kept as pure utilities so behavior can be unit-tested without DOM.
 */

export interface SectionStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const STORAGE_PREFIX = 'sui:section:';

export function sectionStorageKey(rawKey: string): string {
  const normalized = rawKey
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return `${STORAGE_PREFIX}${normalized}`;
}

export function getSectionStorage(): SectionStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSectionCollapsed(
  storage: SectionStorage | null,
  key: string,
  fallback: boolean,
): boolean {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(sectionStorageKey(key));
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeSectionCollapsed(
  storage: SectionStorage | null,
  key: string,
  collapsed: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(sectionStorageKey(key), collapsed ? '1' : '0');
  } catch {
    // Ignore quota/security errors.
  }
}
