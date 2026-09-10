/**
 * The built Angular bundle, served at `/` by this same process (§9aj).
 *
 * One origin is the point. Before this, the UI ran on the Angular dev server and
 * called `127.0.0.1:4310` cross-origin, which meant a CORS allow-list and a
 * preflight — and a preflight is a thing `app.inject` never sends, so the whole
 * suite was blind to it. §9ab is the bug that cost: `access-control-allow-methods`
 * did not list `PUT`, 297 tests passed, and the first keystroke in the real page
 * failed. Same-origin removes the category rather than adding a test to it.
 *
 * ## Why this is hand-written rather than `@fastify/static`
 *
 * The whole job is: send a file from one directory, fall back to `index.html`,
 * and never answer for `/api`. That is the code below. `@fastify/static` brings
 * five transitive packages to do range requests, ETags, dotfile policy and
 * directory listings for a bundle of a dozen files served over loopback to one
 * person — and it would be the only dependency in this app that cannot be added
 * without an install this workspace's worktrees are not allowed to run.
 *
 * `apps/edgeline-api/src/edgeline/api/main.py`'s `_mount_ui` is the shape being
 * mirrored: read the directory from an env var with a default, and **degrade**
 * when it is not there. An API that refuses to boot because nobody has run
 * `nx build ledgerline-ui` would make the UI a dependency of the backend, which
 * it is not.
 */

import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Enough of a type table for what `@angular/build:application` emits, plus the
 * few things `public/` tends to hold.
 *
 * Anything unlisted goes out as `application/octet-stream`, which a browser
 * downloads rather than misinterprets. Guessing `text/html` for an unknown
 * extension is how a bundle serves its own source as a page.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `/assets/logo.svg?v=2` -> `/assets/logo.svg`, and never throws on a bad escape. */
function pathnameOf(url: string): string | null {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '/';
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    // A malformed percent-escape is not a path this bundle contains.
    return null;
  }
}

/**
 * The file a request names, or `null` if it names nothing inside the bundle.
 *
 * The containment check is the security half: `resolve` collapses `..` before
 * the comparison, so a path that climbs out of the bundle root fails it rather
 * than reading `data/ledgerline.sqlite`. This process has no authentication of
 * any kind (§2.1), so the only thing standing between a crafted URL and the
 * whole disk is this function.
 */
function fileFor(root: string, pathname: string): string | null {
  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return isFile(candidate) ? candidate : null;
}

function send(reply: FastifyReply, file: string): FastifyReply {
  return (
    reply
      .type(CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream')
      /**
       * Nothing is cached, deliberately.
       *
       * This is a local process and the "network" is a memcpy, so caching buys
       * nothing measurable. What it costs is the failure everyone here has already
       * met once in another form: a rebuilt bundle that the browser refuses to
       * pick up, presenting as code that did not take effect rather than as a
       * cache. `outputHashing` covers the production build; `nx build
       * ledgerline-ui --configuration development` does not hash at all.
       */
      .header('cache-control', 'no-cache')
      .send(createReadStream(file))
  );
}

/**
 * Serve `uiDistDir` at `/`, if it is there.
 *
 * **Call this after every API route is registered.** It installs a not-found
 * handler, which is only reached once the router has failed to match — so the
 * routes win and `/api` is never shadowed by the bundle. The handler still
 * checks the prefix itself, because the second half of that promise is that an
 * unmatched `/api/...` must stay a JSON 404 and never become an HTML page: a
 * fetch that receives `<!doctype html>` where it expected an error body reports
 * a parse failure, and the real problem — a route that does not exist — is
 * nowhere in the message.
 */
export function registerUiBundle(app: FastifyInstance, uiDistDir: string | null | undefined): void {
  const root = uiDistDir ? resolve(uiDistDir) : null;

  if (root === null || !isDirectory(root)) {
    app.log.info(`no UI bundle at ${root ?? '(none configured)'} — serving the API only`);
    return;
  }

  const index = join(root, 'index.html');
  if (!isFile(index)) {
    app.log.warn(`${root} has no index.html — serving the API only`);
    return;
  }

  app.log.info(`serving the UI bundle from ${root}`);

  app.setNotFoundHandler((request, reply) => {
    const pathname = pathnameOf(request.url);
    const readable = request.method === 'GET' || request.method === 'HEAD';

    if (pathname === null || !readable || pathname === '/api' || pathname.startsWith('/api/')) {
      return reply.code(404).send({
        error: 'not_found',
        message: `${request.method} ${request.url} is not a route on this API.`,
      });
    }

    const file = fileFor(root, pathname);
    if (file !== null) return send(reply, file);

    /**
     * A path with an extension that is not on disk is a missing asset, and a
     * missing asset must 404. Only extensionless paths fall through to
     * `index.html` — those are §6's routes, and a deep link has to survive a
     * refresh. Serving the page for `/main-A1B2C3.js` instead would make a
     * broken build present as a syntax error inside HTML.
     */
    if (extname(pathname) !== '') {
      return reply.code(404).send({
        error: 'not_found',
        message: `${pathname} is not in the UI bundle.`,
      });
    }

    return send(reply, index);
  });
}
