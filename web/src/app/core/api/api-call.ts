/**
 * The one place a generated SDK result is unwrapped.
 *
 * ## Why this exists
 *
 * The generated types are frozen at generation time to
 * `throwOnError: false, responseStyle: 'fields'`, so every SDK method is typed
 * as resolving to a union - either `{ data }` or `{ error }`, with the other
 * half typed `undefined` - intersected with the optional `request`/`response`.
 * That is the generator's contract, and it does not change when the client is
 * later configured at runtime with `throwOnError: true`: the types and the
 * runtime are set independently.
 *
 * So the runtime is configured to reject on failure (see `api-client.config.ts`)
 * while the types still describe the old shape, and something has to reconcile
 * them. Doing that at each of the 56 call sites would be 56 chances to forget,
 * and a forgotten unwrap shows a citizen an empty page instead of an error.
 *
 * `call` is that reconciliation, in one place.
 */

/**
 * The generator's result shape.
 *
 * `data` and `error` are declared as *required* properties typed `undefined`,
 * matching the generated union exactly. Declaring them optional instead
 * (`data?: undefined`) looks equivalent but lets TypeScript widen the success
 * type to `TData | undefined` at the call site, which defeats inference.
 */
export type SdkResult<TData, TError = unknown> =
  | { data: TData; error: undefined; request?: Request; response?: Response }
  | { data: undefined; error: TError; request?: Request; response?: Response };

/**
 * Run a generated SDK call and yield its payload, rejecting on failure.
 *
 * The payload type is stated explicitly because it cannot be inferred through
 * the generated intersection - inference collapses the two union branches into
 * `TData | undefined`. One type argument at the call site is the cost of that;
 * the alternative is a cast in every feature.
 *
 * `error` is the branch condition rather than `data`, because a
 * `204 No Content` response has no payload and the SDK reports that as `{}`.
 * A failed request is the only case where `error` is meaningful.
 */
export function call<TData>(run: Promise<SdkResult<TData>>): Promise<TData> {
  return run.then((result) => {
    if (result.error !== undefined) {
      throw result.error;
    }
    return result.data as TData;
  });
}

/**
 * The synchronous form, for a caller already holding the result.
 *
 * The cast is a consequence of the union rather than a shortcut past it:
 * `TError` may itself include `undefined`, so TypeScript cannot use
 * `error !== undefined` to eliminate the failure branch. The condition is still
 * correct, and the only way it could be wrong is a successful response that also
 * carries an `error`, which the contract does not produce.
 */
export function unwrap<TData, TError>(result: SdkResult<TData, TError>): TData {
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.data as TData;
}
