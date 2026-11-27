// Bring Edgeline up after a reboot or crash, in order, and say how it looks.
//
//   node tools/edgeline-up.mjs              (from app-suite) by hand
//   node tools/edgeline-up.mjs --watchdog   what the scheduled task runs
//
// 1. Docker and Elasticsearch (`es-up`, which also moves a dead engine.sock
//    aside, the usual failure after an unclean shutdown here).
// 2. The API, through the Servers page's own start(), so it is recorded there.
// 3. The worker, unless one is running. A worker console whose heartbeat has
//    been stale for 10 minutes, and stays stale for 3 more, is killed and
//    replaced: that is a hung worker, not one waking from sleep. Both are
//    launched outside the Claude app's job object (`launchOutsideJob`), so an
//    app update does not take them down.
// 4. A fresh heartbeat, then the backup if the last one is over a day old:
//    the 07:00 UTC run is in-memory and is lost while the worker is down.
//
// Idempotent: anything already up is left alone. `--watchdog` returns at once
// when Elasticsearch, the API and a fresh heartbeat are all there, prints
// nothing, and records what it did in `apps/edgeline-api/logs/watchdog.log`.
// Run every 15 minutes and at logon by the "Edgeline watchdog" scheduled task
// (`tools/install-edgeline-watchdog.ps1`), added 2026-11-26 after the worker
// stopped unnoticed from 11-23 to 11-26.

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { launchOutsideJob, start } = await import(
  pathToFileURL(resolve(ROOT, '..', 'scripts', 'lib', 'servers.mjs')).href
);

const WATCHDOG = process.argv.includes('--watchdog');
const API = 'http://127.0.0.1:8000';
const WORKER_PATTERN = '/k npx nx run edgeline-api:worker';
/** A heartbeat older than this means the worker is down or hung. It beats
 *  every 60 s (`scheduler.HEARTBEAT_INTERVAL_S`). */
const STALE_S = 600;
/** How long a stale worker gets to beat again before it is replaced, so one
 *  waking from sleep is not mistaken for a hung one. */
const GRACE_MS = 180_000;
const LOG_DIR = resolve(ROOT, 'apps', 'edgeline-api', 'logs');
const LOG = resolve(LOG_DIR, 'watchdog.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(message) {
  if (WATCHDOG) {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG).size > 1_000_000) renameSync(LOG, `${LOG}.1`);
    } catch {}
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } else {
    console.log(message);
  }
}

async function json(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function esHealth() {
  return (await json('http://localhost:9200/_cluster/health'))?.status ?? '';
}

/** Seconds since the worker's last heartbeat, or Infinity when unknown. */
async function heartbeatAge() {
  const body = await json(`${API}/api/system/health`);
  const at = Date.parse(body?.runtime?.last_heartbeat_at ?? '');
  return Number.isNaN(at) ? Infinity : (Date.now() - at) / 1000;
}

function workerConsoles() {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match '${WORKER_PATTERN}' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).split(/\s+/).filter(Boolean);
}

function run(command) {
  execSync(command, { cwd: ROOT, stdio: WATCHDOG ? 'ignore' : 'inherit', windowsHide: true });
}

// The fast path: everything is fine, so do nothing and say nothing. A worker
// console must exist too: a heartbeat stays "fresh" for 10 minutes after the
// worker is gone.
if (
  WATCHDOG &&
  ['green', 'yellow'].includes(await esHealth()) &&
  (await heartbeatAge()) < STALE_S &&
  workerConsoles().length > 0
) {
  process.exit(0);
}

try {
  if (!['green', 'yellow'].includes(await esHealth())) {
    say('Docker and Elasticsearch: starting');
    run('npx nx run edgeline-api:es-up --output-style=static');
    let health = '';
    for (let i = 0; i < 60 && !['green', 'yellow'].includes(health); i++) {
      await sleep(3000);
      health = await esHealth();
    }
    if (!health) throw new Error('Elasticsearch did not answer within 3 minutes');
    say(`Elasticsearch ${health}`);
  } else if (!WATCHDOG) {
    say('Docker and Elasticsearch: already up');
  }

  if (!(await json(`${API}/api/system/health`))) {
    say(`API: starting ${JSON.stringify(start('edgeline-api'))}`);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(3000);
      up = Boolean(await json(`${API}/api/system/health`));
    }
    if (!up) throw new Error('API did not come up within 2 minutes');
    say('API answering');
  } else if (!WATCHDOG) {
    say('API: already answering');
  }

  let consoles = workerConsoles();
  if (consoles.length && (await heartbeatAge()) >= STALE_S) {
    say(`worker console open (${consoles.join(', ')}) but no heartbeat; waiting ${GRACE_MS / 1000} s`);
    const until = Date.now() + GRACE_MS;
    while (Date.now() < until && (await heartbeatAge()) >= STALE_S) await sleep(15_000);
    if ((await heartbeatAge()) >= STALE_S) {
      for (const pid of consoles) {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
        } catch {}
      }
      say(`worker hung: killed ${consoles.join(', ')}`);
      consoles = [];
    } else {
      say('worker beat again; left alone');
    }
  }
  if (!consoles.length) {
    const pid = launchOutsideJob(`cmd.exe /c start "[srv] edgeline-worker" cmd /k npx nx run edgeline-api:worker`, ROOT);
    say(`worker: launched, pid ${pid}`);
  } else if (!WATCHDOG) {
    say(`worker: already running (${consoles.length} console)`);
  }

  let fresh = false;
  for (let i = 0; i < 40 && !fresh; i++) {
    fresh = (await heartbeatAge()) < 20;
    if (!fresh) await sleep(5000);
  }
  if (!fresh) throw new Error('no fresh worker heartbeat within 3 minutes');

  const status = await json(`${API}/api/system/health`);
  const backupAge = (Date.now() - Date.parse(status?.runtime?.last_backup_at ?? 0)) / 3_600_000;
  if (backupAge > 24) {
    say(`last backup ${Math.round(backupAge)} h ago; running one`);
    run('npx nx run edgeline-api:backup --output-style=static');
  }

  const now = await json(`${API}/api/system/health`);
  const r = now?.runtime ?? {};
  say(JSON.stringify({
    paper_mode: now?.paper_mode, kill_switch: now?.kill_switch, offline_mode: now?.offline_mode,
    last_poll_at: r.last_poll_at, last_grade_at: r.last_grade_at, last_backup_at: r.last_backup_at,
    next_poll_at: r.next_poll_at, next_poll_sports: r.next_poll_sports,
    quota_used: now?.quota?.[0]?.quota_used, quota_budget: now?.quota?.[0]?.quota_budget,
  }));
} catch (error) {
  say(`FAILED: ${error.message}`);
  process.exit(1);
}
