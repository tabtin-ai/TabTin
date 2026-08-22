type AnyActionMap = Record<string, unknown>

export const flattenActions = <T extends object>(instances: object[]): T => {
  const actions: AnyActionMap = {}

  for (const instance of instances) {
    copyOwnActions(actions, instance)
    copyPrototypeActions(actions, instance)
  }

  return actions as T
}

const copyOwnActions = (target: AnyActionMap, source: object) => {
  for (const key of Object.keys(source)) {
    const value = (source as AnyActionMap)[key]
    target[key] = typeof value === 'function' ? value.bind(source) : value
  }
}

const copyPrototypeActions = (target: AnyActionMap, source: object) => {
  const proto = Object.getPrototypeOf(source) as AnyActionMap | null
  if (!proto) return

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue
    const value = proto[key]
    if (typeof value === 'function') {
      target[key] = value.bind(source)
    }
  }
}
