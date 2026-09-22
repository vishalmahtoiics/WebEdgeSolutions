// Quotations and invoices.
//
// Three screens in one view: the list, the editor, and the document itself.
// The document is the interesting one — it is laid out to be printed, because
// nothing here generates a PDF file. The browser's own "Save as PDF" does
// that, and saying so plainly is better than shipping something that produces
// a worse PDF and calls itself a PDF generator.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, errorAlert,
  emptyState, formatDate, openModal, confirmModal, tableView,
} from '../core.js';
import { icon } from '../icons.js';
import { navigate, refresh } from '../app.js';

// --- Money, in the browser --------------------------------------------------
//
// Mirrors src/lib/money.js. Duplicated rather than shared because there is no
// build step here, and a figure on screen that disagrees with the figure on
// the invoice would be worse than a little repetition.

const rupees = (minor) => {
  if (minor === null || minor === undefined) return '';
  const whole = Math.trunc(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;
  const text = String(whole);
  const grouped =
    text.length <= 3
      ? text
      : `${text.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${text.slice(-3)}`;
  return `${minor < 0 ? '−' : ''}₹${grouped}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`;
};

const editable = (minor) => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace(/\.00$/, ''));

const STATUS_TONE = {
  DRAFT: '', SENT: 'accent', ACCEPTED: 'accent', PAID: 'ok', CANCELLED: 'warn',
};

const GST_RATES = [0, 5, 12, 18, 28];

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export async function renderBilling({ param, user }) {
  // #/billing/<id> opens one document.
  if (param) return renderDocument(param, user);

  const isAdmin = user.role === 'SUPER_ADMIN';
  const [{ documents, outstandingMinor }, store] = await Promise.all([
    api('/billing'),
    isAdmin ? api('/catalog/store-settings').then((r) => r.settings).catch(() => null) : null,
  ]);

  const quotations = documents.filter((d) => d.kind === 'QUOTATION');
  const invoices = documents.filter((d) => d.kind === 'INVOICE');

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, isAdmin ? 'Invoices & Quotations' : 'My Invoices'),
        el(
          'p',
          {},
          isAdmin
            ? 'Raise a quotation, turn it into an invoice, and record what has been paid.'
            : 'Everything we have billed you for.',
        ),
      ),
      isAdmin
        ? el(
            'div',
            { style: 'display:flex;gap:9px;flex-wrap:wrap' },
            el('button', { class: 'btn', onclick: () => openEditor('QUOTATION', null, store) }, 'New quotation'),
            el('button', { class: 'btn primary', onclick: () => openEditor('INVOICE', null, store) }, icon('receipt', 16), 'New invoice'),
          )
        : null,
    ),

    // Without your own GSTIN there is nothing to charge tax under, so say so
    // here rather than letting somebody issue a tax invoice that should have
    // been a bill of supply.
    isAdmin && store && !store.gstin
      ? el(
          'div',
          { class: 'alert info' },
          el('span', { class: 'strong' }, 'No GSTIN saved. '),
          'Invoices will be issued as a bill of supply, with no tax on them. Add your GSTIN under ',
          el('a', { href: '#/plans', style: 'text-decoration:underline' }, 'Plans & Pricing → Business details'),
          ' to charge GST.',
        )
      : null,

    outstandingMinor
      ? el(
          'div',
          { class: 'alert warn' },
          el('span', { class: 'strong' }, `${rupees(outstandingMinor)} outstanding. `),
          'Across every invoice that is not paid or cancelled.',
        )
      : null,

    documentTable('Invoices', invoices, isAdmin, store),
    documentTable('Quotations', quotations, isAdmin, store),
  ]);
  return frag;
}

