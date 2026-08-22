function fail(message) {
  throw new Error(message || 'Assertion failed')
}

function assert(value, message) {
  if (!value) {
    fail(message)
  }
}

assert.ok = assert
assert.equal = function equal(actual, expected, message) {
  if (actual != expected) {
    fail(message || `Expected ${actual} to equal ${expected}`)
  }
}
assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(message || `Expected ${actual} to strictly equal ${expected}`)
  }
}
assert.deepEqual = function deepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(message || 'Expected values to be deeply equal')
  }
}
assert.strict = assert

module.exports = assert
