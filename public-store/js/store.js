// The public storefront.
//
// One page with a hash router: the landing page with plans and a domain
// search, and an order page reached by reference. Kept deliberately small —
// this is what a stranger downloads before deciding whether to trust you.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, errorAlert, icon, PERIOD,
} from './ui.js';
import { openOrderForm, renderOrderPage, openLookup } from './order.js';

const app = document.getElementById('app');
const state = { config: null, plans: [], tlds: [] };

boot();

async function boot() {
  try {
    const [config, plans, tlds] = await Promise.all([
      api('/config'),
      api('/plans').catch(() => ({ plans: [] })),
      api('/tlds').catch(() => ({ tlds: [] })),
    ]);
    state.config = config;
    state.plans = plans.plans || [];
    state.tlds = tlds.tlds || [];
    document.title = `${config.businessName} — Hosting and Domains`;
  } catch (err) {
    fill(
      app,
      el(
        'div',
        { class: 'wrap section' },
        el('h1', {}, 'We are having trouble loading'),
        el('p', { class: 'muted', style: 'margin-top:12px' }, err.message),
      ),
    );
    return;
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('store:navigate', route);
  route();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseHash() {
  const raw = (window.location.hash || '#/').replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  return { name: name || 'home', param: param || null };
}

async function route() {
  const { name, param } = parseHash();
  app.className = '';

  if (name === 'order' && param) {
    fill(app, header(), el('div', { class: 'section' }, el('div', { class: 'wrap muted' }, 'Loading…')), footer(), waFloat());
    const page = await renderOrderPage(param, state.config);
    fill(app, header(), page, footer(), waFloat());
    window.scrollTo({ top: 0 });
    return;
  }

  const home = homePage();
  fill(app, header(), home.page, footer(), waFloat());
  // A #/…#plans style link should still land on the right block.
  if (name === 'plans' || name === 'domains') {
    document.getElementById(name)?.scrollIntoView({ block: 'start' });
  }
  // A shared search link, #/search/myshop.in, runs that search on arrival.
  if (name === 'search' && param) {
    let query = param;
    try {
      query = decodeURIComponent(param);
    } catch {
      // A mangled link searches for what it says.
    }
    home.searchDomain(query, { scroll: true });
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function header() {
  const c = state.config;
  return el(
    'header',
    { class: 'site-head' },
    el(
      'div',
      { class: 'wrap inner' },
      el(
        'a',
        { class: 'brand', href: '#/' },
        el('span', { class: 'logo' }, icon('cloud', 19)),
        el('span', { class: 'name' }, c.businessName),
      ),
      el(
        'nav',
        { class: 'site-nav' },
        el('a', { href: '#/', onclick: () => scrollTo('plans') }, 'Hosting'),
        el('a', { href: '#/', onclick: () => scrollTo('domains') }, 'Domains'),
        el('button', { onclick: openLookup }, 'My order'),
        themeToggle(),
        // The portal moved under /portal when the storefront took the root.
        el('a', { href: '/portal', class: 'btn sm' }, 'Client login'),
      ),
    ),
  );
}

/// Light or dark, the same switch the portal has.
///
/// The icon shows what pressing it will give you rather than what you have,
/// which is what somebody reaching for it wants.
function themeToggle() {
  const button = el('button', {
    class: 'icon-btn',
    title: 'Switch between light and dark',
    'aria-label': 'Switch between light and dark',
  });

  const paint = () => {
    const dark = window.__theme?.current() === 'dark';
    clear(button).append(icon(dark ? 'sun' : 'moon', 17));
  };

  button.onclick = () => {
    window.__theme?.set();
    paint();
  };

  paint();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', paint);
  return button;
}

const scrollTo = (id) => {
  // Let the hash change settle first, or the browser jumps back to the top.
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 30);
};

function footer() {
  const c = state.config;
  return el(
    'footer',
    { class: 'site-foot' },
    el(
      'div',
      { class: 'wrap inner' },
      el('span', { class: 'grow' }, `© ${new Date().getFullYear()} ${c.businessName}`),
      c.supportEmail ? el('a', { href: `mailto:${c.supportEmail}` }, c.supportEmail) : null,
      c.whatsappLink ? el('a', { href: c.whatsappLink, target: '_blank', rel: 'noopener' }, 'WhatsApp') : null,
      // Somebody looking for their email looks in the footer. /mails is the
      // address to give people; the app also answers at /mail and /webmail,
      // and at mails.yourdomain.com where that subdomain is set up.
      el('a', { href: '/mails' }, 'Webmail'),
      el('a', { href: '/portal' }, 'Client login'),
    ),
  );
}

function waFloat() {
  const link = state.config.whatsappLink;
  if (!link) return null;
  return el(
    'a',
    { class: 'wa-float', href: link, target: '_blank', rel: 'noopener', 'aria-label': 'Message us on WhatsApp', title: 'Message us on WhatsApp' },
    icon('whatsapp', 26),
  );
}

// ---------------------------------------------------------------------------
// The landing page
// ---------------------------------------------------------------------------

function homePage() {
  const c = state.config;
  const page = el('main', {});
  const domains = domainsSection();

  appendAll(page, [
    el(
      'section',
      { class: 'hero' },
      // The drifting light. An element of its own rather than a background,
      // because it needs three layers moving at different speeds, and it is
      // behind pointer-events: none so it can never eat a click.
      el('div', { class: 'aurora', 'aria-hidden': 'true' }, el('i', {})),
      el(
        'div',
        { class: 'wrap' },
        el(
          'div',
          { class: 'eyebrow' },
          el('span', { class: 'dot' }),
          c.isOpen ? 'Taking orders now' : 'Message us to order',
        ),
        // The last two or three words carry the gradient. Any more and it
        // stops being emphasis.
        headline(c.headline),
        el('p', { class: 'lede' }, c.subheadline),
        heroSearch(domains.search),
        state.plans.length
          ? el(
              'div',
              { class: 'hero-actions' },
              el('a', { class: 'btn lg', href: '#/', onclick: () => scrollTo('plans') }, icon('server', 17), 'See hosting plans'),
            )
          : null,
        el(
          'div',
          { class: 'trust' },
          el('span', {}, icon('check', 15), 'Free SSL on every plan'),
          el('span', {}, icon('check', 15), 'Daily backups'),
          el('span', {}, icon('check', 15), 'A real person answers'),
        ),
        !c.isOpen
          ? el(
              'div',
              { class: 'alert warn', style: 'margin-top:26px;max-width:38em' },
              'We are not taking online orders right now. Please message us and we will sort it out directly.',
            )
          : null,
      ),
    ),
    plansSection(),
    domains.node,
    helpSection(),
  ]);

  return { page, searchDomain: domains.search };
}

/// The search box at the top of the page — the first thing most visitors
/// came to do. It runs the same search as the Domains section below and
/// shows the answer there, scrolling down to it, so there is one list of
/// results rather than two that can disagree.
function heroSearch(search) {
  const input = el('input', {
    type: 'search',
    placeholder: 'Find your domain — e.g. yourbusiness.in',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Domain name to search for',
  });
  const button = el('button', { class: 'btn primary', type: 'submit' }, icon('search', 17), el('span', {}, 'Search'));

  const endings = state.tlds.length
    ? state.tlds.slice(0, 5).map((t) =>
        el('button', { type: 'button', class: 'ending', onclick: () => fillEnding(t.tld) }, `.${t.tld}`, el('span', { class: 'cost' }, t.register)),
      )
    : ['com', 'in', 'co.in', 'online'].map((t) =>
        el('button', { type: 'button', class: 'ending', onclick: () => fillEnding(t) }, `.${t}`),
      );

  // Clicking an ending puts it on whatever has been typed, so "myshop" and
  // a click on .in searches myshop.in.
  function fillEnding(tld) {
    const base = input.value.trim().toLowerCase().split('.')[0];
    if (!base) {
      input.focus();
      return;
    }
    input.value = `${base}.${tld}`;
    search(input.value, { scroll: true });
  }

  const form = el(
    'form',
    {
      class: 'hero-search',
      role: 'search',
      onsubmit: (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return input.focus();
        search(value, { scroll: true });
      },
    },
    el('div', { class: 'hero-search-box' }, el('span', { class: 'hero-search-ico' }, icon('globe', 20)), input, button),
    el('div', { class: 'hero-endings' }, el('span', { class: 'muted' }, 'Popular:'), endings),
  );
  return form;
}

/// The headline, with its last few words carrying the gradient.
///
/// Split here rather than asking whoever writes the headline to include
/// markup: the text is typed into a settings box by a person, and a settings
/// box that silently accepts HTML is a settings box that will one day be used
/// to inject some.
function headline(text) {
  const words = String(text || '').trim().split(/\s+/);
  if (words.length < 4) return el('h1', {}, text);

  const tail = words.slice(-2).join(' ');
  const head = words.slice(0, -2).join(' ');
  return el('h1', {}, `${head} `, el('span', { class: 'accent' }, tail));
}

function plansSection() {
  if (!state.plans.length) return null;

  return el(
    'section',
    { class: 'section', id: 'plans' },
    el(
      'div',
      { class: 'wrap' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Hosting plans'),
        el('p', {}, 'Pick one. Nothing is charged until you pay, and you can ask us anything first.'),
      ),
      el('div', { class: 'plans stagger' }, state.plans.map(planCard)),
    ),
  );
}

function planCard(plan) {
  const order = () =>
    openOrderForm(
      {
        kind: 'HOSTING',
        planId: plan.id,
        name: plan.name,
        price: plan.price,
        billingPeriod: plan.billingPeriod,
      },
      state.config,
    );

  return el(
    'div',
    { class: `plan ${plan.isFeatured ? 'featured' : ''}` },
    plan.isFeatured ? el('span', { class: 'flag' }, 'Most popular') : null,
    el('h3', {}, plan.name),
    el('p', { class: 'tagline' }, plan.tagline || ''),
    el(
      'div',
      { class: 'price' },
      el('span', { class: 'amount' }, plan.price),
      plan.wasPrice ? el('span', { class: 'was' }, plan.wasPrice) : null,
      el('span', { class: 'per' }, PERIOD[plan.billingPeriod] || ''),
    ),
    plan.features.length
      ? el('ul', { class: 'features' }, plan.features.map((f) => el('li', {}, icon('check', 15), el('span', {}, f))))
      : null,
    el(
      'button',
      { class: `btn ${plan.isFeatured ? 'primary' : ''} block`, disabled: !state.config.isOpen, onclick: order },
      state.config.isOpen ? 'Order this plan' : 'Ordering closed',
    ),
  );
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

function domainsSection() {
  const input = el('input', {
    type: 'search',
    placeholder: 'yourbusiness or yourbusiness.in',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Domain name to search for',
  });
  const button = el('button', { class: 'btn primary' }, icon('search', 16), 'Search');
  const summary = el('div', { 'aria-live': 'polite' });
  const results = el('div', { class: 'tld-results' });
  const alertHost = el('div');
  let latest = 0;

  /// Runs a search for `raw`, from this box or from the one at the top.
  async function search(raw, { scroll = false } = {}) {
    const name = String(raw || '').trim();
    input.value = name;
    clear(alertHost);
    if (!name) {
      input.focus();
      return;
    }

    // A search that is overtaken by a newer one is dropped when it lands,
    // so a slow answer cannot replace a quicker, later one.
    const mine = ++latest;
    button.disabled = true;
    clear(button).append(el('span', { class: 'spinner' }), 'Checking…');
    fill(summary, el('p', { class: 'muted search-status' }, `Checking ${name}…`));
    fill(results, ...Array.from({ length: 4 }, () => el('div', { class: 'tld-row is-loading', 'aria-hidden': 'true' })));
    if (scroll) document.getElementById('domains')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // The search goes in the address, so it can be shared or come back to,
    // without a hashchange that would redraw the page under it.
    try {
      history.replaceState(null, '', `#/search/${encodeURIComponent(name)}`);
    } catch {
      // Not worth failing a search over.
    }

    try {
      const data = await api('/domain-search', { method: 'POST', body: { name } });
      if (mine !== latest) return;
      drawResults(data);
    } catch (err) {
      if (mine !== latest) return;
      clear(summary);
      clear(results);
      alertHost.append(errorAlert(err));
    } finally {
      if (mine === latest) {
        button.disabled = false;
        clear(button).append(icon('search', 16), 'Search');
      }
    }
  }

  function drawResults(data) {
    const requested = data.results.find((r) => r.requested) || null;
    const free = data.results.filter((r) => r.available === true);
    const known = data.results.filter((r) => r.available !== null);

    // The answer to the question actually asked, in one line, before the
    // list. "Is myshop.in free?" deserves a yes or no about myshop.in; a bare
    // "myshop" asked about every ending, so it gets a count across them —
    // not a verdict on whichever ending happens to sort first.
    let verdict = null;
    if (requested && requested.available === true) {
      verdict = el('div', { class: 'verdict ok' }, icon('check', 18), el('span', {}, el('strong', {}, requested.domain), ' is available.'));
    } else if (requested && requested.available === false) {
      verdict = el(
        'div',
        { class: 'verdict taken' },
        el('span', {}, el('strong', {}, requested.domain), ' is already taken.'),
        free.length ? el('span', { class: 'muted' }, ' These are free:') : null,
      );
    } else if (!requested && known.length) {
      verdict = free.length
        ? el(
            'div',
            { class: 'verdict ok' },
            icon('check', 18),
            el('span', {}, el('strong', {}, data.name), ` is free with ${free.length} ending${free.length === 1 ? '' : 's'}.`),
          )
        : el('div', { class: 'verdict taken' }, el('span', {}, el('strong', {}, data.name), ' is taken with every ending we checked. Try another name.'));
    }

    appendAll(clear(summary), [
      verdict,
      !data.checked
        ? el(
            'div',
            { class: 'alert info' },
            'We could not check availability just now. You can still ask for any of these and we will confirm the name ' +
              'before taking payment.',
          )
        : null,
    ]);

    // Free first, then unknown, then taken, keeping the price list's order
    // within each — except the name that was typed, which stays on top.
    const rank = (r) => (r.requested ? -1 : r.available === true ? 0 : r.available === null ? 1 : 2);
    const ordered = data.results.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
    fill(results, ...ordered.map(tldRow));
  }

  button.onclick = () => search(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search(input.value);
    }
  };

  const node = el(
    'section',
    { class: 'section soft', id: 'domains' },
    el(
      'div',
      { class: 'wrap' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Find a domain'),
        el(
          'p',
          {},
          state.tlds.length
            ? 'Type a name and we will check it across every ending we sell.'
            : 'Type a name and we will check whether it is free.',
        ),
      ),
      el(
        'div',
        { class: 'search-card' },
        el('div', { class: 'search-row' }, input, button),
        alertHost,
        summary,
        results,
        state.tlds.length
          ? el(
              'div',
              { class: 'tld-chips' },
              state.tlds
                .slice(0, 8)
                .map((t) => el('span', { class: 'chip' }, el('span', { class: 'mono' }, `.${t.tld}`), el('span', { class: 'cost' }, t.register))),
            )
          : null,
      ),
    ),
  );

  return { node, search };
}

/// How to ask for a name that has no price on the list: WhatsApp if there is
/// a number, email if there is an address, and nothing if there is neither —
/// a button that goes nowhere is worse than none.
function askLink(domain) {
  const c = state.config;
  const text = `Hi, I would like to register ${domain}. What would it cost?`;
  const digits = String(c.whatsappNumber || '').replace(/\D/g, '');
  if (digits) {
    return el(
      'a',
      { class: 'btn sm primary', href: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' },
      'Ask for price',
    );
  }
  if (c.supportEmail) {
    return el(
      'a',
      { class: 'btn sm primary', href: `mailto:${c.supportEmail}?subject=${encodeURIComponent(`Registering ${domain}`)}&body=${encodeURIComponent(text)}` },
      'Ask for price',
    );
  }
  return null;
}

function tldRow(row) {
  const tone = row.available === true ? 'ok' : row.available === false ? 'danger' : 'warn';
  const label = row.available === true ? 'Available' : row.available === false ? 'Taken' : 'Unconfirmed';

  const order = () =>
    openOrderForm(
      {
        kind: 'DOMAIN',
        tld: row.tld,
        domainName: row.domain,
        name: `${row.domain} (1 year)`,
        price: row.register,
        billingPeriod: 'YEARLY',
      },
      state.config,
    );

  // What can be done about it. A taken name cannot be had; a priced one can
  // be ordered here; one with no price yet is asked about, never given a
  // number that nobody set.
  let action;
  if (row.available === false) action = el('span', { class: 'small muted' }, 'Try another name');
  else if (row.priced) action = el('button', { class: 'btn sm primary', disabled: !state.config.isOpen, onclick: order }, 'Order');
  else action = askLink(row.domain);

  return el(
    'div',
    { class: `tld-row ${row.requested ? 'is-requested' : ''} ${row.available === false ? 'is-taken' : ''}` },
    el(
      'span',
      { class: 'name grow' },
      row.domain,
      row.restriction ? el('span', { class: 'tiny muted restriction' }, ` · ${row.restriction}`) : null,
    ),
    row.renew ? el('span', { class: 'tiny muted' }, `renews at ${row.renew}`) : null,
    row.priced ? el('span', { class: 'cost' }, row.register) : el('span', { class: 'small muted' }, 'Price on request'),
    el('span', { class: `badge ${tone}` }, label),
    // "Unconfirmed" is still orderable: we check the name by hand before
    // asking for money, which is better than refusing a sale over a registry
    // that did not answer.
    action,
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpSection() {
  const c = state.config;
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'wrap' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Questions before you buy?'),
        el('p', {}, 'Message us. A person reads it, and you will get a straight answer.'),
      ),
      el(
        'div',
        { style: 'display:flex;gap:11px;flex-wrap:wrap' },
        c.whatsappLink
          ? el('a', { class: 'btn wa', href: c.whatsappLink, target: '_blank', rel: 'noopener' }, icon('whatsapp', 17), 'WhatsApp us')
          : null,
        c.supportEmail ? el('a', { class: 'btn', href: `mailto:${c.supportEmail}` }, icon('mail', 17), c.supportEmail) : null,
        el('button', { class: 'btn ghost', onclick: openLookup }, 'Check an existing order'),
      ),
      el(
        'div',
        { class: 'alert info', style: 'margin-top:30px;max-width:44em' },
        el('span', { class: 'strong' }, 'How paying works. '),
        'You place an order, pay by UPI, and tell us the reference. We check it against our account and confirm — ' +
          'usually within a few hours during business hours. Nothing is taken from your account automatically.',
      ),
    ),
  );
}
