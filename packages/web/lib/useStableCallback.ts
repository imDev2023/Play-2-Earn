"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes, always running the newest closure.
 *
 * This exists for one specific hazard. wagmi lists `onLogs` in
 * `useWatchContractEvent`'s effect dependencies, so handing it a function rebuilt on
 * every render unsubscribes and resubscribes on every render - and a log emitted in
 * that gap is never delivered. Nothing reports the loss: the screen simply never hears
 * about an event that did happen on chain.
 *
 * Memoising the handler is not enough on its own, because the memo is only as stable
 * as its dependency list, and these handlers close over things that legitimately churn
 * (a wagmi `refetch`, the pending bet they compare against). Pinning the identity for
 * the lifetime of the component and reading the body through a ref keeps the
 * subscription untouched while the handler stays current.
 *
 * The ref is updated in a layout effect rather than during render, so a render that
 * React discards cannot publish its closure. Between render and that effect the
 * previous closure is still the live one, which is correct for event handlers: they
 * fire after commit.
 */
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);

  useLayoutEffect(() => {
    latest.current = fn;
  });

  return useCallback((...args: Args) => latest.current(...args), []);
}
