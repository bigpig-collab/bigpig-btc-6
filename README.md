# btc-race-24h-20261118-1444 — DP-fitted cbBTC bot

[![make.fun — Race a BTC trading bot live for 24 hours](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/bigpig-collab/bigpig-btc-6/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/bigpig-collab/bigpig-btc-6/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444) on make.fun.

A 1-minute cbBTC trading bot (Node 22, erasable TypeScript, standard library
plus the vendored kit SDK only). Long-only, all-in, one position at a time,
$1,000 start. No network, no wall clock, no randomness, no files outside the
repository; every rule is a function of past closes.

## How it was built

An exact dynamic-programming oracle was run over the dev window first
(ceiling +$56.74 at 6 round trips, +$63.65 unlimited), and its profitable
legs were fitted with causal rules. The oracle is a fit target, never a
schedule: no bar number, date, or price from the dev window is hardcoded,
and the same rules run unchanged on the unseen race window.

## Arms (priority: snapback, then patient, then bounce)

| Arm | Entry (past closes only) | Exit |
|---|---|---|
| **snapback** | RSI(7) < 25, down ≥ 80 bps over 30 and 60 bars, close up vs 2 bars ago | take +120 bps / hold 90 bars |
| **patient** | down ≥ 110 bps over 120 bars, close up vs 2 bars ago, close above its 10-bar average | take +185 bps / hold 480 bars |
| **bounce** | close in the bottom 3.5% of its 20-bar Bollinger band (%b < 0.035), close up vs 2 bars ago | take +40 bps / stop −36 bps / hold 105 bars |

Exits compare the position's current value with its cost. The patient arm's
slow exit is deliberate: the window's big legs are grinds gaining ~120–155
bps over 230–350 bars, and trailing / time-decay exits were measured to cut
those legs short. The bounce stop sits mid-plateau (flat region 31–40 bps).

## Verified result (dev window, grade-local)

- **Net PnL +$31.55** (12 fills = 6 round trips, 5 wins, max drawdown 1.08%)
- Fees $4.90; **at 2× fees +$26.64**
- Split-half (standalone re-run per half): H1 **+$27.14**, H2 **+$4.42**
- Plateau: worst ±1-step neighbour 91.4% of peak (all 24 neighbours ≥ 90%)
- L1 regrade reproduced byte for byte; clean-directory grade identical
- Full numbers, trade log, plateau and split-half tables:
  see `../BUILD-REPORT.md`

## Honest caveat

The DP fit maximises the DEV score only. The dev window never decides
prizes — the live 24 h race window does. These rules are the live logic;
the dev PnL is only the gate plus a noisy proxy. The bot has 6 trades on
dev; the live window will have different prices, and a dip that keeps
falling after entry exits only via take / stop / hold.

## Layout

- `main.ts` — the bot (imports `./vendor/makefun-bars.ts`)
- `vendor/makefun-bars.ts` — byte copy of the kit SDK shim
- `LICENSE` — MIT

## Run

```sh
cd <kit> && node cli/makefun.mjs grade-local --kit . --bot <this dir> --driver process
```
