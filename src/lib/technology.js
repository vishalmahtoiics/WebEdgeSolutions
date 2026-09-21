// Working out what a website is built on.
//
// Nothing here guesses. Every answer carries the evidence that produced it, and
// a result with no evidence is not returned at all — "WordPress" on its own is
// indistinguishable from a made-up value, which is exactly what this portal
// does not do.
//
// There are two places to look, in order of how much they prove:
//
//   files  The site's own filesystem, over the FTP or SFTP credentials already
//          stored for the domain. wp-config.php sitting in the web root is not
//          an inference — it is the thing itself.
//   site   The homepage, for domains with no file access saved. A generator tag
//          and the asset paths are strong, but they are still only evidence.
//
// Whatever an administrator types by hand outranks both, and is never
// overwritten by a later detection.

import { withStorage } from './storage.js';

const HTTP_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/// How much a result is worth, so the UI can be honest about the difference.
export const CONFIDENCE = { CONFIRMED: 'confirmed', LIKELY: 'likely' };

const found = (name, { version = null, source, evidence, confidence = CONFIDENCE.CONFIRMED }) => ({
  name,
  version: version || null,
  source,
  evidence: [evidence].flat().filter(Boolean).join(', '),
  confidence,
});

// ---------------------------------------------------------------------------
// Reading the filesystem
// ---------------------------------------------------------------------------

/// Signatures, most specific first. A WordPress install also has an index.php,
/// so order is what keeps "PHP" from winning over "WordPress".
///
/// `all` must every one be present; `any` needs one. `version` may read a file
/// to pin the exact release, and is allowed to fail — knowing it is WordPress
/// is still worth reporting when the version file is unreadable.
const FILE_SIGNATURES = [
  {
    name: 'WordPress',
    any: [['wp-config.php'], ['wp-content', 'wp-includes']],
    version: async (read) => {
      const php = await read('wp-includes/version.php');
      return php?.match(/\$wp_version\s*=\s*'([^']+)'/)?.[1] || null;
    },
  },
  {
    name: 'Drupal',
    all: ['core', 'sites', 'index.php'],
    version: async (read) => {
      const php = await read('core/lib/Drupal.php');
      return php?.match(/const\s+VERSION\s*=\s*'([^']+)'/)?.[1] || null;
    },
  },
  {
    name: 'Joomla',
    all: ['configuration.php', 'administrator', 'components'],
    version: async (read) => {
      const xml = await read('administrator/manifests/files/joomla.xml');
      return xml?.match(/<version>([^<]+)<\/version>/)?.[1] || null;
    },
  },
  {
    name: 'Magento',
    all: ['app', 'pub', 'vendor'],
    any: [['bin'], ['nginx.conf.sample']],
    version: async (read) => {
      const json = parseJson(await read('composer.json'));
      return json?.require?.['magento/product-community-edition'] || null;
    },
  },
  {
    name: 'PrestaShop',
    all: ['classes', 'controllers', 'init.php'],
  },
  {
    name: 'OpenCart',
    all: ['catalog', 'system', 'index.php'],
  },
  {
    name: 'Laravel',
    all: ['artisan', 'composer.json'],
    version: async (read) => {
      const json = parseJson(await read('composer.json'));
      return json?.require?.['laravel/framework'] || null;
    },
  },
  {
    name: 'Next.js',
    any: [['next.config.js'], ['next.config.mjs'], ['next.config.ts'], ['.next']],
    version: async (read) => {
      const json = parseJson(await read('package.json'));
      return json?.dependencies?.next || json?.devDependencies?.next || null;
    },
  },
];

const parseJson = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/// Whether a signature's requirements are all met by the names in the root.
function matches(signature, names) {
  const has = (n) => names.has(n.toLowerCase());
  if (signature.all && !signature.all.every(has)) return null;
  if (signature.any) {
    const group = signature.any.find((set) => set.every(has));
    if (!group) return null;
    return [...(signature.all || []), ...group];
  }
  return [...(signature.all || [])];
}

