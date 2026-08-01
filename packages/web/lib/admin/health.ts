/**
 * Relayer health, re-exported from the shared package.
 *
 * The state machine moved to `@rushood/verifier` in #39 so the relayer's own pager
 * reads the same definition the console does. A second copy could drift, and the
 * failure that produces - this panel showing green while nobody is being paged - is
 * precisely what the alerting exists to prevent.
 *
 * Kept as a re-export so the console's imports stay local, matching how
 * `multiplierLabel` is surfaced from the same package.
 */

export {
  LAG_WARNING_SECONDS,
  relayerHealth,
  type RelayerHealth,
  type RelayerHealthInputs,
  type RelayerStatus,
} from "@rushood/verifier";
