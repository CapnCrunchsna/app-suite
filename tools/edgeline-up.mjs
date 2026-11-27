// Bring Edgeline up after a reboot or crash, in order, and say how it looks.
//
//   node tools/edgeline-up.mjs            (from app-suite)
//
// 1. Docker and Elasticsearch (`es-up`, which also moves a dead engine.sock
//    aside, the usual failure after an unclean shutdown here).
// 2. The API, through the Servers page's own start(), so it is recorded there.
// 3. The worker, unless one is already running. Both are launched outside the
//    Claude app's job object (`launchOutsideJob`), so an app update does not
//    take them down.
// 4. A fresh heartbeat, then the backup if the last one is over a day old:
//    the 07:00 UTC run is in-memory and is lost when the worker was down.
//
// Idempotent: anything already up is left alone. Lived in a session scratchpad
// until 2026-11-26, when a crash wiped it for the third time.

import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { launchOutsideJob, start } = await import(
  pathToFileURL(resolve(ROOT, '..', 'scripts', 'lib', 'servers.mjs')).href
);

const API = 'http://127.0.0.1:8000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = async (url) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

console.log('1/4 Docker and Elasticsearch');
execSync('npx nx run edgeline-api:es-up --output-style=static', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
let health = '';
for (let i = 0; i < 60 && !['green', 'yellow'].includes(health); i++) {
  await sleep(3000);
  try {
    health = (await (await fetch('http://localhost:9200/_cluster/health')).json()).status;
  } catch {}
}
if (!health) throw new Error('Elasticsearch did not answer within 3 minutes');
console.log(`    Elasticsearch ${health}`);

console.log('2/4 API');
if (await ok(`${API}/api/system/health`)) {
  console.log('    already answering');
} else {
  console.log('    start:', JSON.stringify(start('edgeline-api')));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(3000);
    up = await ok(`${API}/api/system/health`);
  }
  if (!up) throw new Error('API did not come up within 2 minutes');
  console.log('    answering');
}

console.log('3/4 Worker');
const workers = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match '/k npx nx run edgeline-api:worker' }).Count",
  ],
  { encoding: 'utf8', windowsHide: true },
).trim();
if (workers === '0') {
  const pid = launchOutsideJob('cmd.exe /c start "[srv] edgeline-worker" cmd /k npx nx run edgeline-api:worker', ROOT);
  console.log(`    launched, pid ${pid}`);
} else {
  console.log(`    already running (${workers} console)`);
}

console.log('4/4 Heartbeat and backup');
let status = null;
for (let i = 0; i < 40 && !status; i++) {
  await sleep(5000);
  const body = await (await fetch(`${API}/api/system/health`)).json();
  const age = (Date.now() - Date.parse(body.runtime?.last_heartbeat_at ?? 0)) / 1000;
  if (age < 20) status = body;
}
if (!status) throw new Error('no fresh worker heartbeat within 3 minutes');
const backupAge = (Date.now() - Date.parse(status.runtime.last_backup_at ?? 0)) / 3_600_000;
if (backupAge > 24) {
  console.log(`    last backup ${Math.round(backupAge)} h ago; running one now`);
  execSync('npx nx run edgeline-api:backup --output-style=static', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
}
const now = await (await fetch(`${API}/api/system/health`)).json();
const r = now.runtime;
console.log(JSON.stringify({
  paper_mode: now.paper_mode, kill_switch: now.kill_switch, offline_mode: now.offline_mode,
  last_poll_at: r.last_poll_at, last_grade_at: r.last_grade_at, last_backup_at: r.last_backup_at,
  next_poll_at: r.next_poll_at, next_poll_sports: r.next_poll_sports,
  quota_used: now.quota?.[0]?.quota_used, quota_budget: now.quota?.[0]?.quota_budget,
}, null, 1));
