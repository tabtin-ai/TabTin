/**
 * Minimal browser shim for Node.js `util` module.
 *
 * antlr4ts (used by the table engine) accesses `util.inspect.custom` to define
 * custom inspection formatting. In the browser this Symbol doesn't exist,
 * causing a crash. This shim provides the bare minimum so that computed
 * property name `[util.inspect.custom]` evaluates to a valid (but harmless)
 * Symbol rather than throwing.
 *
 * NOTE: This file is referenced via resolve.alias in electron.vite.config.ts.
 * It must NOT `import from 'util'` directly or it will create a circular alias.
 * Instead we import the polyfill by its absolute resolved path.
 */

// The `inspect.custom` Symbol that Node.js provides
const kCustomInspect = Symbol.for('nodejs.util.inspect.custom')

// Minimal inspect function that antlr4ts can use
function inspect(obj, opts) {
  if (obj === null) return 'null'
  if (obj === undefined) return 'undefined'
  if (typeof obj === 'string') return JSON.stringify(obj)
  if (typeof obj.toString === 'function') return obj.toString()
  return String(obj)
}

// The critical property that antlr4ts needs
inspect.custom = kCustomInspect

// Provide a few other commonly-used util functions
function inherits(ctor, superCtor) {
  if (superCtor) {
    ctor.super_ = superCtor
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
  }
}

function deprecate(fn, msg) {
  return fn
}

function isArray(arg) {
  return Array.isArray(arg)
}

function isBoolean(arg) {
  return typeof arg === 'boolean'
}

function isNull(arg) {
  return arg === null
}

function isNumber(arg) {
  return typeof arg === 'number'
}

function isString(arg) {
  return typeof arg === 'string'
}

function isUndefined(arg) {
  return arg === void 0
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null
}

function isFunction(arg) {
  return typeof arg === 'function'
}

function isRegExp(arg) {
  return arg instanceof RegExp
}

function isDate(arg) {
  return arg instanceof Date
}

function isError(arg) {
  return arg instanceof Error
}

function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn(...args, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  }
}

export {
  inspect,
  inherits,
  deprecate,
  promisify,
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isString,
  isUndefined,
  isObject,
  isFunction,
  isRegExp,
  isDate,
  isError,
}

export default {
  inspect,
  inherits,
  deprecate,
  promisify,
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isString,
  isUndefined,
  isObject,
  isFunction,
  isRegExp,
  isDate,
  isError,
}
