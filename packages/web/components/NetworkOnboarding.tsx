"use client";

import type { CSSProperties } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import {
  activeChain,
  activeChainConfigError,
  activeChainId,
  chainLabel,
  gasHelpUrl,
  isLocalChain,
  isWrongNetwork,
} from "../lib/chain";
import { switchFailureMessage } from "../lib/errors";
import { ghostButton, linkButton } from "../lib/ui";

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
 *
 * The chain comes from `useAccount`, not `useChainId`, and the difference is the whole
 * guard. `useChainId` reports the *config's* selected chain, and wagmi refuses to move
 * that to a chain it was not configured with - see `createConfig`, "If chain is not
 * configured, then don't switch over to it". Every chain a player is wrongly on is by
 * definition one of those, so `useChainId` answered `ACTIVE_CHAIN_ID` no matter where
 * the wallet actually was and this banner never rendered. `useAccount().chainId` is
 * the connection's own chain and reports the wallet as it is.
 */
export function NetworkOnboarding() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();
  const onWrongNetwork = isConnected && isWrongNetwork(chainId);

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
          onClick={() => switchChain({ chainId: activeChainId })}
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
