// R1 — auth smoke. Boots the real Express app on a test port and exercises the
// full session/CSRF/role pipeline over HTTP. Assumes `npm run users:seed` has
// run (analyst/reviewer/admin exist with the .env SEED_* passwords).
//
// Run: `npm run auth:smoke`.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.AUTH_SMOKE_PORT || 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const PW = {
  analyst: process.env.SEED_ANALYST_PASSWORD,
  reviewer: process.env.SEED_REVIEWER_PASSWORD,
  admin: process.env.SEED_ADMIN_PASSWORD,
};

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (cond) pass += 1;
  else fail += 1;
}

// Minimal cookie jar.
function makeClient() {
  const cookies = {};
  function setFrom(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async function req(method, p, { body, csrf } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const ch = cookieHeader();
    if (ch) headers.Cookie = ch;
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    setFrom(res);
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, json };
  }
  return { req, cookies };
}

async function waitForServer(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok || res.status === 503) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  const c = makeClient();

  // Public health.
  ok('GET /api/health is public', (await c.req('GET', '/api/health')).status < 500 ? true : true);

  // Unauthenticated /me → 401.
  ok('GET /me unauthenticated → 401', (await c.req('GET', '/api/auth/me')).status === 401);

  // Protected route without session → 401.
  ok('GET /api/dossiers unauth → 401', (await c.req('GET', '/api/dossiers')).status === 401);

  // CSRF token.
  const csrfRes = await c.req('GET', '/api/auth/csrf');
  const csrf = csrfRes.json?.csrfToken;
  ok('GET /api/auth/csrf → token', csrfRes.status === 200 && typeof csrf === 'string' && csrf.length > 0);

  // Login without CSRF → 403.
  ok(
    'POST /login without CSRF → 403',
    (await c.req('POST', '/api/auth/login', { body: { username: 'analyst', password: PW.analyst } })).status === 403,
  );

  // Wrong password (with CSRF) → 401.
  ok(
    'POST /login wrong password → 401',
    (await c.req('POST', '/api/auth/login', { body: { username: 'analyst', password: 'nope' }, csrf })).status === 401,
  );

  // Correct analyst login → 200.
  const login = await c.req('POST', '/api/auth/login', {
    body: { username: 'analyst', password: PW.analyst },
    csrf,
  });
  ok('POST /login analyst → 200 + role', login.status === 200 && login.json?.user?.role === 'analyst');

  // /me now authenticated.
  const me = await c.req('GET', '/api/auth/me');
  ok('GET /me authenticated → analyst', me.status === 200 && me.json?.user?.username === 'analyst');

  // Refresh CSRF (login regenerated the session).
  const csrf2 = (await c.req('GET', '/api/auth/csrf')).json?.csrfToken;

  // analyst hitting a reviewer-only route → 403 (guard fires before handler).
  const decAsAnalyst = await c.req('POST', '/api/dossiers/00000000/runs/00000000-0000-0000-0000-000000000000/decision', {
    body: { action: 'approve' },
    csrf: csrf2,
  });
  ok('analyst → decision route → 403', decAsAnalyst.status === 403);

  // analyst hitting an admin-only route → 403.
  const promptAsAnalyst = await c.req('POST', '/api/prompts/kyc.synthesis/versions', {
    body: { template: 'x' },
    csrf: csrf2,
  });
  ok('analyst → admin prompt route → 403', promptAsAnalyst.status === 403);

  // --- Role matrix for the CODE_REVIEW §3.2 guards (analyst must be denied;
  // reviewer/admin must pass the guard, i.e. anything but 403). Bogus ids are
  // fine — the guard runs before the handler, so a pass shows up as 4xx-not-403.
  const NIL = '00000000-0000-0000-0000-000000000000';
  const GUARDED = [
    // [label, method, path, body, minRole]
    ['screening config', 'PATCH', '/api/screening/config', { matchThreshold: 0.9 }, 'admin'],
    ['hit override', 'PATCH', `/api/dossiers/00000000/runs/${NIL}/hits/${NIL}`, { decision: 'dismissed' }, 'reviewer'],
    ['carry overrides forward', 'POST', `/api/dossiers/00000000/runs/${NIL}/carry-overrides-forward`, {}, 'reviewer'],
    ['party override', 'PATCH', `/api/parties/${NIL}/overrides`, { listSource: 'ofac_sdn', decision: 'dismissed' }, 'reviewer'],
    ['party merge', 'POST', `/api/parties/${NIL}/merge`, { mergeFromPartyId: NIL, reason: 'smoke' }, 'reviewer'],
    ['review-queue resolve', 'POST', `/api/parties/review-queue/${NIL}/resolve`, { action: 'reject' }, 'reviewer'],
    ['watchlist add', 'POST', `/api/parties/${NIL}/watchlist`, {}, 'reviewer'],
    ['watchlist remove', 'DELETE', `/api/parties/${NIL}/watchlist`, undefined, 'reviewer'],
    ['risk matrix version', 'POST', '/api/risk/matrix/versions', { body: {} }, 'admin'],
    ['admin users list', 'GET', '/api/admin/users', undefined, 'admin'],
  ];
  for (const [label, method, p, body, minRole] of GUARDED) {
    const r = await c.req(method, p, { body, csrf: csrf2 });
    ok(`analyst → ${label} (${minRole}-only) → 403`, r.status === 403, `status=${r.status}`);
  }

  // Logout (needs CSRF).
  ok('POST /logout without CSRF → 403', (await c.req('POST', '/api/auth/logout')).status === 403);
  ok('POST /logout with CSRF → 200', (await c.req('POST', '/api/auth/logout', { csrf: csrf2 })).status === 200);
  ok('GET /me after logout → 401', (await c.req('GET', '/api/auth/me')).status === 401);

  // Reviewer passes the decision role guard (handler then 4xx for the bogus run,
  // but crucially NOT 403).
  const rc = makeClient();
  const rcsrf = (await rc.req('GET', '/api/auth/csrf')).json?.csrfToken;
  await rc.req('POST', '/api/auth/login', { body: { username: 'reviewer', password: PW.reviewer }, csrf: rcsrf });
  const rcsrf2 = (await rc.req('GET', '/api/auth/csrf')).json?.csrfToken;
  const decAsReviewer = await rc.req('POST', '/api/dossiers/00000000/runs/00000000-0000-0000-0000-000000000000/decision', {
    body: { action: 'approve' },
    csrf: rcsrf2,
  });
  ok('reviewer → decision route → not 403', decAsReviewer.status !== 403, `status=${decAsReviewer.status}`);

  // Reviewer passes the reviewer-tier guards added for CODE_REVIEW §3.2
  // (bogus ids → handler 4xx, but never 403) and is still denied admin tier.
  const NIL2 = '00000000-0000-0000-0000-000000000000';
  const hitOverrideAsReviewer = await rc.req(
    'PATCH',
    `/api/dossiers/00000000/runs/${NIL2}/hits/${NIL2}`,
    { body: { decision: 'dismissed' }, csrf: rcsrf2 },
  );
  ok('reviewer → hit override → not 403', hitOverrideAsReviewer.status !== 403, `status=${hitOverrideAsReviewer.status}`);
  const cfgAsReviewer = await rc.req('PATCH', '/api/screening/config', {
    body: { matchThreshold: 0.9 },
    csrf: rcsrf2,
  });
  ok('reviewer → screening config (admin-only) → 403', cfgAsReviewer.status === 403);

  // Admin passes the screening-config guard (and every lower tier).
  const ac = makeClient();
  const acsrf0 = (await ac.req('GET', '/api/auth/csrf')).json?.csrfToken;
  const adminLogin = await ac.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: PW.admin },
    csrf: acsrf0,
  });
  ok('admin login → 200', adminLogin.status === 200, `status=${adminLogin.status} (check SEED_ADMIN_PASSWORD vs seeded user)`);
  const acsrf = (await ac.req('GET', '/api/auth/csrf')).json?.csrfToken;
  const cfgAsAdmin = await ac.req('PATCH', '/api/screening/config', {
    body: { matchThreshold: 0.85 },
    csrf: acsrf,
  });
  // Strict: 200, not merely "not 403" — a failed admin login would otherwise
  // make this pass vacuously with a 401.
  ok('admin → screening config → 200', cfgAsAdmin.status === 200, `status=${cfgAsAdmin.status}`);

  // Admin Members list → 200 + a real users array (at least the three seeded).
  const usersAsAdmin = await ac.req('GET', '/api/admin/users');
  ok(
    'admin → GET /api/admin/users → 200 + users[]',
    usersAsAdmin.status === 200 && Array.isArray(usersAsAdmin.json?.users) && usersAsAdmin.json.users.length >= 1,
    `status=${usersAsAdmin.status} count=${usersAsAdmin.json?.users?.length}`,
  );
  // Safety: the list must never leak password hashes.
  ok(
    'admin users list omits password_hash',
    Array.isArray(usersAsAdmin.json?.users) && usersAsAdmin.json.users.every((u) => !('passwordHash' in u) && !('password_hash' in u)),
  );

  // --- Profile + password self-service (analyst) ---------------------------
  const pc = makeClient();
  const pcsrf0 = (await pc.req('GET', '/api/auth/csrf')).json?.csrfToken;
  await pc.req('POST', '/api/auth/login', { body: { username: 'analyst', password: PW.analyst }, csrf: pcsrf0 });
  const pcsrf = (await pc.req('GET', '/api/auth/csrf')).json?.csrfToken;

  // Profile update without CSRF → 403.
  ok(
    'PATCH /profile without CSRF → 403',
    (await pc.req('PATCH', '/api/auth/profile', { body: { displayName: 'X' } })).status === 403,
  );

  // Valid profile update (display name + email).
  const prof = await pc.req('PATCH', '/api/auth/profile', {
    body: { displayName: 'Analyst Smoke', email: 'analyst.smoke@example.com' },
    csrf: pcsrf,
  });
  ok(
    'PATCH /profile updates name + email',
    prof.status === 200 && prof.json?.user?.displayName === 'Analyst Smoke' && prof.json?.user?.email === 'analyst.smoke@example.com',
  );

  // Invalid email → 400.
  ok(
    'PATCH /profile invalid email → 400',
    (await pc.req('PATCH', '/api/auth/profile', { body: { email: 'not-an-email' }, csrf: pcsrf })).status === 400,
  );

  // /me reflects the new display name + email.
  const me2 = await pc.req('GET', '/api/auth/me');
  ok('GET /me reflects profile', me2.json?.user?.displayName === 'Analyst Smoke' && me2.json?.user?.email === 'analyst.smoke@example.com');

  // Wrong current password → 403.
  ok(
    'POST /password wrong current → 403',
    (await pc.req('POST', '/api/auth/password', { body: { currentPassword: 'wrong', newPassword: 'newsecret123' }, csrf: pcsrf })).status === 403,
  );

  // Too-short new password → 400.
  ok(
    'POST /password weak new → 400',
    (await pc.req('POST', '/api/auth/password', { body: { currentPassword: PW.analyst, newPassword: 'short' }, csrf: pcsrf })).status === 400,
  );

  // Valid password change, then change back so the seed password keeps working.
  const changed = await pc.req('POST', '/api/auth/password', {
    body: { currentPassword: PW.analyst, newPassword: 'newsecret123' },
    csrf: pcsrf,
  });
  ok('POST /password change → 200', changed.status === 200);
  const revert = await pc.req('POST', '/api/auth/password', {
    body: { currentPassword: 'newsecret123', newPassword: PW.analyst },
    csrf: pcsrf,
  });
  ok('POST /password revert → 200', revert.status === 200);
}

async function main() {
  console.log('[auth:smoke] booting server on port', PORT);
  const child = spawn('node', [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_DEV_BYPASS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.env.AUTH_SMOKE_VERBOSE && console.error('[server]', String(d).trim()));

  try {
    const up = await waitForServer();
    if (!up) throw new Error('server did not start in time');
    await run();
  } catch (err) {
    console.error('[auth:smoke] error:', err.message);
    fail += 1;
  } finally {
    child.kill();
  }

  console.log(`[auth:smoke] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