/// Looks at the web root over FTP/SFTP and reports what is there.
///
/// One directory listing does almost all the work; a signature only reads a
/// file when it has already matched and wants the version.
export async function detectFromFiles(ftpSettings, rootPath = '/') {
  return withStorage(ftpSettings, async (storage) => {
    const entries = await storage.list(rootPath || '/');
    const names = new Set(entries.map((e) => e.name.toLowerCase()));

    const read = async (relative) => {
      try {
        const buffer = await storage.read(joinPath(rootPath, relative));
        return buffer.toString('utf8');
      } catch {
        // A file that will not open is not a failure: the signature already
        // matched, and only the version is lost.
        return null;
      }
    };

    for (const signature of FILE_SIGNATURES) {
      const evidence = matches(signature, names);
      if (!evidence) continue;

      let version = null;
      if (signature.version) {
        try {
          version = await signature.version(read);
        } catch {
          version = null;
        }
      }
      return found(signature.name, {
        version: cleanVersion(version),
        source: 'files',
        evidence: `found ${evidence.join(' and ')}`,
      });
    }

    // Nothing recognised. Saying which kind of site it is, is still better than
    // saying nothing, and both of these are read straight off the listing.
    const php = entries.filter((e) => e.name.toLowerCase().endsWith('.php'));
    const html = entries.filter((e) => /\.html?$/i.test(e.name));

    if (php.length) {
      return found('PHP', {
        source: 'files',
        evidence: `found ${php.slice(0, 3).map((e) => e.name).join(', ')}`,
        confidence: CONFIDENCE.LIKELY,
      });
    }
    if (html.length) {
      return found('Static site', {
        source: 'files',
        evidence: `found ${html.slice(0, 3).map((e) => e.name).join(', ')} and no PHP`,
        confidence: CONFIDENCE.LIKELY,
      });
    }
    return null;
  });
}

const joinPath = (root, relative) =>
  `${String(root || '/').replace(/\/+$/, '')}/${relative}`.replace(/\/{2,}/g, '/');

/// Composer and npm ranges ("^6.5", "~10.2.0") are constraints, not the release
/// that is installed, so the leading operator is dropped rather than shown as
/// though it were part of a version number.
const cleanVersion = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim().replace(/^[\^~><=v\s]+/, '');
  return /^[0-9]/.test(trimmed) ? trimmed.slice(0, 20) : null;
};

// ---------------------------------------------------------------------------
// Reading the site
// ---------------------------------------------------------------------------

/// Generator strings, as the products themselves write them.
const GENERATORS = [
  [/^wordpress\b/i, 'WordPress'],
  [/^drupal\b/i, 'Drupal'],
  [/^joomla!?\b/i, 'Joomla'],
  [/^ghost\b/i, 'Ghost'],
  [/^typo3\b/i, 'TYPO3'],
  [/^hugo\b/i, 'Hugo'],
  [/^jekyll\b/i, 'Jekyll'],
  [/^gatsby\b/i, 'Gatsby'],
  [/^shopify\b/i, 'Shopify'],
  [/^prestashop\b/i, 'PrestaShop'],
  [/^opencart\b/i, 'OpenCart'],
  [/^wix\.com/i, 'Wix'],
  [/^squarespace\b/i, 'Squarespace'],
  [/^elementor\b/i, 'WordPress'], // a WordPress plugin, so the site is WordPress
];

/// Markers in the response that only one platform produces. Header names are
/// lower-case, because that is how fetch reports them.
const SITE_MARKERS = [
  { name: 'Shopify', header: 'x-shopid', evidence: 'the x-shopid response header' },
  { name: 'Shopify', html: /cdn\.shopify\.com/i, evidence: 'assets served from cdn.shopify.com' },
  { name: 'Wix', header: 'x-wix-request-id', evidence: 'the x-wix-request-id response header' },
  { name: 'Wix', html: /static\.wixstatic\.com/i, evidence: 'assets served from static.wixstatic.com' },
  { name: 'Squarespace', html: /static1\.squarespace\.com|This is Squarespace/i, evidence: 'Squarespace markup' },
  { name: 'Webflow', html: /data-wf-(site|page)=/i, evidence: 'the data-wf-site attribute Webflow adds' },
  { name: 'WordPress', html: /\/wp-(content|includes)\//i, evidence: 'assets served from /wp-content/' },
  { name: 'Drupal', header: 'x-drupal-cache', evidence: 'the x-drupal-cache response header' },
  { name: 'Drupal', html: /\/sites\/(default|all)\/files\//i, evidence: 'assets served from /sites/default/files/' },
  { name: 'Next.js', html: /\/_next\/static\//i, evidence: 'assets served from /_next/static/' },
  { name: 'OpenCart', html: /index\.php\?route=common\//i, evidence: 'OpenCart route URLs' },
];

/// Names that must never be fetched. A domain row is admin-supplied text, and
/// the portal fetching it is the portal making a request on someone's say-so —
/// so it is kept to public names on the public web.
function assertFetchable(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || !host.includes('.')) throw new Error('Not a public host name.');
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) throw new Error('Not a public host name.');
  if (/(^|\.)(localhost|local|internal|localdomain|test|invalid|example)$/.test(host)) {
    throw new Error('Not a public host name.');
  }
}

/// Fetches a page with its own redirect handling, so the number of hops and
/// where they lead stay under control.
async function fetchPage(startUrl, { allowPrivate = false } = {}) {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https are followed.');
    if (!allowPrivate) assertFetchable(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identifying the portal is the polite thing to do, and makes this
          // request easy to recognise in the site's own access log.
          'User-Agent': 'HostingPortal/1.0 (+technology detection)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error('Too many redirects.');
}

/// Reads at most `MAX_HTML_BYTES`. A homepage that streams forever must not be
/// able to hold a connection or fill memory.
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_HTML_BYTES) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body is already finished or gone; nothing to release.
    }
  }
  return Buffer.concat(chunks.map(Buffer.from)).subarray(0, MAX_HTML_BYTES).toString('utf8');
}

