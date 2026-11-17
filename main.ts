// Dip-and-ride BTC bot for the 24h CBBTC race.
//
// Idea: on a one-minute clock BTC spends most of a day chopping inside a ~2% band, and
// every full-size round trip costs about 26 bps in fees, slippage and impact, so the
// bot trades rarely and only for a clear edge. It does two things:
//
//   1. Buys the dip. When the close prints at least DIP_BPS below its 60-bar mean and
//      the minute ticked up (selling looks exhausted), it buys with all its cash. The
//      dip has to be a real one: 0.70% under the hourly mean is roughly 1.4x the
//      window's hourly volatility, so ordinary noise does not trigger it.
//   2. Rides the recovery and gets out fast when it fails. Once in, it sells when the
//      close falls TRAIL_BPS under the highest close since entry (a trailing stop that
//      lets a real run keep going) or when the position is STOP_BPS under its cost
//      (a hard stop). There is no fixed take-profit: on a trending day the trailing
//      stop is what banks the move.
//
// Two safety rails keep a bad day from bleeding the account:
//
//   - A cooldown of COOLDOWN_BARS after every exit, so a whipsaw cannot re-enter on
//     the next bar.
//   - A loss breaker: after MAX_CONSEC_LOSSES losing round trips in a row the bot
//     stops buying dips for the rest of the window (a falling knife keeps falling).
//
//   - A late-trend fallback: if the bot is still flat at bar FALLBACK_BAR and the
//     close sits above its 120-bar EMA, it buys and rides with the same exits. This
//     covers a day that trends up all day without ever dipping far enough to trigger
//     rule 1, so the bot is not left holding cash while the market runs away.
//
// Everything is deterministic: plain float64 arithmetic on closes, no clock, no
// randomness, no environment reads. Indicators seed exactly like the kit baselines
// (an EMA starts as the mean of its first span of closes).

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** The dip is measured against this many bars of closes (one hour). */
const SMA_BARS = 60;
/** The trend filter for the late-trend fallback. */
const EMA_BARS = 120;
/** Buy when the close is at least this far under its 60-bar mean, in bps. */
const DIP_BPS = 60;
/** Sell when the close falls this far under the peak since entry, in bps. */
const TRAIL_BPS = 90;
/** Sell when the position is worth this far under its cost, in bps. */
const STOP_BPS = 130;
/** Bars to wait after an exit before buying the dip again. */
const COOLDOWN_BARS = 30;
/** If still flat at this bar and the trend is up, buy and ride instead. */
const FALLBACK_BAR = 600;
/** Bars that must have passed since the last exit before the fallback may fire. */
const FALLBACK_REST_BARS = 120;
/** After this many losing round trips in a row, stop buying dips. */
const MAX_CONSEC_LOSSES = 2;
/** Each order caps its slippage at 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The last SMA_BARS closes, oldest first, and their running sum. */
const closes: number[] = [];
let closesSum = 0;
/** The 120-bar EMA of closes, null until its first span has been seen. */
let ema: number | null = null;
const emaWarm: number[] = [];
/** The previous bar's close, for the bounce check. */
let prevClose: number | null = null;
/** The highest close since the current entry, null while flat. */
let peak: number | null = null;
/** The bar seq of the last exit (sell decision), -1 before the first trade. */
let lastExitSeq = -1;
/** Losing round trips in a row; reset by any winning exit. */
let consecLosses = 0;
/** Whether the current position's exit has already been tallied for the breaker. */
let exitTallied = false;

/** The mean of the last SMA_BARS closes, or null before that many bars. */
function sma(): number | null {
  if (closes.length < SMA_BARS) return null;
  return closesSum / SMA_BARS;
}

/** Fold one close into the indicators. */
function push(close: number): void {
  closes.push(close);
  closesSum += close;
  if (closes.length > SMA_BARS) closesSum -= closes.shift()!;
  if (ema !== null) {
    ema += (2 / (EMA_BARS + 1)) * (close - ema);
  } else {
    emaWarm.push(close);
    if (emaWarm.length === EMA_BARS) ema = emaWarm.reduce((a, x) => a + x, 0) / EMA_BARS;
  }
}

/**
 * Whether the position held at this close should exit: the trailing stop, or the
 * hard stop against its cost. Tallies the round trip for the loss breaker the
 * first time it fires for this position.
 */
function shouldExit(state: BarsState, held: { qty: bigint; cost: bigint }, close: number): boolean {
  if (peak !== null && close > peak) peak = close;
  const trailHit = peak !== null && ((peak - close) / peak) * 10_000 >= TRAIL_BPS;
  const value = state.value(SYMBOL, held.qty);
  const stopHit = value * BigInt(10_000) <= held.cost * BigInt(10_000 - STOP_BPS);
  if (!trailHit && !stopHit) return false;
  if (!exitTallied) {
    exitTallied = true;
    if (value < held.cost) consecLosses += 1;
    else consecLosses = 0;
  }
  return true;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    push(close);
    const bounced = prevClose !== null && close > prevClose;
    prevClose = close;
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const held = state.positions.get(SYMBOL);
    const mean = sma();

    if (held !== undefined) {
      if (peak === null) peak = close;
      if (shouldExit(state, held, close)) {
        lastExitSeq = state.seq;
        peak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: no dip buying while the loss breaker is tripped.
    const dipReady =
      mean !== null &&
      consecLosses < MAX_CONSEC_LOSSES &&
      state.seq - lastExitSeq >= COOLDOWN_BARS &&
      ((mean - close) / mean) * 10_000 >= DIP_BPS &&
      bounced;
    const fallbackReady =
      state.seq >= FALLBACK_BAR &&
      ema !== null &&
      close > ema &&
      state.seq - lastExitSeq >= FALLBACK_REST_BARS;
    if (!dipReady && !fallbackReady) return [];

    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const size = state.cash < byWeight ? state.cash : byWeight;
    if (size === 0n || size < BigInt(fees.min_notional_quote_units)) return [];
    peak = close;
    exitTallied = false;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
