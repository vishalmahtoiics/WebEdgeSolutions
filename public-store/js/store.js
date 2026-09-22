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

  fill(app, header(), homePage(), footer(), waFloat());
  // A #/…#plans style link should still land on the right block.
  if (name === 'plans' || name === 'domains') {
    document.getElementById(name)?.scrollIntoView({ block: 'start' });
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
        // The portal moved under /portal when the storefront took the root.
        el('a', { href: '/portal', class: 'btn sm' }, 'Client login'),
      ),
    ),
  );
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

  appendAll(page, [
    el(
      'section',
      { class: 'hero' },
      el(
        'div',
        { class: 'wrap' },
        el('h1', {}, c.headline),
        el('p', { class: 'lede' }, c.subheadline),
        el(
          'div',
          { class: 'hero-actions' },
          el('a', { class: 'btn primary', href: '#/', onclick: () => scrollTo('plans') }, icon('server', 17), 'See hosting plans'),
          el('a', { class: 'btn', href: '#/', onclick: () => scrollTo('domains') }, icon('globe', 17), 'Find a domain'),
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
    domainsSection(),
    helpSection(),
  ]);

  return page;
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
      el('div', { class: 'plans' }, state.plans.map(planCard)),
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
  if (!state.tlds.length) return null;

  const input = el('input', { type: 'search', placeholder: 'yourbusiness', autocomplete: 'off', 'aria-label': 'Domain name to search for' });
  const search = el('button', { class: 'btn primary' }, icon('search', 16), 'Search');
  const results = el('div', { class: 'tld-results' });
  const alertHost = el('div');

  const run = submitHandler(search, alertHost, async () => {
    const name = input.value.trim().toLowerCase();
    if (!name) throw new Error('Type a name to search for.');

    clear(results);
    const data = await api('/domain-search', { method: 'POST', body: { name } });

    search.disabled = false;
    clear(search).append(icon('search', 16), 'Search');

    if (!data.checked) {
      results.append(
        el(
          'div',
          { class: 'alert info' },
          'We could not check availability just now, so these are prices only. Order anyway and we will confirm the name ' +
            'before taking payment — or message us and we will check for you.',
        ),
      );
    }
    appendAll(results, data.results.map(tldRow));
  });

  search.onclick = run;
  input.onkeydown = (e) => e.key === 'Enter' && run(e);

  return el(
    'section',
    { class: 'section soft', id: 'domains' },
    el(
      'div',
      { class: 'wrap' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Find a domain'),
        el('p', {}, 'Type a name and we will price it across every ending we sell.'),
      ),
      el(
        'div',
        { class: 'search-card' },
        el('div', { class: 'search-row' }, input, search),
        alertHost,
        results,
        el(
          'div',
          { class: 'tld-chips' },
          state.tlds
            .slice(0, 8)
            .map((t) => el('span', { class: 'chip' }, el('span', { class: 'mono' }, `.${t.tld}`), el('span', { class: 'cost' }, t.register))),
        ),
      ),
    ),
  );
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

  return el(
    'div',
    { class: 'tld-row' },
    el('span', { class: 'name grow' }, row.domain),
    row.renew ? el('span', { class: 'tiny muted' }, `renews at ${row.renew}`) : null,
    el('span', { class: 'cost' }, row.register),
    el('span', { class: `badge ${tone}` }, label),
    // "Unconfirmed" is still orderable: we check the name by hand before
    // asking for money, which is better than refusing a sale over a registry
    // that did not answer.
    row.available === false
      ? el('span', { class: 'small muted' }, 'Try another name')
      : el('button', { class: 'btn sm primary', disabled: !state.config.isOpen, onclick: order }, 'Order'),
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
