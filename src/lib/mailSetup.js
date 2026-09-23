// What a customer is told to type into Outlook, which is not always what the
// portal itself connects to.
//
// The portal signs in to the provider's real mail servers — imap.<provider>.com
// and the like. Handing those names to a customer tells them who the hosting
// really comes from, which is the one thing the portal is careful never to do
// anywhere else.
//
// So there are two answers to "what is the mail server", and this decides
// which one a given person gets. It is kept apart from the routes and free of
// any database so the decision can be tested on its own — it is the piece that
// must never, under any combination of settings, hand out a provider hostname
// to someone who should not have it, or hand out a hostname that does not
// answer.

/// How a domain's setup details are chosen.
export const MAIL_SETUP_MODES = ['STANDARD', 'REAL', 'CUSTOM'];

/// Implicit-TLS ports. These are the only two the setup card offers, because
/// they are the two that need no negotiation: the connection is encrypted from
/// the first byte. 143 and 587 work too, but they start in the clear and
/// upgrade, and a client that silently fails to upgrade sends the password in
/// the clear.
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

const clean = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const port = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
};

/// The hostnames and ports to put in front of a customer.
///
/// `settings` is the domain's DomainSettings row; `defaults` is the AppSettings
/// row, or anything with the four public* fields on it.
///
/// Returns `null` when there is nothing to show — no real IMAP host and no
/// standard one — because an incomplete setup card is worse than none: it
/// reads as a real answer and sends somebody off to debug their mail client.
export function resolveMailSetup(settings, defaults = {}) {
  const real = {
    imapHost: clean(settings?.imapHost),
    imapPort: port(settings?.imapPort, DEFAULT_IMAP_PORT),
    smtpHost: clean(settings?.smtpHost),
    smtpPort: port(settings?.smtpPort, DEFAULT_SMTP_PORT),
  };

  const standard = {
    imapHost: clean(defaults?.publicImapHost),
    imapPort: port(defaults?.publicImapPort, DEFAULT_IMAP_PORT),
    smtpHost: clean(defaults?.publicSmtpHost),
    smtpPort: port(defaults?.publicSmtpPort, DEFAULT_SMTP_PORT),
  };

  const custom = {
    imapHost: clean(settings?.publicImapHost),
    imapPort: port(settings?.publicImapPort, DEFAULT_IMAP_PORT),
    smtpHost: clean(settings?.publicSmtpHost),
    smtpPort: port(settings?.publicSmtpPort, DEFAULT_SMTP_PORT),
  };

  const mode = MAIL_SETUP_MODES.includes(settings?.mailSetupMode)
    ? settings.mailSetupMode
    : 'STANDARD';

  // Each mode names its first choice and what it falls back to.
  //
  // `explicit` is the important part. Handing out the provider's own hostname
  // is a legitimate choice and sometimes the only one that works — but there
  // is a world of difference between somebody choosing it and it happening
  // because nothing else was configured. The first is a decision; the second
  // is the portal quietly breaking its own rule on a fresh installation. So
  // both are reported, and the caller decides who may see which.
  let chosen;
  let source;
  let explicit;

  if (mode === 'REAL') {
    chosen = real;
    source = 'real';
    explicit = true;
  } else if (mode === 'CUSTOM' && custom.imapHost) {
    chosen = custom;
    source = 'custom';
    explicit = true;
  } else if (mode === 'CUSTOM') {
    // Set to custom and then left blank. Fall back the same way STANDARD
    // does, but this was not chosen, so say so.
    chosen = standard.imapHost ? standard : real;
    source = standard.imapHost ? 'standard' : 'real';
    explicit = false;
  } else if (standard.imapHost) {
    chosen = standard;
    source = 'standard';
    explicit = true;
  } else {
    chosen = real;
    source = 'real';
    explicit = false;
  }

  if (!chosen.imapHost) return null;

  // Outgoing is allowed to be missing while incoming is not: a mailbox that
  // can only receive is a real configuration, and saying "no outgoing server"
  // is better than inventing one.
  return {
    source,
    explicit,
    imap: { host: chosen.imapHost, port: chosen.imapPort, secure: true },
    smtp: chosen.smtpHost ? { host: chosen.smtpHost, port: chosen.smtpPort, secure: true } : null,
  };
}

/// Whether a resolved setup would give away the provider.
export const revealsProvider = (resolved) => resolved?.source === 'real';

/// Whether this may be put in front of a customer.
///
/// Everything may, except a provider hostname nobody chose to hand out. That
/// case is a portal where the standard names were never configured, and the
/// right answer there is to tell the customer to ask their administrator —
/// not to quietly show them who the hosting really comes from. An
/// administrator who genuinely wants the real name handed out says so per
/// domain, and then it is shown.
export const mayShowToCustomer = (resolved) =>
  Boolean(resolved) && (resolved.source !== 'real' || resolved.explicit);
