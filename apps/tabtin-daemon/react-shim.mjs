// Shim for react — daemon runs headless, React hooks are never actually called.
// This prevents "Cannot find package 'react'" errors when @tabtin/shared's
// use-countdown.js is included in the bundle graph.

export const useState = () => [undefined, () => {}];
export const useEffect = () => {};
export const useCallback = (fn) => fn;
export const useRef = () => ({ current: null });
export const useMemo = (fn) => fn();
export const useContext = () => undefined;
export const createContext = () => ({});
export const createElement = () => null;
export const Fragment = Symbol('Fragment');
export default { useState, useEffect, useCallback, useRef, useMemo, useContext, createContext, createElement, Fragment };