function documentTable(title, documents, isAdmin, store) {
  const body = el('div', { class: 'card-body tight' });

  if (!documents.length) {
    fill(
      body,
      el(
        'div',
        { style: 'padding:24px' },
        emptyState('receipt', `No ${title.toLowerCase()} yet`, isAdmin ? 'Create one with the button above.' : 'Nothing here yet.'),
      ),
    );
  } else {
    fill(
      body,
      tableView({
        head: el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Number'),
            el('th', {}, 'Date'),
            el('th', {}, 'Customer'),
            el('th', { class: 'right' }, 'Amount'),
            el('th', {}, 'Status'),
            el('th', {}, ''),
          ),
        ),
        noun: { one: title.toLowerCase().replace(/s$/, ''), many: title.toLowerCase() },
        searchPlaceholder: `Search ${title.toLowerCase()}…`,
        rows: documents.map((doc) => ({
          text: `${doc.number} ${doc.customerName} ${doc.domain?.name || ''} ${doc.status}`,
          node: el(
              'tr',
              {},
              el(
                'td',
                {},
                el('span', { class: 'mono strong small' }, doc.number),
                doc.gstEnabled ? null : el('div', { class: 'small muted' }, 'No GST'),
              ),
              el('td', { class: 'small muted nowrap' }, formatDate(doc.issueDate)),
              el(
                'td',
                { class: 'small' },
                doc.customerName,
                doc.domain ? el('div', { class: 'small muted mono' }, doc.domain.name) : null,
              ),
              el(
                'td',
                { class: 'right' },
                el('span', { class: 'strong' }, rupees(doc.totalMinor)),
                doc.kind === 'INVOICE' && doc.amountPaidMinor && doc.amountPaidMinor < doc.totalMinor
                  ? el('div', { class: 'small muted' }, `${rupees(doc.totalMinor - doc.amountPaidMinor)} due`)
                  : null,
              ),
              el('td', {}, el('span', { class: `badge ${STATUS_TONE[doc.status] || ''}` }, doc.status.toLowerCase())),
              el(
                'td',
                { class: 'right nowrap' },
                el('button', { class: 'btn sm', onclick: () => navigate(`billing/${doc.id}`) }, 'Open'),
              ),
          ),
        })),
      }),
    );
  }

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el('div', { class: 'grow' }, el('h2', {}, title), el('p', {}, `${documents.length} total`)),
    ),
    body,
  );
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

async function renderDocument(id, user) {
  const { document: doc, editable: mayEdit } = await api(`/billing/${id}`);
  const isAdmin = user.role === 'SUPER_ADMIN';
  const isInvoice = doc.kind === 'INVOICE';

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head no-print' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, `${isInvoice ? 'Invoice' : 'Quotation'} ${doc.number}`),
        el(
          'p',
          {},
          `${doc.customerName} · ${rupees(doc.totalMinor)}`,
          doc.gstEnabled ? '' : ' · issued without GST',
        ),
      ),
      el('button', { class: 'btn', onclick: () => navigate('billing') }, 'Back'),
    ),

    isAdmin ? actionBar(doc, mayEdit) : null,
    printable(doc),
  ]);
  return frag;
}

function actionBar(doc, mayEdit) {
  const buttons = [
    el('button', { class: 'btn', onclick: () => window.print() }, icon('printer', 16), 'Print / Save as PDF'),
  ];

  if (mayEdit) {
    buttons.push(el('button', { class: 'btn', onclick: () => openEditor(doc.kind, doc) }, 'Edit'));
  }

  if (doc.customerEmail && doc.status !== 'CANCELLED') {
    buttons.push(el('button', { class: 'btn', onclick: () => sendDialog(doc) }, icon('mail', 16), 'Email to customer'));
  }

  if (doc.kind === 'QUOTATION' && !doc.convertedToId && doc.status !== 'CANCELLED') {
    buttons.push(
      el(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            confirmModal({
              title: 'Turn this into an invoice',
              message:
                `A new invoice will be raised with the same lines and totals. ${doc.number} stays exactly as it is, ` +
                'so you can always show what was quoted.',
              confirmLabel: 'Raise the invoice',
              danger: false,
              onConfirm: async () => {
                const { document: invoice } = await api(`/billing/${doc.id}/convert`, { method: 'POST' });
                toast(`Invoice ${invoice.number} raised.`, 'ok');
                navigate(`billing/${invoice.id}`);
              },
            }),
        },
        'Convert to invoice',
      ),
    );
  }

  if (doc.kind === 'INVOICE' && doc.status !== 'PAID' && doc.status !== 'CANCELLED') {
    buttons.push(el('button', { class: 'btn primary', onclick: () => paymentDialog(doc) }, 'Record a payment'));
  }

  if (doc.status !== 'CANCELLED' && !doc.amountPaidMinor) {
    buttons.push(
      el(
        'button',
        {
          class: 'btn danger',
          onclick: () =>
            confirmModal({
              title: `Cancel ${doc.number}?`,
              message:
                'It keeps its number and stays in the list, marked cancelled. A gap in a series is ordinary; ' +
                'a reused number is not, so the number is never given to anything else.',
              confirmLabel: 'Cancel it',
              onConfirm: async () => {
                await api(`/billing/${doc.id}/status`, { method: 'POST', body: { status: 'CANCELLED' } });
                toast(`${doc.number} cancelled.`, 'ok');
                refresh();
              },
            }),
        },
        'Cancel',
      ),
    );
  }

  return el(
    'div',
    { class: 'card no-print', style: 'margin-bottom:18px' },
    el('div', { class: 'card-body', style: 'display:flex;gap:9px;flex-wrap:wrap' }, buttons),
  );
}

