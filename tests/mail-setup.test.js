// Which mail server names a customer is given.
//
// The thing being protected here is the white-label boundary: the portal
// signs in to the provider's real servers, and a customer must not be handed
// those names by accident. The other half is just as important — whatever is
// handed out has to be a name that actually answers, because a setup card
// that reads as an answer but is not one sends somebody off to debug a mail
// client that was never going to work.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMailSetup,
  revealsProvider,
  mayShowToCustomer,
  MAIL_SETUP_MODES,
} from '../src/lib/mailSetup.js';

const REAL = {
  imapHost: 'imap.provider-name.com',
  imapPort: 993,
  smtpHost: 'smtp.provider-name.com',
  smtpPort: 465,
};

const STANDARD = {
  publicImapHost: 'imap.example-brand.in',
  publicImapPort: 993,
  publicSmtpHost: 'smtp.example-brand.in',
  publicSmtpPort: 465,
};

test('with nothing configured portal-wide, the real servers are resolved but not for customers', () => {
  // The state every installation is in before anybody configures anything.
  // The administrator needs to see what the portal connects to; the customer
  // must not be shown the provider's name because nobody got round to
  // setting an alternative.
  const setup = resolveMailSetup({ ...REAL }, {});
  assert.equal(setup.source, 'real');
  assert.equal(setup.explicit, false, 'nobody chose this');
  assert.equal(setup.imap.host, 'imap.provider-name.com');
  assert.equal(setup.smtp.host, 'smtp.provider-name.com');
  assert.equal(revealsProvider(setup), true);
  assert.equal(mayShowToCustomer(setup), false, 'so it is withheld rather than shown');
});

test('a provider hostname somebody chose to hand out is shown', () => {
  // The escape hatch, for a domain the standard names cannot serve. It is a
  // decision, so it is honoured.
  const setup = resolveMailSetup({ ...REAL, mailSetupMode: 'REAL' }, {});
  assert.equal(setup.source, 'real');
  assert.equal(setup.explicit, true);
  assert.equal(mayShowToCustomer(setup), true);
});

test('nothing at all is never shown to a customer', () => {
  assert.equal(mayShowToCustomer(null), false);
  assert.equal(mayShowToCustomer(undefined), false);
});

test('a portal-wide pair replaces the provider name everywhere', () => {
  const setup = resolveMailSetup({ ...REAL }, STANDARD);
  assert.equal(setup.source, 'standard');
  assert.equal(setup.explicit, true);
  assert.equal(setup.imap.host, 'imap.example-brand.in');
  assert.equal(setup.smtp.host, 'smtp.example-brand.in');
  assert.equal(revealsProvider(setup), false);
  assert.equal(mayShowToCustomer(setup), true);

  // The provider's names must not survive anywhere in the answer.
  assert.ok(!JSON.stringify(setup).includes('provider-name'));
});

test('one domain can be told to hand out the real servers anyway', () => {
  // For a domain the standard hostnames cannot serve. Explicit, per domain,
  // and it overrides the portal-wide setting rather than being overridden.
  const setup = resolveMailSetup({ ...REAL, mailSetupMode: 'REAL' }, STANDARD);
  assert.equal(setup.source, 'real');
  assert.equal(setup.imap.host, 'imap.provider-name.com');
});

test('one domain can have hostnames of its own', () => {
  const setup = resolveMailSetup(
    {
      ...REAL,
      mailSetupMode: 'CUSTOM',
      publicImapHost: 'mail.just-this-client.com',
      publicImapPort: 9993,
      publicSmtpHost: 'mail.just-this-client.com',
      publicSmtpPort: 9465,
    },
    STANDARD,
  );
  assert.equal(setup.source, 'custom');
  assert.equal(setup.imap.host, 'mail.just-this-client.com');
  assert.equal(setup.imap.port, 9993, 'a proxy on an unusual port is a real setup');
  assert.equal(setup.smtp.port, 9465);
});

test('custom chosen but left blank falls back rather than showing nothing', () => {
  const setup = resolveMailSetup({ ...REAL, mailSetupMode: 'CUSTOM' }, STANDARD);
  assert.equal(setup.source, 'standard', 'the portal-wide pair is the next best answer');
  assert.equal(setup.imap.host, 'imap.example-brand.in');
  // It still gives away nothing, so the customer may have it.
  assert.equal(mayShowToCustomer(setup), true);
});

