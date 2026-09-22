// Where each front end answers.
//
// Three applications share one server, and which URL serves which one is the
// sort of thing that quietly breaks during a refactor and is only noticed when
// a customer says the link you sent them does not work. So it is checked.
//
// The mail app deliberately answers on more than one path: somebody told
// "your email is at yourdomain.com/mails" will type /mail about as often, and
// anyone holding the older /webmail link should not find it broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 3971;
const BASE = `http://127.0.0.1:${PORT}`;
const MAIL_HOST = 'mails.example.test';

let server;

/// A raw request, because this file is partly about host-based routing and
/// `fetch` refuses to send a Host header — it is on the forbidden list, so
/// undici silently replaces it with the address it dialled. Testing "a
/// different hostname serves a different app" through fetch would quietly
/// test nothing at all.
///
/// Connection: close on every request, so killing the server at the end
/// leaves no keep-alive socket to reset.
function get(pathname, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        headers: { Connection: 'close', ...(host ? { Host: host } : {}) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
            text: body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/// Follows one redirect, which is all any of these take.
const bodyOf = async (pathname, options) => {
  let res = await get(pathname, options);
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await get(res.headers.get('location'), options);
  }
  return { status: res.status, text: res.text };
};

/// Which app answered, judged by its <title>. The three are distinct, which
/// is what makes this readable at all.
const appAt = async (pathname, options) => {
  const { text } = await bodyOf(pathname, options);
  if (/<title>Webmail<\/title>/.test(text)) return 'mail';
  if (/<title>Hosting Portal<\/title>/.test(text)) return 'portal';
  if (/<title>Hosting and Domains<\/title>/.test(text)) return 'store';
  return 'unknown';
};

test.before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), MAIL_HOST },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

test.after(() => server?.kill());

test('the storefront has the root', async () => {
  assert.equal(await appAt('/'), 'store');
});

test('the portal is at /portal', async () => {
  assert.equal(await appAt('/portal/'), 'portal');
});

test('the mail app answers on every path it is offered at', async () => {
  // /mails is the one to give people; the others are for when they guess or
  // are holding an older link.
  for (const base of ['/mails/', '/mail/', '/webmail/']) {
    assert.equal(await appAt(base), 'mail', `${base} should serve the mail app`);
  }
});

test('each mail path works without its trailing slash too', async () => {
  // Nobody types the slash. A redirect is fine; a 404 is not.
  for (const base of ['/mails', '/mail', '/webmail']) {
    const res = await get(base);
    // 301 from express.static's own directory redirect, or 302 from ours.
    // Which one it is does not matter; landing on the app does.
    assert.ok([301, 302].includes(res.status), `${base} should redirect rather than ${res.status}`);
    assert.match(res.headers.get('location') || '', new RegExp(`${base}/$`));
    assert.equal(await appAt(base), 'mail');
  }
});

test('the mail app loads its own stylesheet from every path', async () => {
  // The apps reference their assets relatively so they work wherever they are
  // mounted. A second mount is exactly where that would go wrong.
  for (const base of ['/mails', '/mail', '/webmail']) {
    const res = await get(`${base}/css/mail.css`);
    assert.equal(res.status, 200, `${base}/css/mail.css should be served`);
    assert.match(res.headers.get('content-type') || '', /text\/css/);
  }
});

test('the shared design language is reachable from all of them', async () => {
  // One absolute path, served once, used by all three apps.
  for (const asset of ['/shared/css/base.css', '/shared/js/theme.js', '/shared/fonts/inter.woff2']) {
    assert.equal((await get(asset)).status, 200, `${asset} should be served`);
  }
});

test('a dedicated mail hostname serves the mail app from its own root', async () => {
  assert.equal(await appAt('/', { host: MAIL_HOST }), 'mail');
  // And the storefront still owns the root on every other hostname.
  assert.equal(await appAt('/', { host: '127.0.0.1' }), 'store');
});

test('an unknown path under an app returns to that app rather than 404', async () => {
  // Answering /mails/a/b with the index would make the browser resolve
  // css/mail.css against /mails/a/, and the page would load unstyled.
  for (const [deep, base] of [
    ['/mails/anything/at/all', '/mails/'],
    ['/portal/nope', '/portal/'],
  ]) {
    const res = await get(deep);
    assert.ok([301, 302].includes(res.status), `${deep} returned ${res.status}`);
    assert.equal(res.headers.get('location'), base);
  }
});

test('an unknown API path is still a JSON 404, not an app', async () => {
  const res = await get('/api/not-a-real-endpoint');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});
