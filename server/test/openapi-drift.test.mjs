// OpenAPI drift gate — fails CI whenever the hand-maintained spec
// (server/openapi.js) and the real Express route surface (server/routes/*.js)
// disagree, in either direction. This enforces the "update the spec in the
// same PR as any route change" convention mechanically instead of by memory.
//
// How it works: routes are collected by statically scanning routes/*.js for
// `app.METHOD('/api/…')` registrations (every route module follows this
// pattern — see routes/index.js). Path params are normalised on both sides
// (`:companyNumber` and `{companyNumber}` both become `{}`) so only the shape
// and method set are compared, not parameter naming.
//
// Known limits (fine for this codebase, revisit if conventions change):
//   * only string-literal paths registered directly on `app` are seen — a
//     route added via a Router() instance or a computed path would be missed
//     (the parsed-count canary below guards against the regex silently
//     matching nothing at all);
//   * /api/docs + /api/docs/openapi.json are excluded — the spec does not
//     document its own delivery endpoints.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpec } from '../openapi.js';

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const norm = (p) => p.replace(/\{[^}]*\}/g, '{}').replace(/:[A-Za-z_$][\w$]*/g, '{}');

// → [ 'GET /api/dossiers/{}', 'POST /api/run', … ] from the route sources
function collectRealOps() {
  const ops = new Set();
  for (const f of fs.readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    const re = /app\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(src))) {
      const p = norm(m[2]);
      if (p.startsWith('/api/docs')) continue;
      ops.add(`${m[1].toUpperCase()} ${p}`);
    }
  }
  return ops;
}

// → same op strings from the OpenAPI spec's paths
function collectSpecOps() {
  const ops = new Set();
  for (const [p, item] of Object.entries(buildSpec().paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.includes(method)) continue; // skip parameters/summary keys
      ops.add(`${method.toUpperCase()} ${norm(p)}`);
    }
  }
  return ops;
}

describe('openapi.js ↔ routes/*.js drift gate', () => {
  const real = collectRealOps();
  const spec = collectSpecOps();

  it('parses a sane number of routes (canary against a silently-broken scanner)', () => {
    expect(real.size).toBeGreaterThan(40);
    expect(spec.size).toBeGreaterThan(40);
  });

  it('every registered route is documented in openapi.js', () => {
    const undocumented = [...real].filter((op) => !spec.has(op)).sort();
    expect(undocumented, 'add these to server/openapi.js (same-PR rule)').toEqual([]);
  });

  it('openapi.js documents no route that no longer exists', () => {
    const stale = [...spec].filter((op) => !real.has(op)).sort();
    expect(stale, 'remove these from server/openapi.js — the route is gone').toEqual([]);
  });
});