function sendDialog(doc) {
  const message = el('textarea', { rows: 3, placeholder: 'Anything to say alongside it (optional)' });
  const alertHost = el('div');
  const go = el('button', { class: 'btn primary' }, 'Send it');

  const close = openModal({
    title: `Email ${doc.number}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted', style: 'margin-top:0' }, `Goes to ${doc.customerEmail}, through your own SMTP server.`),
        field('Message', message),
        el(
          'p',
          { class: 'hint' },
          'Sent as text, with the lines and totals in the body. There is no PDF attached — use Print / ' +
            'Save as PDF for that, which is the browser doing it rather than this portal pretending to.',
        ),
      ),
    footer: () => go,
  });

  go.onclick = submitHandler(go, alertHost, async () => {
    const res = await api(`/billing/${doc.id}/send`, { method: 'POST', body: { message: message.value } });
    close();
    toast(res.message, 'ok');
    refresh();
  });
}

function paymentDialog(doc) {
  const due = doc.totalMinor - doc.amountPaidMinor;
  const amount = el('input', { type: 'text', value: editable(due) });
  const reference = el('input', { type: 'text', placeholder: 'UPI reference, cheque number…' });
  const alertHost = el('div');
  const go = el('button', { class: 'btn primary' }, 'Record it');

  const close = openModal({
    title: `Payment against ${doc.number}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted', style: 'margin-top:0' }, `${rupees(due)} outstanding.`),
        field('Amount received', amount, 'Less than the full amount is fine — the balance stays on the invoice.'),
        field('Reference', reference),
      ),
    footer: () => go,
  });

  go.onclick = submitHandler(go, alertHost, async () => {
    await api(`/billing/${doc.id}/payment`, {
      method: 'POST',
      body: { amount: amount.value, reference: reference.value },
    });
    close();
    toast('Payment recorded.', 'ok');
    refresh();
  });
}

// ---------------------------------------------------------------------------
// The printable document
// ---------------------------------------------------------------------------

const line = (label, value) =>
  value ? el('div', { class: 'small' }, el('span', { class: 'muted' }, `${label}: `), value) : null;

