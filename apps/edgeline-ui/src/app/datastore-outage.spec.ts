/**
 * Reading the API's "Elasticsearch is down" answer, and the page notice built on
 * it (2026-10-13).
 */

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EdgelineApiError } from '@metrum/edgeline-api-client';

import { LoadFailure, datastoreOutage } from './datastore-outage';

function answer(status: number, body: unknown) {
  return new EdgelineApiError(status, '/api/opportunities', body);
}

const DOWN = answer(503, {
  detail: { code: 'datastore_unavailable', reason: 'unreachable', message: 'start Docker' },
});

describe('datastoreOutage', () => {
  it('reads the 503 the API answers while Elasticsearch is down', () => {
    expect(datastoreOutage(DOWN)).toEqual({ reason: 'unreachable', message: 'start Docker' });
  });

  it('reads a recovering cluster as recovering', () => {
    const recovering = answer(503, {
      detail: { code: 'datastore_unavailable', reason: 'recovering', message: '' },
    });
    expect(datastoreOutage(recovering)?.reason).toBe('recovering');
  });

  it('is null for every other failure — a down API included', () => {
    // The settings save's own 503 has a string detail, and means "try again".
    expect(datastoreOutage(answer(503, { detail: 'nothing was saved' }))).toBeNull();
    expect(datastoreOutage(answer(500, undefined))).toBeNull();
    expect(datastoreOutage(new Error('failed to fetch'))).toBeNull();
    expect(datastoreOutage(null)).toBeNull();
  });
});

@Component({
  imports: [LoadFailure],
  template: `<p class="failure"><el-load-failure what="opportunities" [cause]="cause" /></p>`,
})
class Host {
  cause: unknown = null;
}

function notice(cause: unknown): string {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.cause = cause;
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('LoadFailure', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('points at the banner during an outage, rather than at the API', () => {
    const text = notice(DOWN);
    expect(text).toContain('Could not read opportunities: Elasticsearch is down');
    expect(text).not.toContain('edgeline-api:serve');
  });

  it('keeps the old advice for a down API', () => {
    expect(notice(new Error('failed to fetch'))).toContain(
      'Could not read opportunities. The engine has to be running: nx run edgeline-api:serve.',
    );
  });
});
