# Edgeline T4.4a — What the Detector's CLV Says to Tune

Spec §15's T4.4a asks for this report once 200 opportunities have a clean closing-line value:
the distribution, and what it says to tune. There are now 320. They cover every +EV opportunity
the detector found from 2026-09-24 to 2026-11-03 whose game has started, on 159 games. The short version: the detector
finds real value in football and none yet in basketball or hockey, and edges under 3% are noise.
Two changes follow, one already made. The rest of the levers should stay where they are. The
go-live gate (T4.4b) passes as written, but it was measured under alert rules that changed this
week, so the recommendation is two more weeks of paper first.

## 1. Recommendations

| # | Change | Status | Evidence in one line |
|---|---|---|---|
| R1 | Pause NBA and NHL alerts (`alerts_paused_sports`) | **Done 2026-11-04** | NBA CLV −3.40%, NHL +0.25%; both intervals include zero or worse |
| R2 | Raise `ev_threshold_pct` from 2 to 3 | **Done 2026-11-04** | Edges under 3% average −1.14% at the close and beat it 51% of the time |
| R3 | Markets: leave `markets_featured` alone | No change | Spreads and totals show no edge, but football almost never produces them |
| R4 | Books: no change yet; watch DraftKings | No change | DraftKings as the bet book: +1.59% in football, interval includes zero, n=20 |
| R5 | Poll times: no change | No change | Every lead-time band is positive in football |
| R6 | Stay on paper two more weeks, then decide | **Agreed 2026-11-04** — review about 11-18 | T4.4b passed under the old cooldown; the new rules' picks are untested |

### R1 — NBA and NHL stay paused until their CLV turns

Both sports were alerting and losing: NBA 0 for 11 paper bets (−$45), NHL 4 for 15 against 6.7
expected (−$46). That is $91 of the $104 lost. The detector's own measurement agrees that this
isn't bad luck. NBA's opportunities average **−3.40%** at the close (90% interval −7.85% to
+0.59%, 31 opportunities on 17 games) and beat it 42% of the time. NHL's average **+0.25%**
(−1.64% to +2.00%) and beat it 46% of the time. A book's own margin is about 2–3%, so an
"edge" that ends up at zero is the margin being paid.

Both sports are still polled and measured: the setting stops alerts, not data. **Unpause a
sport when its opportunity CLV is positive with at least 50 measured**, and its interval no
longer reaches below zero.

### R2 — Raise the detection threshold to 3%

The 2–3% band is where the detector is wrong. Across all sports:

| Detected edge | n | Games | Mean CLV | 90% interval | Median | Beat close |
|---|---|---|---|---|---|---|
| 2–3% | 102 | 68 | −1.14% | −3.13% to +0.54% | +0.72% | 51% |
| 3–5% | 78 | 46 | +3.64% | +1.01% to +6.29% | +1.66% | 72% |
| 5–10% | 85 | 54 | +7.18% | +4.18% to +10.69% | +5.88% | 74% |
| 10%+ | 55 | 28 | +13.16% | +9.18% to +17.54% | +9.71% | 87% |

The same holds in football alone, where alerts stay on. 2–3% edges average **−0.77%** and beat
the close 58% of the time, while everything from 3% up beats it 80% of the time.

Edge retention, the closing value as a share of the edge detected, tells the same story for
football moneylines. Edges of 2–3% keep −36%, so they reverse. 3–5% keep 142% and 5–10% keep
122%: the market moves further toward us than the detector thought. 10%+ keep 80%. Above 3%, a
detected edge is a real edge.

**Effect:** in football the threshold would keep 187 of 261 opportunities, at +8.86% mean CLV
with 80% beating the close, and drop 74 that average −0.77%. Volume falls by about a quarter
from what the per-game cooldown would send. That still leaves well over the old rule's
one-per-sport trickle.

**The counterpoint, stated plainly:** the graded football *bets* split the other way. The 13
with edges under 3% are 5 for 13 and +$3.14; the 35 at 3% and up are 5 for 35 and −$18.75. Those
35 are mostly long shots, though, and football as a whole has won 10 bets against 10.1 expected.
Results on 48 bets mostly at +300 and longer are noise. Closing value is the better estimate, and
it is not close: −0.77% against +8.86%.

