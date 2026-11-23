# Edgeline Redesign — Pinnacle as the Fair Price, and an Offer Evaluator

By 2026-11-22 Edgeline had shown a real but small edge: football opportunities beat the closing line by
about 2–3% since the 11-04 rule changes, and about the same against Pinnacle's close, mostly on long
shots, in a college season that ends 11-29. On free data it polls one to three times a day, so many of
those prices are gone before a person could bet them, and at a $1,000 bankroll the edge is worth tens of
dollars a season. The user asked for both of the changes proposed that day. Phase 1 changes how the
detector judges a price. Phase 2 adds the use where free, slow data is not a handicap: pricing the books'
own offers. Both stay on The Odds API's free tier and keep §16's rule: Edgeline recommends, it never
places a bet.

## 1. Phase 1 — Pinnacle as the fair price

**The change.** Today a price is judged against the average of the other retail books, with each one's
margin removed. Phase 1 judges it against Pinnacle's line, with its margin removed. Pinnacle is the
market-making book, and its line is the standard estimate of the true odds. Our picks already beat its
close, so it is the better yardstick to find them with.

**Measured side by side, not swapped blind.** Pinnacle's prices exist only from the closing captures
since 11-05, so the new detector cannot be backtested. Instead every price is scored both ways on every
poll:

- Each opportunity stores `consensus_edge_pct` and `sharp_edge_pct`.
- A new setting, `fair_price_source` (`consensus` or `pinnacle`), decides which edge is `edge_pct`, the
  one that is thresholded, staked and alerted.
- A price that passes only the other method is stored as a **shadow** opportunity. It is never
  alerted, but it is settled and measured at the close like any other.
- So the What-if page can answer "what if the other detector had been in charge" on the same games, at
  no extra cost.

**Polls.** Moneylines only (`markets_featured: ["h2h"]`): spreads and totals have shown no edge and were
almost all NBA and NHL. Each poll names the ten enabled books plus Pinnacle: 11 names, which bill as 2
units. That is 2 credits a poll against 3 today, about 190 credits a month instead of 280. Pinnacle's
poll prices go to `edgeline-sharp-closes` with `is_closing: false`, never to the snapshots, so the
consensus never reads them.

**What stays.** The 3% threshold, applied to whichever edge is in charge. One recommendation per pick.
Paper mode. NBA and NHL paused. A game Pinnacle does not price yields no Pinnacle edge: under
`pinnacle` it is skipped, and under `consensus` it is unaffected.

**The switch.** `fair_price_source` goes to `pinnacle` when Phase 1 ships, so the paper recommendations
from then on are the new detector's, and the consensus detector runs as the shadow. **Read it after the
bowls (about 2027-01-05)**, by the same rules as T4.4a:

- the Pinnacle detector's opportunity CLV against Pinnacle's close, positive with its interval clear of
  zero;
- beside the consensus detector's on the same weeks, on the What-if page's new detector toggle;
- whichever is better stays in charge. If neither holds an edge, park the detector.
- **If it holds, turn on real-time alerting.** Edgeline was always meant to hand over a finished bet
  for the user to place. Today recommendations go only to a log; going live needs alerts that arrive
  while the price is still there (Discord, §9). That is the step after this read, taken only once the
  edge has shown it is worth acting on.

## 2. Phase 2 — the offer evaluator (dropped 2026-11-22)

**Dropped.** The user's rule for any of these tools: largely hands-off, little to no work for the
user. Every route left needs a daily step. Claude cannot read the books' sites itself, and screenshots
mean opening each app. The books' promo emails were the only hands-off route, and they carry few of
the boosts. A pricing sketch stays below for the record.

**Why.** For a bettor in Maryland, the steadiest positive-value bets are the books' own offers: profit
boosts, odds boosts, bonus bets, "no sweat" refunds. They often carry 10–30% expected value, they last
hours rather than minutes, and they need no bankroll to speak of, so neither of Phase 1's limits applies.
The books show them in their apps, not in any feed, so they come in by hand.

**What it does.** A new Offers page:

- **Enter an offer:** the book, the game and selection (picked from stored events), the offer type and
  its terms (boosted price, profit-boost %, bonus-bet amount, refund cap), and the stake limit.
- **Price it:** the fair probability comes from Pinnacle, from the latest stored poll if it is recent,
  or one on-demand request for that game (1 credit). The page shows expected profit in dollars and %, a
  verdict, and for a bonus bet the expected cash it converts to.
- **Line shop:** the same selection at every enabled book, so a bet you were making anyway goes where it
  pays most.
- **Record and settle:** offers taken are stored and settled from the game's score like any other bet,
  so the page reports value taken against value expected, the same way the What-if page does.

**Out of scope for now:** parlay and same-game-parlay boosts. Pricing them needs correlations between
legs that no free feed carries, so the page says so rather than guessing. The same goes for player
props: the free tier cannot afford them.

**Decisions (2026-11-22).**

1. **Offer types:** odds and profit boosts on singles, and bonus bets. No-sweat bets and deposit
   matches can come later.
2. **Its home:** a page in Edgeline, beside What if, reusing its events, Pinnacle prices, books,
   settlement and luck maths.
3. **Entry: not typed, and not through the Claude API.** The user would not keep up with typing, and
   wants the reading done on their Claude subscription instead. Claude cannot open the books' sites
   itself: the built-in browser refuses sportsbook domains as a safety restriction, and that is not to
   be worked around. So the offers have to reach Claude some other way:
   - **Screenshots (proposed):** the user screenshots each book's boosts tab, a few seconds a book, and
     drops them into a Claude Code session. A skill reads them, matches each to a stored game and
     selection, posts them to Edgeline (`POST /api/offers`), and answers with the verdicts.
   - **Promo emails (possible):** if the books email their boosts, a scheduled Claude task could read
     them through a Gmail connector. It depends on the books sending them, and many boosts only appear
     in the apps.

   Either way, Edgeline only gains an intake endpoint and the Offers page; the reading is a skill. A
   caveat on value: many daily boosts are on parlays or same-game parlays, which cannot be priced (see
   below), so the number of priceable single-bet boosts a day is not yet known.

## 3. Order of work

| Step | What | Credits | Status |
|---|---|---|---|
| 1a | Pinnacle in the polls, both edges stored, `fair_price_source`, shadow opportunities | −90 a month | **Done 2026-11-22** |
| 1b | What-if page: detector toggle (consensus or Pinnacle edge), shadow rows included | none | **Done 2026-11-22** |
| 1c | Switch to `pinnacle`, moneylines only; spec §3.2, §4.3, §6.4, §11.1 amended | — | **Done 2026-11-22**: projected 404 credits a month, from 506 |
| 2 | The offer evaluator | — | **Dropped 2026-11-22**: no hands-off way to get the offers in (§2) |
| — | Read Phase 1 after the bowls, about 2027-01-05 | — | |
