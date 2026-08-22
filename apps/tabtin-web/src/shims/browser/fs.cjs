function notAvailable(method) {
  return function unavailable() {
    throw new Error(`fs.${method} is not available in the browser build`)
  }
}

module.exports = {
  readFileSync: notAvailable('readFileSync'),
  readFile: notAvailable('readFile'),
  existsSync: function existsSync() {
    return false
  },
}