`min_edge_to_bet_pct` (1.5) sits below the threshold, so it does nothing either way. Leave it.

### R3 — Markets: no change

Spreads average +0.66% (20, beat 50%) and totals −0.01% (12, beat 50%), so neither shows an
edge. But football produced only four of them in six weeks; nearly all came from NBA and NHL,
now paused. Dropping them from `markets_featured` would cut each poll from 3 credits to 1, but
the budget isn't tight (363 of 1,000 used by 11-04), and they still feed the measurement. Revisit
only if credits get tight.

### R4 — Books: no change, but DraftKings is the one to watch

When the book offering the price is DraftKings, the edge rarely holds: **+1.59%** in football
(interval −0.88% to +4.33%, n=20, beat 55%), against +5.45% to +8.73% for every other book.
That fits DraftKings being the sharpest of the seven: a DraftKings price that disagrees with the
others is more often the others lagging than DraftKings being stale. Disabling DraftKings would
also remove it from the consensus, which needs five books, so that is the wrong lever. A
"never bet at this book" setting would need code, and 20 opportunities don't justify it yet.
**Revisit at 50.**

BetRivers, Bally Bet and betPARX look best (about +6.2% each, 80% beat). They share one pricing
feed (Kambi), though, so their 124 rows are one source of edge counted three times.

### R5 — Poll times: no change

Football CLV is positive in every lead-time band:

| Detected before the game | n | Mean CLV | Beat close |
|---|---|---|---|
| under 2 h | 28 | +5.03% | 79% |
| 2–6 h | 41 | +9.69% | 88% |
| 6–24 h | 52 | +6.21% | 77% |
| 1–3 days | 110 | +5.34% | 67% |
| 3 days+ | 30 | +5.04% | 70% |

The 2–6 hour band is the strongest, which supports the plan's same-day slots. Nothing argues
for moving them. The laptop sleeping through Saturday's 10:30 and 14:00 slots (10-24) cost more
than any timing change would gain; that's a power setting, not a schedule one.

### R6 — Two more weeks of paper, then the go-live decision

T4.4b is met as written: 67 recommended opportunities with a clean CLV average **+6.03%** (+2.18%
to +10.47%), against +4.34% for the 253 not recommended. That is positive, and not below the
other side. But those 67 were chosen by the old one-alert-per-sport cooldown, which always
picked the single biggest edge. The rules changed this week: per-game alerting on 11-01, the
NBA and NHL pause on 11-04, and R2 if accepted. The recommendations from here on are a different
selection, and it hasn't been measured. **Two weeks of paper under the new rules should produce
roughly 50 new recommendations.** If their CLV is positive and close to the opportunity side,
the evidence for going live is about as strong as this sample allows.

Turning `paper_mode` off stays your decision alone (§16.2); nothing here will do it.

### Follow-up: a sharp benchmark (2026-11-04)

The biggest caveat below is that the close is a soft consensus. The Odds API does carry
Pinnacle, the market-making book whose closing line is the standard estimate of true odds: a test
request priced 55 of the next 56 college games and all 15 NFL games, at 1 credit a request.
Pinnacle would be recorded at each closing capture as a reference only, never in the consensus
and never a bet, so every opportunity gets a second CLV against it. Naming the ten enabled books
plus Pinnacle bills like the two regions the capture already asks for, so that costs about
nothing extra; a separate Pinnacle-only request would be about 85 credits a month.

## 2. What CLV can and can't tell you before real money

