#!/usr/bin/env node
/**
 * Make sure the Docker daemon is answering — the first half of `nx run
 * edgeline-api:es-up`, added 2026-10-14. Here rather than in that app so the
 * Python project carries no JavaScript for Nx to infer an ESLint target over.
 *
 * On this laptop, every shutdown since at least 2026-10-10 has left Docker
 * Desktop's `docker-secrets-engine/engine.sock` behind as a dead AF_UNIX reparse
 * point. Docker's next start tries to rename it, gets "The file cannot be
 * accessed by the system", and quits with an error dialog. A reboot does not
 * clear it. Nothing in user mode can open, rename or delete the file itself, but
 * its **folder** renames fine, and Docker recreates the folder on start. So:
 *
 *   1. daemon already answering → done;
 *   2. Docker Desktop already running → give it `STARTING_S` to finish, since
 *      it may just be slow rather than stuck;
 *   3. still no daemon → kill whatever Docker Desktop is left (stuck on the
 *      error dialog), move the folder aside as `docker-secrets-engine.stale-<stamp>`
 *      if it holds a socket, launch Docker Desktop and wait for the daemon.
 *
 * A live socket cannot be stat'ed on Windows either, so the file itself cannot
 * say whether it is dead. With no daemon answering and no Docker Desktop
 * running, though, nothing is listening on it, and it is dead by definition.
 *
 * The moved-aside folders cannot be deleted either. They are a few bytes each.
 * Windows only; elsewhere this checks the daemon and stops.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DOCKER_DESKTOP = 'C:/Program Files/Docker/Docker/Docker Desktop.exe';
const WAIT_S = 180;
const STARTING_S = 90;

function daemonUp() {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether a socket file is there at all. Listed rather than stat'ed: a
 *  socket, live or dead, fails `stat` here with EACCES. */
function holdsSocket(folder) {
  return existsSync(folder) && readdirSync(folder).includes('engine.sock');
}

function dockerDesktopRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.includes('Docker Desktop.exe');
  } catch {
    return false;
  }
}

async function waitForDaemon(seconds) {
  for (let waited = 0; waited < seconds; waited += 5) {
    await sleep(5000);
    if (daemonUp()) return waited + 5;
  }
  return null;
}

function killDockerDesktop() {
  for (const image of ['Docker Desktop.exe', 'com.docker.backend.exe']) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/IM', image], { stdio: 'ignore', windowsHide: true });
    } catch {
      // not running
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (daemonUp()) {
  console.log('docker-up: daemon already answering');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.error('docker-up: the Docker daemon is not answering; start it and retry');
  process.exit(1);
}

if (dockerDesktopRunning()) {
  console.log(`docker-up: Docker Desktop is running; giving it ${STARTING_S}s`);
  const after = await waitForDaemon(STARTING_S);
  if (after !== null) {
    console.log(`docker-up: daemon answering after ~${after}s`);
    process.exit(0);
  }
  console.log('docker-up: still no daemon; treating Docker Desktop as stuck');
}

killDockerDesktop();
await sleep(3000);
const folder = join(process.env.LOCALAPPDATA ?? '', 'docker-secrets-engine');
if (holdsSocket(folder)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  renameSync(folder, `${folder}.stale-${stamp}`);
  console.log(`docker-up: moved a dead engine.sock aside (${folder}.stale-${stamp})`);
}

console.log('docker-up: starting Docker Desktop');
spawn(DOCKER_DESKTOP, [], { detached: true, stdio: 'ignore' }).unref();

const after = await waitForDaemon(WAIT_S);
if (after !== null) {
  console.log(`docker-up: daemon answering after ~${after}s`);
  process.exit(0);
}
console.error(
  `docker-up: no daemon after ${WAIT_S}s. Check Docker Desktop for an error dialog; ` +
    'apps/edgeline-api/README.md has the ones seen here.',
);
process.exit(1);