test('custom blank with no portal-wide pair is a misconfiguration, not a reveal', () => {
  // Set to custom, left blank, and nothing portal-wide either. The
  // administrator is shown the real hostname so they can see what is there;
  // the customer is shown nothing, because this was a mistake rather than a
  // decision.
  const setup = resolveMailSetup({ ...REAL, mailSetupMode: 'CUSTOM' }, {});
  assert.equal(setup.source, 'real');
  assert.equal(setup.explicit, false);
  assert.equal(mayShowToCustomer(setup), false);
});

test('a domain with no mail server at all has no setup to show', () => {
  assert.equal(resolveMailSetup({}, {}), null);
  assert.equal(resolveMailSetup(null, null), null);
  assert.equal(resolveMailSetup({ imapHost: '   ' }, {}), null, 'whitespace is not a hostname');
});

test('a standard pair is enough on its own, without a real one behind it', () => {
  // A domain whose real servers were never filled in can still be handed the
  // portal-wide pair: those are what the customer types either way.
  const setup = resolveMailSetup({}, STANDARD);
  assert.equal(setup.source, 'standard');
  assert.equal(setup.imap.host, 'imap.example-brand.in');
});

test('incoming may exist without outgoing, and says so', () => {
  const setup = resolveMailSetup({ imapHost: 'imap.provider-name.com' }, {});
  assert.equal(setup.imap.host, 'imap.provider-name.com');
  assert.equal(setup.smtp, null, 'inventing an outgoing server would be worse than admitting there is none');
});

test('ports default to the two that are encrypted from the first byte', () => {
  const setup = resolveMailSetup({ imapHost: 'a.test', smtpHost: 'b.test' }, {});
  assert.equal(setup.imap.port, 993);
  assert.equal(setup.smtp.port, 465);
  assert.equal(setup.imap.secure, true);
  assert.equal(setup.smtp.secure, true);
});

test('a nonsense port is replaced rather than passed through', () => {
  for (const junk of [0, -1, 70000, 'abc', 1.5, null]) {
    const setup = resolveMailSetup({ imapHost: 'a.test', imapPort: junk }, {});
    assert.equal(setup.imap.port, 993, `port ${junk} should not reach a customer`);
  }
});

test('an unknown mode is treated as the standard one, not obeyed', () => {
  // A typo in the database must not become "show them the provider".
  const setup = resolveMailSetup({ ...REAL, mailSetupMode: 'WHATEVER' }, STANDARD);
  assert.equal(setup.source, 'standard');
  assert.deepEqual(MAIL_SETUP_MODES, ['STANDARD', 'REAL', 'CUSTOM']);
});

test('every mode returns something a customer may be shown, once configured', () => {
  for (const mode of MAIL_SETUP_MODES) {
    const setup = resolveMailSetup(
      { ...REAL, mailSetupMode: mode, publicImapHost: 'c.test', publicSmtpHost: 'c.test' },
      STANDARD,
    );
    assert.ok(setup?.imap?.host, `${mode} must produce an incoming server`);
    assert.ok(setup?.smtp?.host, `${mode} must produce an outgoing server`);
    assert.equal(mayShowToCustomer(setup), true, `${mode} was configured, so it must be usable`);
  }
});

test('the provider name never reaches a customer by accident', () => {
  // Every shape of settings that can arise, checked the one way that matters:
  // if a customer may see it, the provider's hostname is not in it.
  const shapes = [
    {},
    { ...REAL },
    { ...REAL, mailSetupMode: 'STANDARD' },
    { ...REAL, mailSetupMode: 'CUSTOM' },
    { ...REAL, mailSetupMode: 'CUSTOM', publicImapHost: 'ok.test' },
    { ...REAL, mailSetupMode: 'NONSENSE' },
    { imapHost: 'imap.provider-name.com' },
  ];

  for (const defaults of [{}, STANDARD]) {
    for (const settings of shapes) {
      const setup = resolveMailSetup(settings, defaults);
      if (!mayShowToCustomer(setup)) continue;
      assert.ok(
        !JSON.stringify(setup).includes('provider-name'),
        `${JSON.stringify(settings)} with ${JSON.stringify(defaults)} leaked the provider`,
      );
    }
  }
});