/// Fetches the homepage and reports what the response says about itself.
export async function detectFromSite(domainName, options = {}) {
  const { res, url } = await fetchPage(`https://${domainName}/`, options).catch(() =>
    fetchPage(`http://${domainName}/`, options),
  );

  const html = res.ok ? await readCapped(res) : '';
  const header = (name) => res.headers.get(name);

  // A generator tag names the product and usually its version, which beats
  // anything that has to be inferred from a URL.
  const generator =
    html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    header('x-generator');

  if (generator) {
    for (const [pattern, name] of GENERATORS) {
      if (!pattern.test(generator.trim())) continue;
      return found(name, {
        version: cleanVersion(generator.match(/([0-9]+(?:\.[0-9]+)+)/)?.[1]),
        source: 'site',
        evidence: `the page says it was generated by "${generator.trim().slice(0, 60)}"`,
      });
    }
  }

  for (const marker of SITE_MARKERS) {
    const hit = marker.header ? header(marker.header) : marker.html.test(html);
    if (!hit) continue;
    return found(marker.name, {
      source: 'site',
      evidence: marker.evidence,
      confidence: CONFIDENCE.LIKELY,
    });
  }

  // Nothing identified the platform. The server will at least say what runs it,
  // which is a smaller answer but a true one.
  const poweredBy = header('x-powered-by');
  if (poweredBy && /^php/i.test(poweredBy)) {
    return found('PHP', {
      version: cleanVersion(poweredBy.match(/([0-9]+(?:\.[0-9]+)+)/)?.[1]),
      source: 'site',
      evidence: `the x-powered-by header reports "${poweredBy.slice(0, 40)}"`,
      confidence: CONFIDENCE.LIKELY,
    });
  }
  if (html) {
    return found('Static site', {
      source: 'site',
      evidence: `${new URL(url).host} served HTML with no platform markers`,
      confidence: CONFIDENCE.LIKELY,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Both, in order
// ---------------------------------------------------------------------------

/// Files first, because they prove it; the homepage second, because it is all
/// there is for a domain with no file access saved.
///
/// Returns `{ result, attempts }`. `attempts` records what was tried and why it
/// came to nothing, so "we could not tell" can explain itself instead of
/// looking like a bug.
export async function detectTechnology({ domainName, ftpSettings, rootPath, allowPrivate = false }) {
  const attempts = [];

  if (ftpSettings?.host && ftpSettings?.username && ftpSettings?.password) {
    try {
      const result = await detectFromFiles(ftpSettings, rootPath);
      if (result) return { result, attempts };
      attempts.push({ source: 'files', message: 'Nothing recognisable in the web root.' });
    } catch (err) {
      attempts.push({ source: 'files', message: err?.message || 'File access failed.' });
    }
  } else {
    attempts.push({ source: 'files', message: 'No file access is configured for this domain.' });
  }

  try {
    const result = await detectFromSite(domainName, { allowPrivate });
    if (result) return { result, attempts };
    attempts.push({ source: 'site', message: 'The homepage gave nothing away.' });
  } catch (err) {
    attempts.push({ source: 'site', message: friendlyFetchError(err) });
  }

  return { result: null, attempts };
}

function friendlyFetchError(err) {
  const message = err?.message || '';
  if (err?.name === 'AbortError' || /abort/i.test(message)) return 'The site did not respond in time.';
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return 'The domain name does not resolve.';
  if (/ECONNREFUSED/i.test(message)) return 'The site refused the connection.';
  if (/certificate|self.signed|altname/i.test(message)) return 'The site presented a certificate that could not be verified.';
  if (/public host name/i.test(message)) return 'That host name is not on the public web.';
  return message ? `Could not reach the site: ${message}` : 'Could not reach the site.';
}
