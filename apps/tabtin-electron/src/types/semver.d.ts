declare module 'semver' {
  export type ComparatorOptions = {
    includePrerelease?: boolean
    loose?: boolean
  }

  export const gt: (version: string, compare: string, options?: ComparatorOptions) => boolean

  const semver: {
    gt: typeof gt
  }

  export default semver
}