function printable(doc) {
  const seller = doc.seller || {};
  const isInvoice = doc.kind === 'INVOICE';

  const sellerAddress = [seller.addressLine1, seller.addressLine2, [seller.city, seller.pincode].filter(Boolean).join(' '), seller.stateName]
    .filter(Boolean);

  return el(
    'div',
    { class: 'card doc-sheet' },
    el(
      'div',
      { class: 'card-body' },

      // Heading
      el(
        'div',
        { class: 'doc-top' },
        el(
          'div',
          {},
          el('div', { class: 'doc-seller-name' }, seller.name || 'Your business'),
          ...sellerAddress.map((l) => el('div', { class: 'small muted' }, l)),
          seller.gstin ? el('div', { class: 'small', style: 'margin-top:4px' }, el('span', { class: 'muted' }, 'GSTIN: '), el('span', { class: 'mono' }, seller.gstin)) : null,
          seller.pan ? el('div', { class: 'small' }, el('span', { class: 'muted' }, 'PAN: '), el('span', { class: 'mono' }, seller.pan)) : null,
        ),
        el(
          'div',
          { class: 'doc-title-block' },
          el('div', { class: 'doc-title' }, isInvoice ? (doc.gstEnabled ? 'TAX INVOICE' : 'BILL OF SUPPLY') : 'QUOTATION'),
          el('div', { class: 'mono strong' }, doc.number),
          el('div', { class: 'small muted' }, formatDate(doc.issueDate)),
          doc.status === 'CANCELLED' ? el('div', { class: 'badge warn', style: 'margin-top:6px' }, 'cancelled') : null,
          doc.status === 'PAID' ? el('div', { class: 'badge ok', style: 'margin-top:6px' }, 'paid') : null,
        ),
      ),

      el('hr', { class: 'doc-rule' }),

      // Parties and dates
      el(
        'div',
        { class: 'doc-parties' },
        el(
          'div',
          {},
          el('div', { class: 'doc-label' }, isInvoice ? 'Billed to' : 'Prepared for'),
          el('div', { class: 'strong' }, doc.customerName),
          doc.customerAddress
            ? el('div', { class: 'small muted', style: 'white-space:pre-wrap' }, doc.customerAddress)
            : null,
          line('GSTIN', doc.customerGstin),
          line('State code', doc.customerStateCode),
          line('Email', doc.customerEmail),
          line('Phone', doc.customerPhone),
        ),
        el(
          'div',
          {},
          doc.dueDate ? line('Due', formatDate(doc.dueDate)) : null,
          doc.validUntil ? line('Valid until', formatDate(doc.validUntil)) : null,
          doc.domain ? line('Domain', doc.domain.name) : null,
          doc.gstEnabled ? line('Tax', doc.isInterState ? 'IGST (inter-state)' : 'CGST + SGST (within state)') : null,
          doc.pricesIncludeTax ? line('Prices', 'inclusive of tax') : null,
        ),
      ),

      // Lines
      el(
        'table',
        { class: 'doc-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, '#'),
            el('th', {}, 'Description'),
            el('th', {}, 'HSN/SAC'),
            el('th', { class: 'right' }, 'Qty'),
            el('th', { class: 'right' }, 'Rate'),
            doc.gstEnabled ? el('th', { class: 'right' }, 'GST') : null,
            el('th', { class: 'right' }, doc.gstEnabled ? 'Taxable value' : 'Amount'),
          ),
        ),
        el(
          'tbody',
          {},
          (doc.items || []).map((item, i) =>
            el(
              'tr',
              {},
              el('td', { class: 'muted small' }, String(i + 1)),
              el('td', {}, item.description),
              el('td', { class: 'mono small muted' }, item.hsnCode || '—'),
              el('td', { class: 'right' }, String(item.quantity)),
              el('td', { class: 'right' }, rupees(item.unitPriceMinor)),
              doc.gstEnabled
                ? el(
                    'td',
                    { class: 'right small' },
                    `${item.taxRatePct}%`,
                    el('div', { class: 'muted' }, rupees(item.lineTaxMinor)),
                  )
                : null,
              // The taxable value, not the line's tax-inclusive total. This
              // column has to add up to the subtotal underneath it — showing
              // tax here as well would make the invoice appear to charge it
              // twice, once per line and once at the bottom.
              el(
                'td',
                { class: 'right strong' },
                rupees(item.lineTaxableMinor),
                item.lineDiscountMinor
                  ? el('div', { class: 'small muted' }, `less ${rupees(item.lineDiscountMinor)}`)
                  : null,
              ),
            ),
          ),
        ),
      ),

      // Totals
      el(
        'div',
        { class: 'doc-totals' },
        el(
          'div',
          { class: 'doc-total-rows' },
          totalRow('Subtotal', doc.subtotalMinor),
          doc.discountMinor ? totalRow('Discount', -doc.discountMinor) : null,
          doc.gstEnabled && doc.discountMinor ? totalRow('Taxable value', doc.taxableMinor) : null,
          doc.cgstMinor ? totalRow('CGST', doc.cgstMinor) : null,
          doc.sgstMinor ? totalRow('SGST', doc.sgstMinor) : null,
          doc.igstMinor ? totalRow('IGST', doc.igstMinor) : null,
          totalRow('Total', doc.totalMinor, true),
          doc.amountPaidMinor ? totalRow('Paid', doc.amountPaidMinor) : null,
          doc.amountPaidMinor ? totalRow('Outstanding', doc.outstandingMinor, true) : null,
        ),
      ),

      el('div', { class: 'doc-words' }, doc.amountInWords),

      // The tax summary a GST invoice has to carry.
      doc.gstEnabled && doc.rateBreakdown?.length
        ? el(
            'div',
            { style: 'margin-top:18px' },
            el('div', { class: 'doc-label' }, 'Tax summary'),
            el(
              'table',
              { class: 'doc-table small' },
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', {}, 'Rate'),
                  el('th', { class: 'right' }, 'Taxable value'),
                  doc.isInterState ? el('th', { class: 'right' }, 'IGST') : el('th', { class: 'right' }, 'CGST'),
                  doc.isInterState ? null : el('th', { class: 'right' }, 'SGST'),
                ),
              ),
              el(
                'tbody',
                {},
                doc.rateBreakdown.map((row) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, `${row.taxRatePct}%`),
                    el('td', { class: 'right' }, rupees(row.taxableMinor)),
                    el('td', { class: 'right' }, rupees(doc.isInterState ? row.igstMinor : row.cgstMinor)),
                    doc.isInterState ? null : el('td', { class: 'right' }, rupees(row.sgstMinor)),
                  ),
                ),
              ),
            ),
          )
        : null,

      !doc.gstEnabled
        ? el(
            'p',
            { class: 'small muted', style: 'margin-top:16px' },
            isInvoice
              ? 'This is a bill of supply. No GST has been charged on it.'
              : 'No GST has been included in these figures.',
          )
        : null,

      // Payment details and the small print.
      el(
        'div',
        { class: 'doc-foot' },
        isInvoice && doc.status !== 'PAID' && (seller.upiId || seller.bankAccount)
          ? el(
              'div',
              {},
              el('div', { class: 'doc-label' }, 'How to pay'),
              seller.upiId ? el('div', { class: 'small' }, 'UPI: ', el('span', { class: 'mono' }, seller.upiId)) : null,
              seller.bankAccount
                ? el(
                    'div',
                    { class: 'small' },
                    `${seller.bankName || 'Bank'}: `,
                    el('span', { class: 'mono' }, seller.bankAccount),
                    seller.bankIfsc ? el('div', { class: 'small muted' }, `IFSC ${seller.bankIfsc}`) : null,
                  )
                : null,
              doc.paymentReference ? el('div', { class: 'small muted' }, `Reference: ${doc.paymentReference}`) : null,
            )
          : el('div', {}),
        el(
          'div',
          {},
          doc.notes ? el('div', { class: 'small', style: 'white-space:pre-wrap;margin-bottom:8px' }, doc.notes) : null,
          doc.terms
            ? el(
                'div',
                {},
                el('div', { class: 'doc-label' }, 'Terms'),
                el('div', { class: 'small muted', style: 'white-space:pre-wrap' }, doc.terms),
              )
            : null,
          el('div', { class: 'small muted', style: 'margin-top:14px' }, 'This is a computer-generated document.'),
        ),
      ),
    ),
  );
}

