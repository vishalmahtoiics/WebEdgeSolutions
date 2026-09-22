// What the storefront sells, and who is selling it. Super Admin only.
//
// Three things live on this page: the hosting plans, the domain price list, and
// the storefront's own settings. They are together because they are the same
// job — deciding what a visitor to the public site is offered.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, openModal,
  confirmModal, emptyState, errorAlert,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh } from '../app.js';

const PERIOD_LABEL = { MONTHLY: 'per month', YEARLY: 'per year' };

export async function renderPlans() {
  const [{ plans }, { tlds }, { settings }] = await Promise.all([
    api('/catalog/plans'),
    api('/catalog/tld-prices'),
    api('/catalog/store-settings'),
  ]);

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Plans & Pricing'),
        el('p', {}, 'What the public site offers, and how customers pay for it.'),
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener' }, 'View public site'),
        el('button', { class: 'btn primary', onclick: () => planModal() }, '+ Add Plan'),
      ),
    ),
    // The one thing that stops the store working, said before anything else.
    !settings.upiId
      ? el(
          'div',
          { class: 'alert warn' },
          el('span', { class: 'strong' }, 'No UPI ID set. '),
          'Customers can place orders but will not be shown any way to pay. Add one under Storefront settings below.',
        )
      : null,
    !settings.isOpen
      ? el('div', { class: 'alert info' }, 'The store is closed: plans are visible but nobody can order.')
      : null,
    plansCard(plans),
    tldCard(tlds),
    settingsCard(settings),
  ]);

  return frag;
}

// ---------------------------------------------------------------------------
// Hosting plans
// ---------------------------------------------------------------------------

function plansCard(plans) {
  const rows = plans.map((p) =>
    el(
      'tr',
      {},
      el(
        'td',
        {},
        el('div', { class: 'strong' }, p.name),
        el('div', { class: 'small muted mono' }, `/#/plan/${p.slug}`),
      ),
      el(
        'td',
        {},
        el('div', { class: 'strong' }, p.price),
        el('div', { class: 'small muted' }, PERIOD_LABEL[p.billingPeriod]),
      ),
      el('td', { class: 'small muted' }, `${(p.features || []).length} feature${(p.features || []).length === 1 ? '' : 's'}`),
      el('td', { class: 'small' }, p.orderCount ? String(p.orderCount) : el('span', { class: 'muted' }, '0')),
      el(
        'td',
        {},
        el('span', { class: `badge ${p.isActive ? 'ok' : ''}` }, p.isActive ? 'On sale' : 'Hidden'),
        p.isFeatured ? el('span', { class: 'badge accent', style: 'margin-left:6px' }, 'Featured') : null,
      ),
      el(
        'td',
        { class: 'actions' },
        el('button', { class: 'btn sm', onclick: () => planModal(p) }, 'Edit'),
        ' ',
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () =>
              confirmModal({
                title: 'Delete plan',
                message: p.orderCount
                  ? `${p.orderCount} order${p.orderCount === 1 ? '' : 's'} name this plan, so it will be hidden from the site rather than deleted — an order has to keep saying what was bought.`
                  : `Delete "${p.name}"? Nobody has ordered it, so it will be removed outright.`,
                confirmLabel: p.orderCount ? 'Hide plan' : 'Delete',
                onConfirm: async () => {
                  const res = await api(`/catalog/plans/${p.id}`, { method: 'DELETE' });
                  toast(res.message, 'ok');
                  refresh();
                },
              }),
          },
          p.orderCount ? 'Hide' : 'Delete',
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Hosting plans'),
        el('p', {}, 'Shown on the public site, cheapest first unless you set an order.'),
      ),
    ),
    plans.length
      ? el(
          'div',
          { class: 'card-body tight table-scroll' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el('tr', {}, el('th', {}, 'Plan'), el('th', {}, 'Price'), el('th', {}, 'Features'), el('th', {}, 'Orders'), el('th', {}, 'Status'), el('th', {}, '')),
            ),
            el('tbody', {}, rows),
          ),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState('server', 'No plans yet', 'Add one and it appears on the public site immediately.'),
        ),
  );
}

