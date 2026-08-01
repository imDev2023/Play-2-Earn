/**
 * Alert delivery and de-duplication for the relayer (#39).
 *
 * Severity is a two-value decision because that is the only distinction that changes
 * what a person does: `page` means the game is down or about to be, `warn` means fix it
 * this week. Anything finer is a taxonomy nobody consults at 3am.
 *
 * The `Alerter` exists because the evaluation loop runs every few seconds while an
 * incident lasts minutes. Delivering on every pass would convert one outage into
 * hundreds of notifications, and a pager that cries wolf gets muted - which costs
 * exactly the incident it was bought for. So conditions are edge-triggered: delivered
 * when they start, resolved when they stop, re-delivered only when they escalate.
 */

export type Severity = "warn" | "page";

/**
 * Every condition the loop can report.
 *
 * Closed rather than an open string, because resolution is scoped by key: a pass has to
 * be able to say which conditions it actually looked at, and a typo in that list would
 * silently clear an alert that is still true.
 */
export const ALERT_KEYS = [
  "settlement-lag",
  "settlement-stalled",
  "rpc-down",
  "chain-stalled",
  "chain-exhaustion",
  "relayer-funding",
] as const;

export type AlertKey = (typeof ALERT_KEYS)[number];

/** The only conditions a pass can judge when it could not reach the node at all. */
export const LIVENESS_KEYS: readonly AlertKey[] = ["rpc-down", "chain-stalled"];

export interface Alert {
  /** Stable identity of the condition, not of the occurrence. Used to dedupe. */
  key: AlertKey;
  severity: Severity;
  summary: string;
  detail?: string;
}

/**
 * What one pass concluded.
 *
 * `assessed` is the point of the type. A pass that could not read the chain knows
 * nothing about the gas balance or the reveal chain, and silence about a condition is
 * not evidence that it cleared. Carrying the scope explicitly is what stops a single
 * failed poll from resolving every other alert and then re-raising it a second later.
 */
export interface PassResult {
  alerts: Alert[];
  assessed: readonly AlertKey[];
}

/** Where alerts go. Kept narrow so a test can stand in without a network. */
export interface AlertSink {
  deliver(alert: Alert): Promise<void>;
  resolve(key: AlertKey): Promise<void>;
}

/**
 * The dead man's switch, which is a different mechanism from an alert and so a
 * different collaborator.
 *
 * An alert is something the relayer says. A heartbeat is something it does, and its
 * meaning comes from stopping. They must not share a destination: see
 * `HealthchecksHeartbeat` for what happens when they do.
 */
export interface Heartbeat {
  ping(): Promise<void>;
}

export class Alerter {
  private readonly firing = new Map<AlertKey, Severity>();

  constructor(private readonly sink: AlertSink) {}

  /**
   * Reconcile the currently-true conditions against what is already firing.
   *
   * Only conditions this pass actually assessed are eligible to be resolved. Anything
   * outside that scope keeps whatever state it had, because the pass has no evidence
   * either way.
   *
   * Never throws. A sink that is down is a monitoring outage, and taking the relayer
   * with it would turn "we cannot see the game" into "the game is not running", which
   * is strictly worse. Failures are reported to stderr and the loop continues.
   */
  async evaluate({ alerts, assessed }: PassResult): Promise<void> {
    const firingNow = new Set(alerts.map((alert) => alert.key));

    for (const alert of alerts) {
      const previous = this.firing.get(alert.key);
      // Escalation is new information even though the key is unchanged, so it breaks
      // through the dedupe that a repeat at the same severity would not.
      const isNew = previous === undefined;
      const escalated = previous === "warn" && alert.severity === "page";
      if (!isNew && !escalated) continue;

      this.firing.set(alert.key, alert.severity);
      try {
        await this.sink.deliver(alert);
      } catch (error) {
        console.error(`[alert] could not deliver ${alert.key}:`, (error as Error).message);
      }
    }

    for (const key of [...this.firing.keys()]) {
      if (firingNow.has(key) || !assessed.includes(key)) continue;
      this.firing.delete(key);
      try {
        await this.sink.resolve(key);
      } catch (error) {
        console.error(`[alert] could not resolve ${key}:`, (error as Error).message);
      }
    }
  }

  /** Conditions currently firing. Exposed for the status line, not for control flow. */
  active(): AlertKey[] {
    return [...this.firing.keys()];
  }
}

/**
 * Healthchecks.io sink for explicit alerts.
 *
 * This owns the *alert* check and nothing else. `deliver` flips it to down, `resolve`
 * flips it back up, and the notification the operator receives is the transition.
 */
export class HealthchecksSink implements AlertSink {
  constructor(
    private readonly alertUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deliver(alert: Alert): Promise<void> {
    // Any non-2xx from the relayer's own reporting is not worth a retry loop; the dead
    // man's switch is the backstop that does not depend on this call working.
    await this.fetchImpl(`${this.alertUrl}/fail`, {
      method: "POST",
      body: `[${alert.severity}] ${alert.summary}\n${alert.detail ?? ""}`.trim(),
    });
  }

  async resolve(key: AlertKey): Promise<void> {
    await this.fetchImpl(this.alertUrl, { method: "POST", body: `resolved: ${key}` });
  }
}

/**
 * Healthchecks.io dead man's switch: a separate check, on a separate URL.
 *
 * Separate is not tidiness, it is the whole mechanism. Pointed at the same check as the
 * alert sink, this ping would flip it back to "up" within one poll interval of any page
 * the relayer raised, and because the `Alerter` de-duplicates, that page would never be
 * re-delivered. The operator would get one notification and then a green dashboard for
 * the rest of a multi-minute outage. `loadRelayerConfig` refuses the two URLs being
 * equal for exactly this reason.
 *
 * It is also never pinged from the settle path. Pinging on settlement would make a quiet
 * night with no bets indistinguishable from a dead relayer, and the false pages would
 * get the check muted within a week.
 */
export class HealthchecksHeartbeat implements Heartbeat {
  constructor(
    private readonly pingUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ping(): Promise<void> {
    await this.fetchImpl(this.pingUrl, { method: "POST", body: "alive" });
  }
}

/** Sink used when no alert destination is configured. Local runs and tests. */
export class ConsoleSink implements AlertSink {
  async deliver(alert: Alert): Promise<void> {
    console.warn(
      `[alert:${alert.severity}] ${alert.summary}${alert.detail ? ` - ${alert.detail}` : ""}`,
    );
  }

  async resolve(key: AlertKey): Promise<void> {
    console.log(`[alert:resolved] ${key}`);
  }
}

/**
 * Heartbeat used when no dead man's switch is configured.
 *
 * Silent rather than logging: it would fire every poll interval, and a line every three
 * seconds is how a journal stops being readable.
 */
export class SilentHeartbeat implements Heartbeat {
  async ping(): Promise<void> {}
}