- **The "close" is a consensus of seven Maryland retail books.** There's no sharp book among
  them (Pinnacle and Circa aren't available here), so beating a soft consensus is a weaker
  claim than beating a sharp close. The +6% is likely an overstatement of the true edge, by an
  unknown amount.
- **A paper price is not a filled bet.** The alert has to reach you and you have to place it
  before the line moves. The soft books that supply most of the edge (the Kambi three, FanDuel)
  also limit accounts that win. Expect some stakes to be cut or refused.
- **The dollar record will mostly be variance.** The median recommendation is about +375, which
  wins about one time in four. At the current caps ($1,000 bankroll, at most 2% a bet), a
  month's P&L will swing by more than its expected gain. Judge the system by CLV, weekly, not
  by its balance.
- **Weeks vary.** Football's weekly CLV ran +4.7% to +10.4% for four weeks, then −1.07% in W43
  (10-19 to 10-25), then +5.03% in W44. One bad week is normal; two in a row would be a signal.

## 3. The full distribution

All sports, every measured +EV opportunity, circular measurements left out. CLV is the bet's
expected value at the closing consensus: `closing_prob × price − 1`.

| Cut | n | Games | Mean CLV | 90% interval | Median | Beat close |
|---|---|---|---|---|---|---|
| **All** | 320 | 159 | +4.69% | +3.00% to +6.52% | +2.58% | 68% |
| NCAAF | 224 | 99 | +6.26% | +4.20% to +8.39% | +4.50% | 75% |
| NFL | 37 | 26 | +5.34% | +0.67% to +12.30% | +1.38% | 68% |
| NBA | 31 | 17 | −3.40% | −7.85% to +0.59% | −2.06% | 42% |
| NHL | 28 | 17 | +0.25% | −1.64% to +2.00% | −0.34% | 46% |
| Moneyline | 288 | 140 | +5.17% | +3.26% to +7.11% | +3.14% | 70% |
| Spread | 20 | 11 | +0.66% | −1.91% to +2.76% | +0.78% | 50% |
| Total | 12 | 10 | −0.01% | −1.66% to +1.24% | +0.56% | 50% |
| Priced under 2.0 | 5 | 5 | −2.68% | −5.85% to +0.14% | −1.04% | 20% |
| 2.0–3.0 | 50 | 35 | −1.14% | −4.58% to +1.45% | +1.10% | 58% |
| 3.0–5.0 | 90 | 49 | +2.73% | −0.35% to +6.29% | +1.48% | 63% |
| 5.0–10.0 | 113 | 53 | +5.29% | +2.86% to +7.95% | +3.14% | 72% |
| 10.0+ | 62 | 25 | +11.76% | +7.90% to +16.11% | +9.63% | 82% |
| Closing-line source | 264 | 132 | +5.12% | +3.00% to +7.29% | +2.89% | 68% |
| Derived source | 56 | 27 | +2.70% | +0.70% to +4.66% | +1.51% | 70% |
| Recommended | 67 | 59 | +6.03% | +2.18% to +10.47% | +1.91% | 60% |
| Not recommended | 253 | 133 | +4.34% | +2.56% to +6.15% | +2.77% | 71% |

Low prices look bad mostly because low prices come with small edges. With the edge at 3% or
more, football bets priced under 3.0 are slightly positive (+1.23%, 10 of them), so there's no
separate odds filter to add.

The paper ledger, for completeness: 76 graded bets (8 set aside as duplicates or detected after
the start), 15 won, −$104 on $353 staked. Football alone is 10 won against 10.1 expected.

## 4. Method

- **Source:** `edgeline-opportunities`, every `type: ev` document with a stored `clv_pct`,
  through 2026-11-04: 394 +EV opportunities, 320 measured. 53 circular measurements (the closing
  price was the detecting poll's own) and 21 not yet measurable are left out, as
  `python -m edgeline.clv` does.
- **CLV** is §12's `clv_pct`: the closing consensus fair probability times the price at first
  detection (or at the alert, where there was one), minus one. It's the expected return if the
  close is right.
- **Intervals** are 90% cluster bootstraps over games, 4,000 draws. Several opportunities on one
  game (three books with one price, or both sides of a market) aren't independent evidence, so
  the game is the unit resampled.
- **Paper results** are joined result → recommendation → opportunity. "Expected" wins use the
  detector's own probability, `(1 + edge) / price`.
- Reproduce with `python -m edgeline.clv` for the top-line split. The cuts here came from
  one-off scripts over the same documents.