function planModal(plan = null) {
  const name = el('input', { type: 'text', value: plan?.name || '', placeholder: 'Business Hosting' });
  const tagline = el('input', { type: 'text', value: plan?.tagline || '', placeholder: 'For a growing site' });
  const price = el('input', { type: 'text', value: plan ? stripCurrency(plan.price) : '', placeholder: '1499' });
  const wasPrice = el('input', { type: 'text', value: plan?.wasPrice ? stripCurrency(plan.wasPrice) : '', placeholder: 'Optional' });
  const billingPeriod = el(
    'select',
    {},
    ['YEARLY', 'MONTHLY'].map((v) => el('option', { value: v, selected: plan?.billingPeriod === v }, PERIOD_LABEL[v])),
  );
  const features = el('textarea', { rows: 7, placeholder: '10 GB SSD storage\nFree SSL\nUnlimited email accounts' },
    (plan?.features || []).join('\n'));
  const slug = el('input', { type: 'text', value: plan?.slug || '', placeholder: 'left blank, made from the name' });
  const sortOrder = el('input', { type: 'number', value: plan?.sortOrder ?? 0, min: 0 });
  const isActive = el('input', { type: 'checkbox', checked: plan ? plan.isActive : true });
  const isFeatured = el('input', { type: 'checkbox', checked: Boolean(plan?.isFeatured) });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, plan ? 'Save plan' : 'Add plan');

  const close = openModal({
    title: plan ? `Edit ${plan.name}` : 'Add a plan',
    wide: true,
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el('div', { class: 'form-row' }, field('Name', name), field('Billing', billingPeriod)),
        field('Tagline', tagline, 'One line under the name.'),
        el(
          'div',
          { class: 'form-row' },
          field('Price ₹', price, 'Just the number, e.g. 1499 or 1499.50.'),
          field('Was ₹', wasPrice, 'Shown struck through, for a discount.'),
        ),
        field('Features', features, 'One per line. These are the ticks on the public card.'),
        el('div', { class: 'form-row' }, field('URL name', slug), field('Sort order', sortOrder)),
        el('label', { class: 'check' }, isActive, el('span', {}, 'On sale — visible on the public site')),
        el('label', { class: 'check', style: 'margin-top:8px' }, isFeatured, el('span', {}, 'Highlight as "Most popular"')),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = {
      name: name.value.trim(),
      slug: slug.value.trim(),
      tagline: tagline.value.trim(),
      price: price.value.trim(),
      wasPrice: wasPrice.value.trim(),
      billingPeriod: billingPeriod.value,
      features: features.value.split('\n').map((f) => f.trim()).filter(Boolean),
      isActive: isActive.checked,
      isFeatured: isFeatured.checked,
      sortOrder: Number(sortOrder.value) || 0,
    };
    await api(plan ? `/catalog/plans/${plan.id}` : '/catalog/plans', { method: plan ? 'PUT' : 'POST', body });
    close();
    toast(plan ? 'Plan saved.' : 'Plan added.', 'ok');
    refresh();
  });
}

/// The API returns formatted money for display; the form wants the plain number
/// back so it can be edited.
const stripCurrency = (text) => String(text || '').replace(/[^\d.]/g, '');

// ---------------------------------------------------------------------------
// Domain prices
// ---------------------------------------------------------------------------

function tldCard(tlds) {
  const rows = tlds.map((t) =>
    el(
      'tr',
      {},
      el('td', { class: 'mono strong' }, `.${t.tld}`),
      el('td', { class: 'strong' }, t.register),
      el('td', { class: 'small muted' }, t.renew || el('span', { class: 'muted' }, 'same')),
      el(
        'td',
        {},
        el('span', { class: `badge ${t.isActive ? 'ok' : ''}` }, t.isActive ? 'On sale' : 'Hidden'),
        t.isPopular ? el('span', { class: 'badge accent', style: 'margin-left:6px' }, 'Popular') : null,
      ),
      el(
        'td',
        { class: 'actions' },
        el('button', { class: 'btn sm', onclick: () => tldModal(t) }, 'Edit'),
        ' ',
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () =>
              confirmModal({
                title: 'Remove ending',
                message: `Remove .${t.tld} from the price list? It will stop being offered on the public site. Orders already placed keep their price.`,
                confirmLabel: 'Remove',
                onConfirm: async () => {
                  const res = await api(`/catalog/tld-prices/${encodeURIComponent(t.tld)}`, { method: 'DELETE' });
                  toast(res.message, 'ok');
                  refresh();
                },
              }),
          },
          'Remove',
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Domain prices'),
        el('p', {}, 'One price per ending. A customer searching a name is quoted from this list.'),
      ),
      el('button', { class: 'btn primary', onclick: () => tldModal() }, '+ Add Ending'),
    ),
    tlds.length
      ? el(
          'div',
          { class: 'card-body tight table-scroll' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el('tr', {}, el('th', {}, 'Ending'), el('th', {}, 'Register'), el('th', {}, 'Renews at'), el('th', {}, 'Status'), el('th', {}, '')),
            ),
            el('tbody', {}, rows),
          ),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState('globe', 'No domain endings priced', 'Add .com and .in to start, and the domain search appears on the public site.'),
        ),
  );
}

