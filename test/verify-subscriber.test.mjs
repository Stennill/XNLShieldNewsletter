import worker from '../worker.js';

function mockKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((name) => name.startsWith(prefix || '')).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function makeEnv(kv) {
  return { ADMIN_SECRET: 'test-secret', SUBSCRIBERS: kv };
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  }
}

async function subscribe(env, email, ip, name = {}) {
  return worker.fetch(new Request('https://newsletter.xnltech.com/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({
      firstName: name.firstName ?? 'Andrew',
      lastName: name.lastName ?? '',
      email,
    }),
  }), env);
}

async function main() {
  const adminEnv = makeEnv(mockKv());
  const adminRes = await worker.fetch(new Request('https://newsletter.xnltech.com/admin'), adminEnv);
  const adminHtml = await adminRes.text();
  assert(adminRes.status === 200, 'admin page loads');
  assert(adminHtml.includes('Remove unconfirmed'), 'admin can remove unconfirmed signups');
  assert(adminHtml.includes('Remove selected'), 'admin can remove selected rows');
  assert(adminHtml.includes('confirmation link'), 'admin explains email confirmation');
  assert(adminHtml.includes('id="subRoster"'), 'subscriber roster is on the page');

  const landingEnv = {
    ADMIN_SECRET: 'test-secret',
    SUBSCRIBERS: mockKv(),
    CONTENT: {
      async get(key) {
        if (key === 'cache:threat-intel') {
          return JSON.stringify({ fetchedAt: Date.now(), items: [] });
        }
        return null;
      },
      async put() {},
    },
  };
  const landing = await worker.fetch(new Request('https://newsletter.xnltech.com/'), landingEnv);
  const landingHtml = await landing.text();
  assert(landing.status === 200, 'landing page loads');
  assert(landingHtml.includes('CHECK YOUR EMAIL'), 'signup success asks them to confirm');
  assert(landingHtml.includes('id="join-error"'), 'signup form can show an error');
  assert(landingHtml.includes('Click the confirmation link'), 'signup copy explains confirmation');

  const kv = mockKv();
  const env = makeEnv(kv);

  await kv.put('sub:member@example.com', JSON.stringify({
    firstName: 'Andrew',
    lastName: '',
    email: 'member@example.com',
    active: true,
    subscribedAt: '2026-04-02T00:00:00.000Z',
  }));
  const already = await subscribe(env, 'member@example.com', '10.0.0.1');
  const alreadyBody = await already.json();
  assert(already.status === 200 && alreadyBody.already === true, 'existing member is left confirmed');
  const unchanged = JSON.parse(await kv.get('sub:member@example.com'));
  assert(unchanged.active === true && unchanged.verifyToken == null, 'existing member record is not reset');

  const pendingRes = await subscribe(env, 'new@example.com', '10.0.0.2', { firstName: 'Andrew' });
  const pendingBody = await pendingRes.json();
  assert(pendingRes.status === 200 && pendingBody.pending === true, 'new signup waits for confirmation');
  const pending = JSON.parse(await kv.get('sub:new@example.com'));
  assert(pending.active === false && pending.verified === false && pending.verifyToken, 'new signup is stored inactive');

  const mash = await subscribe(env, 'mash@example.com', '10.0.0.3', { firstName: 'aa', lastName: 'bb' });
  const mashBody = await mash.json();
  assert(mash.status === 200 && mashBody.pending === true, 'short names are not blocked; they must confirm');

  const bad = await worker.fetch(new Request(
    `https://newsletter.xnltech.com/verify?email=${encodeURIComponent('new@example.com')}&token=wrong`
  ), env);
  assert(bad.status === 400, 'wrong confirmation token is rejected');
  const stillPending = JSON.parse(await kv.get('sub:new@example.com'));
  assert(stillPending.active === false, 'wrong token does not activate');

  const expiredKv = mockKv();
  const expiredEnv = makeEnv(expiredKv);
  await expiredKv.put('sub:old@example.com', JSON.stringify({
    firstName: 'Ann',
    lastName: 'Lee',
    email: 'old@example.com',
    active: false,
    verified: false,
    verifyToken: 'expired-token',
    verifyExpiresAt: '2020-01-01T00:00:00.000Z',
    subscribedAt: '2020-01-01T00:00:00.000Z',
  }));
  const expired = await worker.fetch(new Request(
    'https://newsletter.xnltech.com/verify?email=old@example.com&token=expired-token'
  ), expiredEnv);
  assert(expired.status === 400, 'expired confirmation link is rejected');

  const ok = await worker.fetch(new Request(
    `https://newsletter.xnltech.com/verify?email=${encodeURIComponent('new@example.com')}&token=${encodeURIComponent(pending.verifyToken)}`
  ), env);
  assert(ok.status === 200, 'valid confirmation link succeeds');
  const confirmed = JSON.parse(await kv.get('sub:new@example.com'));
  assert(confirmed.active === true && confirmed.verified === true && confirmed.verifyToken == null, 'confirmed subscriber is active');
  const page = await ok.text();
  assert(page.includes('Email confirmed'), 'confirmation page says the email is confirmed');

  const again = await subscribe(env, 'new@example.com', '10.0.0.8');
  const againBody = await again.json();
  assert(again.status === 200 && againBody.already === true, 'confirmed address is not asked to confirm again');

  const firstPending = JSON.parse(await kv.get('sub:mash@example.com'));
  const rotated = await subscribe(env, 'mash@example.com', '10.0.0.9', { firstName: 'aa', lastName: 'bb' });
  assert(rotated.status === 200, 'pending signup can request a fresh link');
  const secondPending = JSON.parse(await kv.get('sub:mash@example.com'));
  assert(secondPending.verifyToken && secondPending.verifyToken !== firstPending.verifyToken, 'a new link replaces the old token');
  const stale = await worker.fetch(new Request(
    `https://newsletter.xnltech.com/verify?email=mash@example.com&token=${encodeURIComponent(firstPending.verifyToken)}`
  ), env);
  assert(stale.status === 400, 'the old confirmation link stops working');

  const limitEnv = makeEnv(mockKv());
  let limited = 0;
  for (let i = 0; i < 6; i++) {
    const res = await subscribe(limitEnv, `person${i}@example.com`, '10.1.1.1', { firstName: 'Sam' });
    if (res.status === 429) limited += 1;
    else assert(res.status === 200, 'signup under the limit is accepted');
  }
  assert(limited === 1, 'a sixth signup from the same address is rate limited');

  const rosterKv = mockKv();
  const rosterEnv = makeEnv(rosterKv);
  await rosterKv.put('sub:keep@example.com', JSON.stringify({
    firstName: 'Andrew', lastName: '', email: 'keep@example.com', active: true, subscribedAt: '2026-04-02T00:00:00.000Z',
  }));
  await rosterKv.put('sub:drop@example.com', JSON.stringify({
    firstName: 'Pat', lastName: 'Lee', email: 'drop@example.com', active: true, subscribedAt: '2026-10-13T07:37:00.000Z',
  }));
  await rosterKv.put('sub:wait@example.com', JSON.stringify({
    firstName: 'Jo', lastName: '', email: 'wait@example.com', active: false, verified: false, subscribedAt: '2026-10-17T00:00:00.000Z',
  }));

  const denied = await worker.fetch(new Request('https://newsletter.xnltech.com/admin/delete-subscribers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: ['drop@example.com'] }),
  }), rosterEnv);
  assert(denied.status === 401, 'delete requires the admin secret');
  assert(await rosterKv.get('sub:drop@example.com'), 'unauthorized delete does not remove anyone');

  const removed = await worker.fetch(new Request('https://newsletter.xnltech.com/admin/delete-subscribers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret', emails: ['drop@example.com', 'wait@example.com'] }),
  }), rosterEnv);
  const removedBody = await removed.json();
  assert(removed.status === 200 && removedBody.removed === 2, 'admin can remove the rows they select');
  assert(await rosterKv.get('sub:keep@example.com'), 'unselected subscriber stays');
  assert(!(await rosterKv.get('sub:drop@example.com')), 'selected subscriber is removed');
  assert(!(await rosterKv.get('sub:wait@example.com')), 'unconfirmed subscriber is removed when selected');

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
