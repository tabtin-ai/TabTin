import { describe, it, expect } from 'vitest';
import { isBlockedScript } from '../script-policy';

describe('isBlockedScript', () => {
  describe('blocked patterns → true', () => {
    it('document.cookie', () => {
      expect(isBlockedScript('document.cookie')).toBe(true);
    });

    it("localStorage.getItem('x')", () => {
      expect(isBlockedScript("localStorage.getItem('x')")).toBe(true);
    });

    it("sessionStorage.setItem('k','v')", () => {
      expect(isBlockedScript("sessionStorage.setItem('k','v')")).toBe(true);
    });

    it('indexedDB', () => {
      expect(isBlockedScript('indexedDB')).toBe(true);
    });

    it('localStorage.removeItem', () => {
      expect(isBlockedScript("localStorage.removeItem('key')")).toBe(true);
    });

    it('localStorage.clear', () => {
      expect(isBlockedScript('localStorage.clear()')).toBe(true);
    });

    it('sessionStorage.getItem', () => {
      expect(isBlockedScript("sessionStorage.getItem('k')")).toBe(true);
    });

    it('sessionStorage.removeItem', () => {
      expect(isBlockedScript("sessionStorage.removeItem('k')")).toBe(true);
    });

    it('sessionStorage.clear', () => {
      expect(isBlockedScript('sessionStorage.clear()')).toBe(true);
    });
  });

  describe('case-insensitive matching → true', () => {
    it('Document.Cookie (mixed case)', () => {
      expect(isBlockedScript('Document.Cookie')).toBe(true);
    });

    it('DOCUMENT.COOKIE (upper case)', () => {
      expect(isBlockedScript('DOCUMENT.COOKIE')).toBe(true);
    });

    it('INDEXEDDB (upper case)', () => {
      expect(isBlockedScript('INDEXEDDB')).toBe(true);
    });

    it('LocalStorage.GetItem (pascal case)', () => {
      expect(isBlockedScript("LocalStorage.GetItem('x')")).toBe(true);
    });
  });

  describe('embedded in larger scripts → true', () => {
    it('script containing document.cookie access', () => {
      expect(isBlockedScript('var c = document.cookie; return c;')).toBe(true);
    });

    it('script with indexedDB usage', () => {
      expect(isBlockedScript('var db = indexedDB.open("mydb")')).toBe(true);
    });
  });

  describe('safe scripts → false', () => {
    it('document.title', () => {
      expect(isBlockedScript('document.title')).toBe(false);
    });

    it('console.log("hello")', () => {
      expect(isBlockedScript('console.log("hello")')).toBe(false);
    });

    it('document.querySelector("div")', () => {
      expect(isBlockedScript('document.querySelector("div")')).toBe(false);
    });

    it('window.location.href', () => {
      expect(isBlockedScript('window.location.href')).toBe(false);
    });
  });

  describe('substring false positives → false', () => {
    it('localStorageHelper (no method call)', () => {
      expect(isBlockedScript('localStorageHelper')).toBe(false);
    });

    it('sessionStorageWrapper (no method call)', () => {
      expect(isBlockedScript('sessionStorageWrapper')).toBe(false);
    });

    it('localStorage without method call', () => {
      expect(isBlockedScript('var x = localStorage')).toBe(false);
    });
  });
});
