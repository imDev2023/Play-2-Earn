"use client";

import type { CSSProperties } from "react";
import { useChainId, useSwitchChain } from "wagmi";
import {
  ACTIVE_CHAIN_ID,
  activeChain,
  activeChainConfigError,
  chainLabel,
  gasHelpUrl,
  isLocalChain,
} from "../lib/chain";
import { wagmiConfig } from "../lib/wagmi";
import { switchFailureMessage } from "../lib/errors";
import { ghostButton, linkButton } from "../lib/ui";

type ConfiguredChainId = (typeof wagmiConfig.chains)[number]["id"];

/**
 * Guides a connected player onto the chain RUSHOOD runs on. When the wallet is on
 * the wrong network it shows a one-tap switch (which triggers the wallet's
 * add-network prompt for chains it doesn't know yet); PlayPanel disables betting
 * until the switch lands. It also surfaces where to get gas - hidden on a local
 * dev node, where there's nothing to bridge.
 *
 * A switch that fails says so. The wallet can refuse for reasons only the person
 * holding it can fix, and a button that silently returns to its resting label leaves
 * them clicking it again forever, which is exactly what a wallet already holding a
 * different network on the same RPC URL produces.
 */
export function NetworkOnboarding() {
  const chainId = useChainId();
  const { switchChain, isPending, error } = useSwitchChain();
  const onWrongNetwork = chainId !== ACTIVE_CHAIN_ID;

  if (onWrongNetwork) {
    const failure = error ? switchFailureMessage(error) : null;
    return (
      <div data-testid="wrong-network" role="alert" style={banner}>
        <div>
          <strong style={{ display: "block" }}>Wrong network</strong>
          <span style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
            You&apos;re on {chainLabel(chainId)}. Switch to {activeChain.name} to play.
          </span>
          {failure ? (
            <span
              data-testid="switch-network-error"
              style={{ display: "block", marginTop: "0.5rem", fontSize: "0.9rem" }}
            >
              {failure}
            </span>
          ) : null}
        </div>
        <button
          data-testid="switch-network"
          style={ghostButton}
          disabled={isPending}
          onClick={() => switchChain({ chainId: ACTIVE_CHAIN_ID as ConfiguredChainId })}
        >
          {isPending ? "Switching…" : `Switch to ${activeChain.name}`}
        </button>
      </div>
    );
  }

  const configError = activeChainConfigError();
  if (configError) {
    return (
      <div data-testid="chain-misconfigured" role="alert" style={banner}>
        <div>
          <strong style={{ display: "block" }}>Network not configured</strong>
          <span style={{ color: "var(--muted)", fontSize: "0.9rem" }}>{configError}</span>
        </div>
      </div>
    );
  }

  if (isLocalChain) return null;

  const gasUrl = gasHelpUrl();

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <span data-testid="network-ok" style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        On {activeChain.name}.{gasUrl ? " Need gas to play?" : ""}
      </span>
      {gasUrl ? (
        <a data-testid="get-gas" href={gasUrl} target="_blank" rel="noreferrer" style={linkButton}>
          Get ETH for gas →
        </a>
      ) : null}
    </div>
  );
}

const banner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  padding: "0.9rem 1.1rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--hot)",
  background: "rgba(255, 90, 60, 0.12)",
};
