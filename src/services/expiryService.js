// Telling somebody before a domain lapses.
//
// A domain that expires without warning is the worst failure this portal can
// have: the site goes dark, the email stops, and past the grace period the
// name can be bought by somebody else. Everything here is built around making
// that impossible to miss, and around not becoming noise in the process.
//
// The rule that does most of the work is in the database rather than here: a
// reminder row is keyed on (domain, days before, expiry date). That single
// constraint gives three things at once —
//
//   the same warning is never sent twice, even if the job runs twice;
//   renewing a domain moves the expiry date, so the whole ladder of warnings
//   becomes due again for the new date, with no code to reset anything;
//   and a domain whose expiry the provider corrects gets warned about the
//   corrected date rather than staying quiet because the old one was handled.

import { prisma } from '../db.js';
import { getAppSettings, record } from './notifier.js';
import { sendDirect } from './mailer.js';

/// A date with no time, in UTC, so "days between" is a whole number and a
/// clock ticking past midnight cannot make yesterday's reminder due again.
const asDay = (value) => {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const daysUntil = (expiresAt, now = new Date()) =>
  Math.round((asDay(expiresAt) - asDay(now)) / DAY_MS);

/// The ladder, as the settings hold it: "30,15,7,1".
///
/// Sorted descending and de-duplicated, so a list typed in any order warns
/// furthest-out first and a doubled entry does not send two emails.
export function parseLadder(text) {
  const days = String(text ?? '')
    .split(/[,;\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  return [...new Set(days)].sort((a, b) => b - a);
}

/// Which rung a domain has reached.
///
/// The *smallest* rung still at or above the days remaining — the most recent
/// mark the domain has passed. With a ladder of 30/15/7/1 and nine days left,
/// that is the 15-day rung: it has gone past 30 and 15, and has not yet
/// reached 7.
///
/// Taking the largest instead would warn about a domain with nine days left
/// as though it had thirty, and would keep doing so as it fell to one — the
/// same warning every night, saying nothing new. Taking the smallest means
/// each rung fires exactly once, and every fire is a genuine escalation.
///
/// A domain first seen at nine days therefore still gets a warning, rather
/// than being silent until its last day because the 30 and 15 marks passed
/// before the portal ever saw it.
export const rungFor = (daysLeft, ladder) =>
  ladder.findLast((rung) => daysLeft <= rung) ?? null;

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/// Warns about everything approaching expiry, and about anything already past
/// it.
///
/// Returns a summary rather than throwing on a single failure: one domain with
/// a bad address must not stop the rest being warned about.
export async function runExpiryReminders() {
  const settings = await getAppSettings();
  const ladder = parseLadder(settings.expiryReminderDays);

  if (!ladder.length) {
    return { summary: 'No reminder days are configured.', notable: false };
  }

  const horizon = new Date(Date.now() + (Math.max(...ladder) + 1) * DAY_MS);

  const domains = await prisma.domain.findMany({
    where: { expiresAt: { not: null, lte: horizon } },
    include: {
      // Who to tell, when telling the customer is switched on.
      assignments: { include: { user: { select: { email: true, name: true, isActive: true } } } },
    },
    orderBy: { expiresAt: 'asc' },
  });

  const sent = [];
  const failed = [];

  for (const domain of domains) {
    const daysLeft = daysUntil(domain.expiresAt);
    // Past the point of a reminder. A domain months gone is history, not news,
    // and warning about it every night forever is how an inbox gets muted.
    if (daysLeft < -30) continue;

    const rung = daysLeft < 0 ? -1 : rungFor(daysLeft, ladder);
    if (rung === null) continue;

    const expiresOn = asDay(domain.expiresAt);

    // The claim. Unique on (domain, rung, date), so whoever writes the row
    // first is the one who sends the email — including two containers racing.
    let claim;
    try {
      claim = await prisma.expiryReminder.create({
        data: { domainId: domain.id, daysBefore: rung, expiresOn },
      });
    } catch (err) {
      // P2002 is the unique constraint: this warning has already gone out.
      if (err?.code === 'P2002') continue;
      throw err;
    }

    const to = [];
    if (settings.expiryRemindCustomer) {
      for (const assignment of domain.assignments) {
        if (assignment.user?.isActive && assignment.user.email) to.push(assignment.user.email);
      }
    }

    const message = compose(domain, daysLeft);

    // The admin hears about it through the ordinary alert path, so it lands
    // with every other alert and obeys the same switches.
    await record({
      event: 'schedule.domain-expiry.due',
      summary: message.subject,
      detail: message.text,
      domain: { id: domain.id, name: domain.name },
    });

    let delivered = false;
    if (to.length) {
      try {
        await sendDirect({ to, subject: message.subject, text: message.customerText });
        delivered = true;
      } catch (err) {
        failed.push(`${domain.name}: ${err?.message || 'could not email the customer'}`);
      }
    }

    await prisma.expiryReminder
      .update({
        where: { id: claim.id },
        data: { delivered: delivered || !to.length, sentTo: to.join(', ') || null },
      })
      .catch(() => null);

    sent.push({ domain: domain.name, daysLeft, rung, toCustomer: to.length });
  }

  const expired = sent.filter((s) => s.daysLeft < 0).length;
  const summary = sent.length
    ? `${sent.length} reminder${sent.length === 1 ? '' : 's'} sent` +
      (expired ? `, ${expired} already expired` : '')
    : 'Nothing expiring soon.';

  return {
    summary,
    // A night with nothing expiring is not news. A night with something is.
    notable: sent.length > 0 || failed.length > 0,
    detail: [
      sent.length
        ? sent.map((s) => `${s.domain}: ${s.daysLeft < 0 ? `expired ${-s.daysLeft} days ago` : `${s.daysLeft} days left`}`).join('\n')
        : null,
      failed.length ? `Could not email the customer for:\n${failed.join('\n')}` : null,
    ]
      .filter(Boolean)
      .join('\n\n') || null,
    sent,
    failed,
  };
}

/// What the warning says.
///
/// Two versions, because the two readers need different things: you need to
/// know which domain and how long you have, and the customer needs to know
/// what happens if nothing is done and who to talk to.
function compose(domain, daysLeft) {
  const when =
    daysLeft < 0
      ? `expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`
      : daysLeft === 0
        ? 'expires today'
        : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

  const date = new Date(domain.expiresAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return {
    subject: `${domain.name} ${when}`,
    text:
      `${domain.name} ${when} — ${date}.\n\n` +
      (daysLeft < 0
        ? 'It is past its expiry date. Depending on the registrar there is usually a grace period, ' +
          'after which the name can be registered by somebody else.\n'
        : 'Renew it with the registrar before then to avoid the site and its email going down.\n'),
    customerText:
      `Your domain ${domain.name} ${when} — ${date}.\n\n` +
      (daysLeft < 0
        ? 'It has passed its expiry date. Your website and email for this domain may already be down. ' +
          'Please get in touch as soon as possible so we can try to recover it.\n'
        : 'If it is not renewed before then, the website and any email addresses on it will stop working. ' +
          'Reply to this message and we will take care of the renewal.\n'),
  };
}
