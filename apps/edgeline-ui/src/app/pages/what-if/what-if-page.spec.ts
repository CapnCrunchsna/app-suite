/**
 * The What-if page: its default view is the Results page's own P&L, and each
 * control re-totals the tiles, chart and tables against the same slice.
 */

import { TestBed } from '@angular/core/testing';
import type { WhatIfBet, WhatIfResponse } from '@metrum/edgeline-api-client';

import { WhatIfPage } from './what-if-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function row(id: string, overrides: Partial<WhatIfBet> = {}): WhatIfBet {
  return {
    id, sport_key: 'americanfootball_ncaaf', event_id: id, market_key: 'h2h', selection: 'Owls',
    book_key: 'fanduel', price_decimal: 5, edge_pct: 6, clv_pct: 10, outcome: 'loss',
    starts_at: `2026-11-0${(Number(id.replace(/\D/g, '')) % 9) + 1}T17:00:00Z`, recommended: true,
    ...overrides,
  };
}

const DATA: WhatIfResponse = {
  paper: [
    row('p1', { stake_cents: 400, pnl_cents: 1600, outcome: 'win' }),
    row('p2', { stake_cents: 400, pnl_cents: -400 }),
    row('p3', { stake_cents: 500, pnl_cents: -500, sport_key: 'basketball_nba', price_decimal: 2.2 }),
  ],
  opportunities: [
    row('o1', { outcome: 'win' }),
    row('o2'),
    row('o3', { sport_key: 'basketball_nba', price_decimal: 2.2 }),
    row('o4', { price_decimal: 12 }),
  ],
  paper_without_clv: 0,
  opportunities_without_clv: 2,
};

class ApiStub {
  getWhatIf() {
    return Promise.resolve(DATA);
  }
  getSettings() {
    return Promise.resolve({ alerts_paused_sports: ['basketball_nba'] });
  }
  getHealth() {
    return Promise.resolve({ paper_mode: true, kill_switch: false });
  }
}

async function render() {
  TestBed.configureTestingModule({
    imports: [WhatIfPage],
    providers: [{ provide: EdgelineApiService, useValue: new ApiStub() }],
  });
  const fixture = TestBed.createComponent(WhatIfPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function tile(el: HTMLElement, label: string): string {
  const found = [...el.querySelectorAll('.tile')].find(
    (t) => t.querySelector('.tile__label')?.textContent?.trim() === label,
  );
  return found?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function click(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
  if (!button) throw new Error(`no button "${text}"`);
  button.click();
}

describe('WhatIfPage', () => {
  it('opens on the paper ledger as staked, which is the Results page’s P&L', async () => {
    const { el } = await render();
    expect(tile(el, 'Bets')).toContain('3');
    expect(tile(el, 'P&L')).toContain('+$7.00'); // 16 - 4 - 5
    expect(tile(el, 'Luck range')).toContain('to');
    expect(el.querySelector('el-luck-chart svg')).not.toBeNull();
  });

  it('marks a paused sport and drops it from every figure when toggled off', async () => {
    const { fixture, el } = await render();
    const nba = [...el.querySelectorAll('.chip')].find((c) => c.textContent?.includes('NBA'));
    expect(nba?.textContent).toContain('paused');
    (nba as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(tile(el, 'P&L')).toContain('+$12.00');
    expect(nba?.getAttribute('aria-pressed')).toBe('false');
  });

  it('judges every opportunity at a flat stake, and leaves out the long shots on request', async () => {
    const { fixture, el } = await render();
    click(el, 'Every opportunity');
    fixture.detectChanges();
    expect(tile(el, 'Bets')).toMatch(/^Betss*4/);
    // As staked has no meaning without a stake: disabled, and flat applies.
    const asStaked = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'As staked');
    expect(asStaked?.disabled).toBe(true);
    click(el, 'Up to +900');
    fixture.detectChanges();
    expect(tile(el, 'Bets')).toMatch(/^Betss*3/);
    expect(el.textContent?.replace(/\s+/g, ' ')).toContain('2 settled opportunities have no closing-line value');
  });

  it('breaks the view down by the chosen dimension', async () => {
    const { fixture, el } = await render();
    click(el, 'Odds');
    fixture.detectChanges();
    const labels = [...el.querySelectorAll('ui-panel table tbody tr td:first-child')].map((td) => td.textContent?.trim());
    expect(labels).toContain('+100 to +200');
    expect(labels).toContain('+400 to +900');
  });
});
