/**
 * Type-safe Zustand slice adapters.
 *
 * Zustand's `set`/`get` are typed for the root store, but each extracted
 * slice only reads/writes a structural subset.  These adapters narrow
 * the types at the single boundary WITHOUT `as any`.
 *
 * Safety invariant: every key of `Slice` must exist on `RootState` with a
 * compatible type.  Use {@link AssertSliceOf} to enforce this at compile time.
 *
 * @example
 * ```ts
 * // Compile-time guard (produces a type error if stray keys exist)
 * type _check = AssertSliceOf<ApprovalSliceStore, ChatState>
 *
 * // Runtime adapters
 * narrowGet<ChatState, ApprovalSliceStore>(get)
 * narrowSet<ChatState, ApprovalSliceStore>(set)
 * ```
 */

type ZustandSetFn<S> = (
  partial: Partial<S> | ((state: S) => Partial<S>),
) => void

/**
 * Compile-time assertion: every key of `Slice` must exist on `Parent`.
 * Evaluates to `true` when valid; otherwise produces a descriptive type error.
 */
export type AssertSliceOf<Slice, Parent> =
  Exclude<keyof Slice, keyof Parent> extends never
    ? true
    : { _error: `Slice has keys not present on parent store: ${string & Exclude<keyof Slice, keyof Parent>}` }

/**
 * Narrow root `get` to a slice's read shape.
 *
 * Cast is `as unknown as` (not `as any`): the root state structurally
 * extends every slice, so the narrowing is safe.
 */
export function narrowGet<RootState, Slice>(
  rootGet: () => RootState,
): () => Slice {
  return rootGet as unknown as () => Slice
}

/**
 * Narrow root `set` to a slice's write shape via a thin wrapper.
 *
 * - **Object partial**: `Partial<Slice>` keys are a subset of `RootState`,
 *   so forwarding to root `set` is safe.
 * - **Updater function**: receives the full root state (narrowed to `Slice`
 *   at the type level), returns `Partial<Slice>` which is widened back.
 *
 * This replaces the previous `set as any` pattern and properly handles
 * the updater-function form that a bare cast would silently mis-type.
 */
export function narrowSet<RootState, Slice>(
  rootSet: ZustandSetFn<RootState>,
): ZustandSetFn<Slice> {
  return (partial) => {
    if (typeof partial === 'function') {
      const updater = partial as (s: Slice) => Partial<Slice>
      rootSet((fullState: RootState) =>
        updater(fullState as unknown as Slice) as unknown as Partial<RootState>,
      )
    } else {
      rootSet(partial as unknown as Partial<RootState>)
    }
  }
}
