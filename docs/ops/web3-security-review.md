# Web3 security review

A pass over the repo against the references in the untracked `resources/web3-security.md`:
SlowMist's Web3 Project Security Practice Requirements, the Consensys Diligence smart contract best practices, and the Alchemy overview.

Reviewed **2026-08-04**.

> **This is not the security audit.**
> The owner-held pre-launch gate is a review by independent audit teams, and it has not happened.
> The shipped fairness disclosure states plainly that the contracts are unaudited, and that stays true until real auditors say otherwise.
> What follows is an engineering pass against published checklists: useful, and not a substitute.

## Fixed in this pass

All of it in the web and ops layers. See the commit for the reasoning behind each.

| Requirement | Was | Now |
| --- | --- | --- |
| "Make sure X-FRAME-OPTIONS is configured to prevent Clickjacking" | absent | `X-Frame-Options: DENY` plus CSP `frame-ancestors 'none'`, verified at runtime by injecting an iframe of `/admin` and confirming it has no document |
| "Make sure CSP policies are configured to prevent XSS" | absent | Nonce-based `script-src` with `strict-dynamic`, set per response in `middleware.ts` |
| Restrict where the page may talk to | absent | `connect-src` built from `lib/endpoints`, the same module the chains are configured from |
| "Make sure HSTS is configured" | absent | `Strict-Transport-Security`, two years, `includeSubDomains; preload` |
| Referrer leakage | absent | `strict-origin-when-cross-origin`. Bet ids and commitments travel in the verifier's query string |
| MIME sniffing | absent | `nosniff` |
| Unused browser APIs | absent | `Permissions-Policy` denying payment, camera, microphone, geolocation, USB and motion sensors |
| "Make sure to use an effective CI/CD pipeline" | no token scoping, tags not pinned, no dependency gate | `permissions: contents: read`; both actions pinned by commit SHA; `npm audit` gate on production dependencies |
| Dependency hygiene | 6 high advisories, unreviewed | Next bumped 15.1.6 -> 15.5.22, clearing the direct findings; the remainder reviewed and recorded in `dependency-advisories.md` |

**CORS** needs nothing: the app exposes no API routes, so there is no cross-origin surface to widen or narrow.
**Cookie flags** need nothing: the app sets no cookies. Wallet state lives in the wallet.
**Subresource integrity** needs nothing: no third-party scripts, styles or fonts are loaded. The only external hosts referenced are anchors a player follows, not resources the page fetches.

## Checked and found clean

Contracts were read, not changed - see the constraint below.

- **Reentrancy.** `settleBet` and `refund` both write state before any external call (`bet.settled`, `activeBetId`, `currentCommit` all set first). RUSH is a plain OpenZeppelin `ERC20` + `ERC20Burnable` with no transfer hooks or callbacks, so a payout cannot re-enter. This satisfies SlowMist's "first judge, then write variables, and then make external calls". There is no `ReentrancyGuard`, and given the above it is not load-bearing.
- **External call return values.** Every token movement goes through OpenZeppelin `SafeERC20` (`safeTransfer`, `safeTransferFrom`), which reverts on a false return. No raw `transfer`/`send`/`call`.
- **Dangerous primitives.** No `tx.origin`, no `delegatecall`, no `assembly`, no `selfdestruct`, anywhere in the contracts.
- **Pragma locking.** Sources declare `^0.8.24`, but `hardhat.config.ts` pins the compiler to exactly `0.8.24`, so every artifact - including the already-verified mainnet and testnet deployments - is built with one known version. Consensys's concern is addressed at the build level.
- **Timestamp dependence.** `block.timestamp` appears twice, both for the one-hour `SETTLE_TIMEOUT`. Miner drift of a few seconds cannot matter at that scale.
- **Integer safety.** Solidity 0.8 checked arithmetic throughout; no `unchecked` blocks.
- **Authority separation.** SlowMist's "distribute authority and use governance or multi-signature contracts" is met: `governance` (policy, behind a Timelock) and `guardian` (pause, immediate) are separate roles, and the economic invariants are immutable by default behind the opt-in `economicsGovernable` flag.
- **Known library use.** OpenZeppelin throughout, as required.
- **Secrets.** `.env` is gitignored, no key or seed is logged by any script, and `RELAYER_SEED` is required rather than defaulted on any non-localhost network.
- **Test coverage.** SlowMist asks for >95%. 273 contract tests plus 19 verifier tests; the number is not measured as a coverage percentage, so this is **not evidenced** - see below.

## Documented residual risks, unchanged

- The **refund mempool caveat** is stated in `RushoodGame.refund`: if the relayer broadcast `settleBet(reveal)` and it never confirmed before the timeout, that reveal is public while the head still equals its hash. Mitigated by the relayer rotating the chain after any downtime, and by the guardian's pause.
- The **relayer is a single party**. Multi-relayer redundancy is deliberately out of scope.

## Not done, and why

- **No Solidity was changed.** Solidity embeds a source hash in contract metadata, so editing even a comment breaks verification for the already-verified mainnet and testnet deployments. Nothing above calls for a change; if a future finding does, it needs a redeploy and re-verification, not an edit.
- **Gas optimization** (the WTF reference) is entirely a Solidity concern and therefore out of reach here.
- **Coverage percentage is unmeasured.** No coverage tool runs in CI, so SlowMist's ">95%, 100% for core" cannot be claimed either way. Adding `solidity-coverage` would settle it and is a reasonable next ticket.
- **Infrastructure requirements are unaddressed because there is no infrastructure yet**: HIDS, SSH hardening, centralized logging, DNSSEC, domain-registrar MFA, cloud-account MFA and DNS-change monitoring all become real at deploy time. They belong with the systemd install drill in `docs/ops/relayer.md`, which is also still unrun.
- **Incident response.** SlowMist asks for a named emergency contact and a rehearsed procedure. The guardian pause exists; the process around it does not.