function tldModal(row = null) {
  const tld = el('input', { type: 'text', value: row?.tld || '', placeholder: 'com', disabled: Boolean(row) });
  const register = el('input', { type: 'text', value: row ? stripCurrency(row.register) : '', placeholder: '999' });
  const renew = el('input', { type: 'text', value: row?.renew ? stripCurrency(row.renew) : '', placeholder: 'Same as registration' });
  const sortOrder = el('input', { type: 'number', value: row?.sortOrder ?? 0, min: 0 });
  const isActive = el('input', { type: 'checkbox', checked: row ? row.isActive : true });
  const isPopular = el('input', { type: 'checkbox', checked: Boolean(row?.isPopular) });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, row ? 'Save price' : 'Add ending');

  const close = openModal({
    title: row ? `Edit .${row.tld}` : 'Add a domain ending',
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        field('Ending', tld, row ? 'The ending cannot be changed — remove it and add another instead.' : 'Without the dot: com, in, co.in'),
        el('div', { class: 'form-row' }, field('Register ₹', register), field('Renews at ₹', renew)),
        el(
          'p',
          { class: 'hint', style: 'margin:-6px 0 14px' },
          'Renewal is shown to customers next to the first-year price, so nobody is surprised a year later.',
        ),
        field('Sort order', sortOrder),
        el('label', { class: 'check' }, isActive, el('span', {}, 'On sale')),
        el('label', { class: 'check', style: 'margin-top:8px' }, isPopular, el('span', {}, 'Mark as popular')),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    await api('/catalog/tld-prices', {
      method: 'PUT',
      body: {
        tld: row?.tld || tld.value.trim(),
        register: register.value.trim(),
        renew: renew.value.trim(),
        isActive: isActive.checked,
        isPopular: isPopular.checked,
        sortOrder: Number(sortOrder.value) || 0,
      },
    });
    close();
    toast('Price saved.', 'ok');
    refresh();
  });
}

// ---------------------------------------------------------------------------
// Storefront settings
// ---------------------------------------------------------------------------

function settingsCard(settings) {
  const inputs = {
    businessName: el('input', { type: 'text', value: settings.businessName || '', placeholder: 'Web Edge Solutions' }),
    headline: el('input', { type: 'text', value: settings.headline || '', placeholder: 'Hosting that just works' }),
    subheadline: el('input', { type: 'text', value: settings.subheadline || '', placeholder: 'Pick a plan, or search for a domain.' }),
    supportEmail: el('input', { type: 'text', value: settings.supportEmail || '', placeholder: 'support@example.com' }),
    upiId: el('input', { type: 'text', value: settings.upiId || '', placeholder: 'yourname@bank' }),
    upiPayeeName: el('input', { type: 'text', value: settings.upiPayeeName || '', placeholder: 'The name your UPI shows' }),
    whatsappNumber: el('input', { type: 'text', value: settings.whatsappNumber || '', placeholder: '+91 98765 43210' }),
  };
  const isOpen = el('input', { type: 'checkbox', checked: settings.isOpen });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save storefront settings');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
    body.isOpen = isOpen.checked;
    const res = await api('/catalog/store-settings', { method: 'PUT', body });
    toast(res.message, 'ok');
    refresh();
  });

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Storefront settings'),
        el('p', {}, 'How the public site introduces you, and how customers pay.'),
      ),
    ),
    el(
      'div',
      { class: 'card-body' },
      alertHost,
      el('div', { class: 'grid-2' },
        el(
          'div',
          {},
          el('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Presentation'),
          field('Business name', inputs.businessName),
          field('Headline', inputs.headline),
          field('Sub-headline', inputs.subheadline),
          field('Support email', inputs.supportEmail),
        ),
        el(
          'div',
          {},
          el('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Getting paid'),
          field('UPI ID', inputs.upiId, 'Where money arrives. Check this carefully — it is what customers pay into.'),
          field('Payee name', inputs.upiPayeeName, 'Shown in their app. Customers are told to stop if it does not match.'),
          field('WhatsApp number', inputs.whatsappNumber, 'With country code. Used for the WhatsApp buttons.'),
          settings.upiPreview
            ? el(
                'p',
                { class: 'hint break', style: 'margin-top:-6px' },
                'A payment link looks like: ',
                el('span', { class: 'mono' }, settings.upiPreview),
              )
            : null,
        ),
      ),
      el(
        'div',
        { class: 'alert warn', style: 'margin:6px 0 16px' },
        el('span', { class: 'strong' }, 'UPI payments are not verified automatically. '),
        'There is no way for a UPI transfer to report itself back to this site. Every order waits in the Orders ' +
          'queue until you check your account and confirm it. Treat a customer-supplied reference as a claim, not proof.',
      ),
      el('label', { class: 'check' }, isOpen, el('span', {}, 'Store is open — visitors can place orders')),
      el('div', { style: 'margin-top:18px' }, save),
    ),
  );
}