const totalRow = (label, minor, strong = false) =>
  el(
    'div',
    { class: `doc-total-row ${strong ? 'strong' : ''}` },
    el('span', {}, label),
    el('span', {}, rupees(minor)),
  );

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/// Builds a document, showing the tax as it is typed.
///
/// The preview comes from the server rather than being recomputed here, so
/// what is on screen is produced by exactly the code that will produce the
/// saved document. Two implementations of GST arithmetic would eventually
/// disagree, and the one that disagreed would be the one on the invoice.
async function openEditor(kind, existing, store) {
  const settings = store || (await api('/catalog/store-settings').then((r) => r.settings).catch(() => ({})));
  const isInvoice = kind === 'INVOICE';

  const customer = {
    name: el('input', { type: 'text', value: existing?.customerName || '' }),
    email: el('input', { type: 'email', value: existing?.customerEmail || '' }),
    phone: el('input', { type: 'text', value: existing?.customerPhone || '' }),
    address: el('textarea', { rows: 3 }, existing?.customerAddress || ''),
    gstin: el('input', { type: 'text', value: existing?.customerGstin || '', placeholder: '09AABCU9603R1ZM' }),
    stateCode: el('input', { type: 'text', value: existing?.customerStateCode || '', placeholder: '09', style: 'max-width:90px' }),
  };
  customer.address.value = existing?.customerAddress || '';

  const gstEnabled = el('input', {
    type: 'checkbox',
    checked: existing ? existing.gstEnabled : settings.gstEnabledByDefault !== false,
    disabled: !settings.gstin,
  });
  const pricesIncludeTax = el('input', { type: 'checkbox', checked: Boolean(existing?.pricesIncludeTax) });
  const discount = el('input', { type: 'text', value: editable(existing?.discountMinor) || '', placeholder: '0' });
  const dueDate = el('input', { type: 'date', value: existing?.dueDate?.slice(0, 10) || '' });
  const notes = el('textarea', { rows: 2 });
  notes.value = existing?.notes || '';
  const terms = el('textarea', { rows: 2 });
  terms.value = existing?.terms || (isInvoice ? settings.invoiceTerms : settings.quotationTerms) || '';

  const rows = el('div');
  const summary = el('div', { class: 'doc-preview' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, existing ? 'Save changes' : `Create ${isInvoice ? 'invoice' : 'quotation'}`);

  const defaultRate = settings.defaultTaxPct ?? 18;

  function addRow(item) {
    const description = el('input', { type: 'text', value: item?.description || '', placeholder: 'Business hosting — 1 year' });
    const hsn = el('input', { type: 'text', value: item?.hsnCode || '', placeholder: '998315', style: 'max-width:110px' });
    const quantity = el('input', { type: 'number', min: '1', value: item?.quantity ?? 1, style: 'max-width:80px' });
    const price = el('input', { type: 'text', value: editable(item?.unitPriceMinor) || '', placeholder: '4999', style: 'max-width:120px' });
    const rate = el(
      'select',
      { style: 'max-width:90px' },
      ...GST_RATES.map((r) =>
        el('option', { value: String(r), selected: (item?.taxRatePct ?? defaultRate) === r }, `${r}%`),
      ),
    );
    const remove = el('button', { class: 'btn sm danger', type: 'button' }, '×');

    const row = el(
      'div',
      { class: 'doc-edit-row' },
      description,
      hsn,
      quantity,
      price,
      rate,
      remove,
    );
    row.read = () => ({
      description: description.value.trim(),
      hsnCode: hsn.value.trim(),
      quantity: Number(quantity.value) || 1,
      unitPrice: price.value.trim(),
      taxRatePct: Number(rate.value),
    });

    remove.onclick = () => {
      if (rows.children.length === 1) return toast('A document needs at least one line.', 'error');
      row.remove();
      preview();
    };
    [description, quantity, price].forEach((i) => (i.oninput = schedulePreview));
    rate.onchange = preview;

    rows.append(row);
    return row;
  }

  const body = () => ({
    customerName: customer.name.value.trim(),
    customerEmail: customer.email.value.trim(),
    customerPhone: customer.phone.value.trim(),
    customerAddress: customer.address.value.trim(),
    customerGstin: customer.gstin.value.trim(),
    customerStateCode: customer.stateCode.value.trim(),
    gstEnabled: gstEnabled.checked,
    pricesIncludeTax: pricesIncludeTax.checked,
    discount: discount.value.trim() || '0',
    dueDate: dueDate.value || undefined,
    notes: notes.value.trim(),
    terms: terms.value.trim(),
    items: [...rows.children].map((r) => r.read()).filter((i) => i.description && i.unitPrice !== ''),
  });

  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 350);
  };

  async function preview() {
    const payload = body();
    if (!payload.items.length) {
      return fill(summary, el('div', { class: 'muted small' }, 'Add a line to see the total.'));
    }
    try {
      const { totals } = await api('/billing/preview', { method: 'POST', body: { ...payload, customerName: payload.customerName || '—' } });
      fill(
        summary,
        totalRow('Subtotal', totals.subtotalMinor),
        totals.discountMinor ? totalRow('Discount', -totals.discountMinor) : null,
        totals.cgstMinor ? totalRow('CGST', totals.cgstMinor) : null,
        totals.sgstMinor ? totalRow('SGST', totals.sgstMinor) : null,
        totals.igstMinor ? totalRow('IGST', totals.igstMinor) : null,
        totalRow('Total', totals.totalMinor, true),
        el('div', { class: 'small muted', style: 'margin-top:8px' }, totals.taxNote),
      );
    } catch (err) {
      fill(summary, el('div', { class: 'small', style: 'color:var(--danger,#dc2626)' }, err.message));
    }
  }

  [customer.gstin, customer.stateCode, discount].forEach((i) => (i.oninput = schedulePreview));
  [gstEnabled, pricesIncludeTax].forEach((i) => (i.onchange = preview));

  const close = openModal({
    wide: true,
    title: existing ? `Edit ${existing.number}` : `New ${isInvoice ? 'invoice' : 'quotation'}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'div',
          { class: 'grid-2' },
          el(
            'div',
            {},
            el('h3', { class: 'doc-section' }, 'Customer'),
            field('Name', customer.name),
            el('div', { class: 'form-row' }, field('Email', customer.email), field('Phone', customer.phone)),
            field('Address', customer.address),
            el(
              'div',
              { class: 'form-row' },
              field('GSTIN', customer.gstin, 'Fills the state in by itself.'),
              field('State code', customer.stateCode),
            ),
          ),
          el(
            'div',
            {},
            el('h3', { class: 'doc-section' }, 'This document'),
            el(
              'label',
              { class: 'check', style: 'margin-bottom:10px' },
              gstEnabled,
              el(
                'span',
                {},
                el('span', { class: 'strong' }, 'Charge GST'),
                el(
                  'div',
                  { class: 'small muted' },
                  settings.gstin
                    ? 'Off issues it as a bill of supply, with no tax.'
                    : 'Add your own GSTIN under Plans & Pricing first.',
                ),
              ),
            ),
            el(
              'label',
              { class: 'check', style: 'margin-bottom:12px' },
              pricesIncludeTax,
              el(
                'span',
                {},
                el('span', { class: 'strong' }, 'Prices already include tax'),
                el('div', { class: 'small muted' }, 'The tax is worked backwards out of what you type.'),
              ),
            ),
            el(
              'div',
              { class: 'form-row' },
              field('Discount (₹)', discount),
              isInvoice ? field('Due date', dueDate) : el('div'),
            ),
          ),
        ),

        el('h3', { class: 'doc-section' }, 'Lines'),
        el(
          'div',
          { class: 'doc-edit-head' },
          el('span', {}, 'Description'),
          el('span', {}, 'HSN/SAC'),
          el('span', {}, 'Qty'),
          el('span', {}, 'Rate ₹'),
          el('span', {}, 'GST'),
          el('span', {}, ''),
        ),
        rows,
        el(
          'button',
          { class: 'btn sm', type: 'button', style: 'margin-top:8px', onclick: () => addRow() },
          '+ Add a line',
        ),

        el('div', { class: 'grid-2', style: 'margin-top:18px' }, field('Notes', notes), field('Terms', terms)),
        el('h3', { class: 'doc-section' }, 'Total'),
        summary,
      ),
    footer: () => save,
  });

  if (existing?.items?.length) existing.items.forEach((item) => addRow(item));
  else addRow();
  preview();

  save.onclick = submitHandler(save, alertHost, async () => {
    const payload = body();
    if (!payload.customerName) throw new Error('Who is this for?');
    if (!payload.items.length) throw new Error('Add at least one line with a description and a price.');

    const res = existing
      ? await api(`/billing/${existing.id}`, { method: 'PUT', body: payload })
      : await api(`/billing/${kind}`, { method: 'POST', body: payload });

    close();
    toast(`${res.document.number} saved.`, 'ok');
    navigate(`billing/${res.document.id}`);
  });
}
