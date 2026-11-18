// btc-race-24h-20261118-1444 — DP-fitted entry.
//
// How this bot was built: an exact dynamic-programming oracle was run over
// the dev window first (ceiling +$56.74 at 6 round trips, +$63.65 unlimited),
// and its profitable legs were then fitted with causal rules that only look
// at past closes. The oracle is a fit target, never a schedule: no bar
// number, date, or price from the dev window appears anywhere below, and the
// same rules run unchanged on the unseen race window.
//
// Three rule families, one position at a time, long-only, all-in:
//
//   1. snapback — an oversold snap: RSI(7) under 25 while the close is down
//      at least 80 bps over both 30 and 60 bars, already ticking up over
//      two bars. Quick exit (+120 bps / 90 bars): it harvests sharp V
//      bounces, the kind the oracle catches in its early legs.
//   2. patient — a deep, slow leg: down at least 110 bps over 120 bars,
//      ticking up, and the close back above its own 10-bar average. Slow
//      exit (+185 bps / 480 bars): the window's big legs are grinds that
//      gain ~120-155 bps over 230-350 bars, and trailing or time-decay
//      exits were measured to cut those legs short, so this arm simply
//      waits.
//   3. bounce — a Bollinger-band bounce: the close sits in the bottom 3.5%
//      of its 20-bar, 2-sigma band (%b < 0.035) and is ticking up. Fast
//      exit (+40 bps, stop -35 bps, 105 bars): the only family that stayed
//      profitable in the second half of the dev window.
//
// Priority when several families trigger on the same bar: snapback, then
// patient, then bounce. Exits compare the position's current value with its
// cost (so the 4 bps buy fee is inside every take/stop decision).
//
// Honest caveat: the DP fit maximises the DEV score only. The dev window
// never decides prizes — the live 24 h race window does. These rules are
// the live logic; the dev PnL is only the gate plus a noisy proxy.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const BPS = 10000n;
const TICKER = 'CBBTC';
const SLIP_LIMIT = 100;

// --- snapback (RSI oversold + sharp fall + turn) ---
const SNAP_RSI_PERIOD = 7;
const SNAP_RSI_CEILING = 25;
const SNAP_FALL_SHORT = 80n; // bps over 30 bars
const SNAP_FALL_LONG = 80n; // bps over 60 bars
const SNAP_WARMUP = 60; // needs more than 60 closes seen
const SNAP_TAKE = 120n;
const SNAP_HOLD = 90;

// --- patient (deep 120-bar dip + reclaim of the 10-bar average) ---
const GRIND_SPAN = 120;
const GRIND_FALL = 110n; // bps over 120 bars
const GRIND_TAKE = 185n;
const GRIND_HOLD = 480;

// --- bounce (bottom of the Bollinger band + turn) ---
const BAND_WINDOW = 20;
const BAND_WIDTH = 2; // sigmas
const BAND_PCT_CEILING = 0.035; // %b strictly below this
const BAND_TAKE = 40n;
const BAND_STOP = 36n; // exit if value drops 36 bps under cost — centred
// mid-plateau: the flat region for this stop is 31-40 bps (the 798
// bounce trade dips just past -30 bps mid-hold, so 30 is a cliff;
// 31-40 all keep the same six trades). Neighbours at +/-5 bps are
// 31 (+$32.00) and 41, both inside the flat region.
const BAND_HOLD = 105;

// --- price history (raw integer closes, as the harness sends them) ---
const history: bigint[] = [];

// --- RSI(7), Wilder smoothing, float64 (same construction as the kit's
// rsi-bollinger baseline): the first 7 one-bar changes seed simple
// averages of gains and losses; after that each average is smoothed. ---
let previousClose: number | null = null;
let seedMoves: number[] = [];
let meanGain: number | null = null;
let meanLoss: number | null = null;

function feedRsi(closeAsNumber: number): number | null {
  if (previousClose !== null) {
    const move = closeAsNumber - previousClose;
    if (meanGain === null || meanLoss === null) {
      seedMoves.push(move);
      if (seedMoves.length === SNAP_RSI_PERIOD) {
        let gains = 0;
        let losses = 0;
        for (const m of seedMoves) {
          if (m > 0) gains += m;
          else losses -= m;
        }
        meanGain = gains / SNAP_RSI_PERIOD;
        meanLoss = losses / SNAP_RSI_PERIOD;
      }
    } else {
      const up = move > 0 ? move : 0;
      const down = move < 0 ? -move : 0;
      meanGain = (meanGain * (SNAP_RSI_PERIOD - 1) + up) / SNAP_RSI_PERIOD;
      meanLoss = (meanLoss * (SNAP_RSI_PERIOD - 1) + down) / SNAP_RSI_PERIOD;
    }
  }
  previousClose = closeAsNumber;
  if (meanGain === null || meanLoss === null) return null;
  const total = meanGain + meanLoss;
  return total === 0 ? 50 : (100 * meanGain) / total;
}

