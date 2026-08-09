# Accepted dependency advisories

CI fails on a **critical** production advisory (`npm audit --omit=dev --audit-level=critical`).
There are currently none.

There are six **high** advisories that are open and accepted.
This file is the record of why, so that "we know about it" is a decision somebody made rather than a warning everybody scrolled past.
Re-check it whenever the dependency tree moves.

Last reviewed: **2026-08-04**, against `npm audit --omit=dev`.

## Why the gate is at critical rather than high

A gate set where the tree ought to be, rather than where it is, fails on arrival and gets switched off within a week.
The threshold matches reality and this file carries the detail.
**If you resolve the advisories below, lower the threshold to `high` rather than leaving it loose.**

Do not silence an advisory by adding it to an ignore list without adding it here first, with a reason someone else can check.

## The six, and why each is judged not to reach a player

The recurring reason is that wagmi's connector barrel pulls in WalletConnect, Reown AppKit and Coinbase's SDK whether or not you use them.
**RUSHOOD registers only `injected()` and, on a local node, `mock()`** (`packages/web/lib/wagmi.ts`).
It never constructs a WalletConnect or Coinbase connector, and `next.config.ts` already `IgnorePlugin`s several of these specifiers so they do not resolve at all.

Verified on 2026-08-04 by grepping the built client chunks under `packages/web/.next/static/chunks`:

| Package | Severity | Path | Judgement |
| --- | --- | --- | --- |
| `ws` | high | `@reown/appkit-*`, `@walletconnect/utils` | Not in any client chunk as a module, and `ws` is a **Node** websocket library - it cannot execute in a browser. Reachable only if the app starts using a WalletConnect transport. |
| `axios` | high | `@coinbase/cdp-sdk` | **Zero** client chunks. Only reachable through the Coinbase connector, which is never constructed. |
| `lodash` | high | transitive | **Zero** client chunks. |
| `postcss` | high | build toolchain | Build-time only. Never shipped to a browser. The advisories are XSS via CSS stringify output and source-map file read, both of which need attacker-controlled CSS entering the build - our CSS is one file in the repo. |
| `sharp` | high | Next image optimization | Build/server-side only, and **the app has no images**. The advisories are inherited libvips CVEs reached by processing untrusted image input; nothing here processes any. |
| `next` | high | via `postcss` and `sharp` | No longer a direct advisory. Next was bumped 15.1.6 -> 15.5.22 on 2026-08-04, which cleared the direct **Server Actions DoS** and **SSRF on custom servers** findings. Those did not apply anyway: the app uses no Server Actions and no custom server. |

## What would change these judgements

Any of the following makes this file wrong, and it must be re-reviewed before shipping:

- Registering a **WalletConnect, Reown or Coinbase connector** in `lib/wagmi.ts`. That puts `ws` and `axios` on a real code path.
- Adding **images** or enabling Next image optimization. That puts `sharp` on a real code path.
- Adding **Server Actions** or serving through a custom server. That reopens the Next advisories the bump just closed.
- Accepting **CSS or content from outside the repo** into the build. That puts `postcss` on a real code path.

## Resolution attempted and rejected

Forcing patched versions through npm `overrides` (`postcss`, `ws`, `lodash`, `axios`, `sharp`) was tried on 2026-08-04 and **did not take**: npm 11.4.2 declined to apply them without a full dependency-graph re-resolution.
Doing that would mean deleting the lockfile and regenerating it, which produces a large uncontrolled diff.
That is the wrong shape of change to land inside a security fix, where the whole value is that a reviewer can see what moved.

The upstream fix is wagmi v3, which is a **major** bump and a separate, deliberate piece of work.
It is worth doing on its own branch, with the full suite and a live wallet pass behind it.
