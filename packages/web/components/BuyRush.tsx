"use client";

import { uniswapSwapUrl } from "../lib/chain";
import { RUSH_ADDRESS } from "../lib/contracts";
import { linkButton } from "../lib/ui";

/**
 * Sends a player who's short on chips to buy RUSH. A Uniswap deep-link with RUSH
 * pre-selected as the output token - a link rather than an embedded widget keeps
 * the bundle light and works before a pool exists on a given chain.
 */
export function BuyRush({ lowBalance }: { lowBalance?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
      <a
        data-testid="buy-rush"
        href={uniswapSwapUrl(RUSH_ADDRESS)}
        target="_blank"
        rel="noreferrer"
        style={linkButton}
      >
        Buy RUSH on Uniswap →
      </a>
      {lowBalance && (
        <span data-testid="low-balance" style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          Out of chips - grab some RUSH to keep playing.
        </span>
      )}
    </div>
  );
}
