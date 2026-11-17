# Dip-and-Ride BTC Bot

A bot for the make.fun 24h CBBTC race (`btc-race-24h-20261117-0603`). Long only,
one asset (CBBTC/USDC), starting from 1,000 USDC.

## Strategy

BTC on a one-minute clock spends most of a day chopping inside a ~2% band, and
every full-size round trip costs about 26 bps in fees, slippage and impact, so
the bot trades rarely and only for a clear edge:

1. **Buy the dip.** When the close prints at least 0.70% below its 60-bar mean
   and the minute ticked up (selling looks exhausted), it buys with all its
   cash.
2. **Ride and exit fast.** It sells when the close falls 0.90% under the
   highest close since entry (trailing stop) or when the position is 1.30%
   under its cost (hard stop). There is no fixed take-profit.

Safety rails: a 30-bar cooldown after every exit, a loss breaker that stops
dip-buying after 2 losing round trips in a row, and a late-trend fallback that
buys at bar 600 if still flat and the close is above its 120-bar EMA (covers
a day that trends up without ever dipping).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay SDK shim.

## Local grade

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