// --- %b: where the latest close sits inside its 20-bar Bollinger band.
// Population variance (divide by the window), two-pass mean/variance. ---
function bandPosition(): number | null {
  const n = history.length;
  if (n < BAND_WINDOW) return null;
  let sum = 0;
  for (let k = n - BAND_WINDOW; k < n; k++) sum += Number(history[k]!);
  const average = sum / BAND_WINDOW;
  let squared = 0;
  for (let k = n - BAND_WINDOW; k < n; k++) {
    const diff = Number(history[k]!) - average;
    squared += diff * diff;
  }
  const spread = Math.sqrt(squared / BAND_WINDOW);
  const bottom = average - BAND_WIDTH * spread;
  const top = average + BAND_WIDTH * spread;
  if (top === bottom) return null;
  return (Number(history[n - 1]!) - bottom) / (top - bottom);
}

// --- integer bps comparisons (no floats in any trigger or exit) ---
function fellMoreThan(now: bigint, ref: bigint, bps: bigint): boolean {
  return now * BPS < ref * (BPS - bps);
}

function roseAtLeast(now: bigint, ref: bigint, bps: bigint): boolean {
  return now * BPS >= ref * (BPS + bps);
}

// Turned up: the latest close is above the close two bars ago.
function turnedUp(latest: bigint): boolean {
  return latest > history[history.length - 3]!;
}

function wantsSnapback(latest: bigint, rsi: number | null): boolean {
  if (rsi === null || !(rsi < SNAP_RSI_CEILING)) return false;
  if (history.length <= SNAP_WARMUP) return false;
  if (!fellMoreThan(latest, history[history.length - 1 - 30]!, SNAP_FALL_SHORT)) return false;
  if (!fellMoreThan(latest, history[history.length - 1 - 60]!, SNAP_FALL_LONG)) return false;
  return turnedUp(latest);
}

function wantsPatient(latest: bigint): boolean {
  if (history.length <= GRIND_SPAN) return false;
  if (!fellMoreThan(latest, history[history.length - 1 - GRIND_SPAN]!, GRIND_FALL)) return false;
  if (!turnedUp(latest)) return false;
  // Close reclaimed above its 10-bar average: 10 * latest > sum of last 10.
  let sum = 0n;
  for (let k = history.length - 10; k < history.length; k++) sum += history[k]!;
  return latest * 10n > sum;
}

function wantsBounce(latest: bigint, pctb: number | null): boolean {
  if (pctb === null || !(pctb < BAND_PCT_CEILING)) return false;
  if (history.length < 3) return false;
  return turnedUp(latest);
}

function exitFor(family: string): { take: bigint; hold: number; stop: bigint } {
  if (family === 'snapback') return { take: SNAP_TAKE, hold: SNAP_HOLD, stop: 0n };
  if (family === 'bounce') return { take: BAND_TAKE, hold: BAND_HOLD, stop: BAND_STOP };
  return { take: GRIND_TAKE, hold: GRIND_HOLD, stop: 0n };
}

// --- run state ---
let barsInTrade = 0;
let openFamily = '';

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(TICKER);
    if (close === null) return [];
    history.push(close);
    const rsi = feedRsi(Number(close));

    const held = state.positions.get(TICKER);
    const qty = held?.qty ?? 0n;
    const cost = held?.cost ?? 0n;

    if (qty > 0n) {
      barsInTrade++;
      const rule = exitFor(openFamily);
      const value = state.value(TICKER, qty);
      const reachedTake = roseAtLeast(value, cost, rule.take);
      const hitStop = rule.stop > 0n && value * BPS <= cost * (BPS - rule.stop);
      const tooLong = barsInTrade >= rule.hold;
      if (reachedTake || hitStop || tooLong) {
        barsInTrade = 0;
        openFamily = '';
        return [{ side: 'sell', symbol: TICKER, qty, max_slippage_bps: SLIP_LIMIT }];
      }
      return [];
    }

    barsInTrade = 0;
    openFamily = '';
    const latest = history[history.length - 1]!;
    const pctb = bandPosition();

    let family = '';
    if (wantsSnapback(latest, rsi)) family = 'snapback';
    else if (wantsPatient(latest)) family = 'patient';
    else if (wantsBounce(latest, pctb)) family = 'bounce';

    if (family !== '' && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
      openFamily = family;
      return [
        {
          side: 'buy',
          symbol: TICKER,
          notional_quote_units: state.cash,
          max_slippage_bps: SLIP_LIMIT,
        },
      ];
    }
    return [];
  },
});
