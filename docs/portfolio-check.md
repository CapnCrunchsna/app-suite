# Portfolio Check — advisor vs. index comparison

Portfolio Check is a single-page local tool. It takes your holdings and your advisor's fee schedule and shows what the current setup costs, what that cost compounds to, and how much value the advisor has to add each year to break even with a self-managed index portfolio. It presents comparisons and education, never a recommendation. This document records the method, so it changes in the same commit as the code in `apps/portfolio-check`.

## 1. Scope and build order

The build order was agreed before any code existed:

1. **Advisor vs. index comparison**: built (this app).
2. **Portfolio tracker**, with drift and rebalancing suggestions: not started. Whether it gets built depends on what #1 shows on real numbers.
3. **Contribution/DCA planner**: not started. It depends on #1 for the same reason.

Hard limits that apply to all three:

- **No market-timing signals.** A backtester that shows how timing rules did historically is allowed. Recommending trades from one is not.
- **No brokerage logins, stored credentials or aggregator APIs** (Plaid and the like). Data comes in only by manual entry or a CSV export.
- **Copy says what the numbers show, never what to do.** The page carries a disclaimer that it is not personalized investment, tax or legal advice.
- **Real financial data is never committed.** The repo holds only made-up sample data, with fictional tickers.

## 2. Storage

Inputs live in the browser's `localStorage` under one key, `portfolio-check:inputs:v1`, and nowhere else. There is no backend. This departs from the workspace's Elasticsearch-first preference on purpose: the tool has one user, a few kilobytes of data and no query needs, and keeping it in the browser is also the privacy guarantee. Nothing leaves the machine.

The sample data is never saved over the user's numbers. It only becomes saved state once the user edits it.

## 3. Method

All calculations live in `src/app/calc/`. Rates there are fractions. The UI holds percents, and `inputs.ts` converts them once.

**All-in cost** is the advisory fee plus the value-weighted fund expense ratio times the balance. The page shows it in dollars and as a percent of the balance.

**Fee schedules** come in two AUM conventions, and the difference is real money:

| Method | $600k on 1% to $500k / 0.8% above |
|---|---|
| `tiered`: each slice pays its own rate | $5,000 + $800 = $5,800 |
| `whole-balance`: the whole balance pays the landing tier's rate | 0.8% × $600k = $4,800 |

Optional extras:

- **Minimum fee.** The bill is never less than this amount.
- **Flat-fee schedules.** A fixed dollar amount per year, instead of a percent.
- **Capped last tier.** If the last tier has an upper limit, the balance above it is billed at that tier's rate. It is never treated as free.

**Matched index portfolio.** It holds the same value-weighted stock share as the current holdings, split between a stock index fund and a bond index fund. The default expense ratios are 0.03% for stocks and 0.04% for bonds; both are editable. It pays no advisory fee.

**Projection.** Both scenarios get the same gross return. Each year runs three steps:

1. `grown = balance × (1 + g)`
2. `cost = grown × fundEr + advisoryFee(grown)`
3. `balance = grown − cost + contribution`

The gross return deliberately cancels out of the comparison. Only cost differs between the two lines.

**Break-even** is the extra annual return the current setup needs to finish level with the index portfolio. It is found by bisection, because tiered fees have no closed form. The page shows it as a rate and as dollars this year. Next to it, the page shows the taxable balance, because that balance limits how much value tax-loss harvesting can add.

**Look-back:**

- The user enters, for each year, the value at the start, the net deposits and withdrawals, and the value at the end. The return comes from Modified Dietz with mid-year flows.
- The benchmark for each year is the stock share × the S&P 500 return, plus the bond share × the US Aggregate return, minus the index expense ratio.
- The benchmark's dollar path replays the user's own cash flows using the same mid-year convention.
- The default benchmark returns cover 2015–2025. They are approximate and editable, and the page says so.

## 4. Verification

Unit tests in `src/app/calc/*.spec.ts` cover:

- tiered and whole-balance billing, minimum fees, tiers entered out of order, a capped last tier, and flat fees;
- the projection against its closed form, `B₀((1+g)(1−fee))ⁿ`;
- the claim that 1% a year costs about a quarter of the ending balance over 30 years (the test pins it at 25–27%);
- that the solved break-even rate actually closes the gap;
- the Dietz math, and the benchmark replay of the user's cash flows;
- that the CSV parser keeps positions, drops totals and footers, and never outputs an account number.

## 5. Next steps

- **The user enters real holdings and the fee schedule.** These come from the advisor's Form ADV Part 2A and a positions CSV with account numbers removed.
- **Decide on #2 and #3 once the real numbers are in.**
