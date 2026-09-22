// Support tickets.
//
// The thing that makes a ticket system worth having over WhatsApp is that the
// conversation has a place to live: a month later you can see what was asked,
// what was answered, and when. So the thread is the product, and the email
// alert is a way of hearing that the thread moved.
//
// The alert goes through the ordinary notifier, which means it is written to
// the activity log first and sent afterwards, in the background. A ticket is
// never lost because a mail server was down — the customer's message is saved
// before anything is sent, and it is visible in the portal either way.

import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { record } from './notifier.js';
import { sendDirect } from './mailer.js';
import { getStoreSettings } from './storeService.js';

/// Read out over the phone, so both halves of every confusable pair are gone.
const ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ';

const reference = () =>
  `TKT-${[...crypto.randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;

export const CATEGORIES = ['Technical', 'Billing', 'Email', 'Domain', 'Other'];

/// What a customer is allowed to see of a thread.
///
/// Internal notes are excluded by the query, not hidden by the interface. A
/// note that is only invisible in the browser is one API call away from being
/// read by the person it was written about.
const customerMessages = { where: { isInternal: false }, orderBy: { createdAt: 'asc' } };
const allMessages = { orderBy: { createdAt: 'asc' } };

export const messagesFor = (user) =>
  user.role === 'SUPER_ADMIN' ? allMessages : customerMessages;

/// One ticket, if this person may see it.
///
/// A customer may only reach their own, so changing the id in the URL gets a
/// 404 rather than somebody else's conversation.
export async function getTicket(user, id) {
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      messages: messagesFor(user),
      user: { select: { id: true, name: true, email: true } },
      domain: { select: { id: true, name: true } },
    },
  });
  if (!ticket) return null;
  if (user.role !== 'SUPER_ADMIN' && ticket.userId !== user.id) return null;
  return ticket;
}

// ---------------------------------------------------------------------------
// Opening and replying
// ---------------------------------------------------------------------------

export async function createTicket({ user, subject, body, category, priority, domainId }) {
  // A customer may only raise a ticket against a domain that is theirs.
  // Otherwise the domain field becomes a way to find out which domains exist.
  if (domainId && user.role !== 'SUPER_ADMIN') {
    const assigned = await prisma.userDomain.findUnique({
      where: { userId_domainId: { userId: user.id, domainId } },
      select: { id: true },
    });
    if (!assigned) throw new HttpError(400, 'That domain is not one of yours.');
  }

  const ticket = await prisma.ticket.create({
    data: {
      reference: reference(),
      subject,
      category: category || null,
      priority: priority || 'NORMAL',
      userId: user.id,
      domainId: domainId || null,
      status: 'OPEN',
      lastReplyAt: new Date(),
      lastReplyByRole: user.role,
      messages: {
        create: {
          authorId: user.id,
          authorLabel: `${user.name} <${user.email}>`,
          authorRole: user.role,
          body,
        },
      },
    },
    include: { messages: allMessages, domain: { select: { id: true, name: true } } },
  });

  // Saved first, told second. The customer's problem is recorded whether or
  // not the mail server is having a good day.
  await record({
    event: 'support.ticket.created',
    actor: user,
    summary: `New support ticket: ${subject}`,
    detail:
      `Reference: ${ticket.reference}\n` +
      `Priority:  ${ticket.priority}\n` +
      (ticket.category ? `Category:  ${ticket.category}\n` : '') +
      (ticket.domain ? `Domain:    ${ticket.domain.name}\n` : '') +
      `\n${body}`,
    domain: ticket.domain || undefined,
  });

  // An acknowledgement, so the customer knows it arrived and has a reference
  // to quote. Failing to send one must not fail the ticket.
  acknowledge(ticket, user).catch((err) =>
    console.error('ticket acknowledgement failed:', err?.message),
  );

  return ticket;
}

async function acknowledge(ticket, user) {
  const store = await getStoreSettings();
  await sendDirect({
    to: user.email,
    subject: `We have your request — ${ticket.reference}`,
    text:
      `Hello ${user.name},\n\n` +
      `We have received your message and it is on our list. Quote ${ticket.reference} if you need to follow up.\n\n` +
      `Subject: ${ticket.subject}\n\n` +
      'You can see the whole conversation, and reply to it, by signing in to the portal and opening Support.\n' +
      (store.supportEmail ? `\nOr reply to this message and it will reach ${store.supportEmail}.\n` : ''),
    replyTo: store.supportEmail || undefined,
  });
}

export async function addReply({ user, ticket, body, isInternal = false, status }) {
  // Only your side of the desk has internal notes.
  const internal = Boolean(isInternal) && user.role === 'SUPER_ADMIN';

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      authorId: user.id,
      authorLabel: `${user.name} <${user.email}>`,
      authorRole: user.role,
      body,
      isInternal: internal,
    },
  });

  // An internal note is not a reply: it must not tell the customer their
  // ticket moved, and it must not change who is waiting on whom.
  const data = internal
    ? {}
    : {
        lastReplyAt: new Date(),
        lastReplyByRole: user.role,
        status:
          status ||
          (user.role === 'SUPER_ADMIN' ? 'AWAITING_CUSTOMER' : 'AWAITING_SUPPORT'),
      };

  if (status === 'RESOLVED' || status === 'CLOSED') data.closedAt = new Date();
  if (status && status !== 'RESOLVED' && status !== 'CLOSED') data.closedAt = null;

  const updated = Object.keys(data).length
    ? await prisma.ticket.update({
        where: { id: ticket.id },
        data,
        include: { messages: allMessages, user: { select: { id: true, name: true, email: true } }, domain: { select: { id: true, name: true } } },
      })
    : await prisma.ticket.findUnique({
        where: { id: ticket.id },
        include: { messages: allMessages, user: { select: { id: true, name: true, email: true } }, domain: { select: { id: true, name: true } } },
      });

  if (!internal) {
    if (user.role === 'SUPER_ADMIN') {
      // The customer hears from you directly, not through the alert list.
      notifyCustomer(updated, body).catch((err) =>
        console.error('ticket reply email failed:', err?.message),
      );
    } else {
      await record({
        event: 'support.ticket.replied',
        actor: user,
        summary: `Reply on ${ticket.reference}: ${ticket.subject}`,
        detail: body,
        domain: updated.domain || undefined,
      });
    }
  }

  return { message, ticket: updated };
}

async function notifyCustomer(ticket, body) {
  if (!ticket.user?.email) return;
  const store = await getStoreSettings();
  await sendDirect({
    to: ticket.user.email,
    subject: `Re: ${ticket.subject} — ${ticket.reference}`,
    text:
      `${body}\n\n` +
      '—\n' +
      `Ticket ${ticket.reference}. Sign in to the portal and open Support to reply.\n`,
    replyTo: store.supportEmail || undefined,
  });
}

export async function setStatus({ user, ticket, status }) {
  const closing = status === 'RESOLVED' || status === 'CLOSED';
  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status, closedAt: closing ? new Date() : null },
    include: { messages: allMessages, user: { select: { id: true, name: true, email: true } }, domain: { select: { id: true, name: true } } },
  });

  if (closing) {
    await record({
      event: 'support.ticket.closed',
      actor: user,
      summary: `Ticket ${ticket.reference} marked ${status.toLowerCase()}`,
      detail: ticket.subject,
      domain: updated.domain || undefined,
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// Tickets this person may see, newest movement first.
///
/// Sorted by the last reply rather than by when it was opened: what matters
/// on a support list is what moved, not what is old.
export async function listTickets(user, { status, take = 50 } = {}) {
  const where = user.role === 'SUPER_ADMIN' ? {} : { userId: user.id };
  if (status === 'open') {
    where.status = { in: ['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_SUPPORT'] };
  } else if (status) {
    where.status = status;
  }

  const [tickets, counts] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { lastReplyAt: 'desc' },
      take,
      include: {
        user: { select: { id: true, name: true, email: true } },
        domain: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.ticket.groupBy({
      by: ['status'],
      where: user.role === 'SUPER_ADMIN' ? {} : { userId: user.id },
      _count: true,
    }),
  ]);

  return {
    tickets,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    /// How many are sitting with you. This is the number that should be on a
    /// badge: it is the only one that is a to-do list.
    waitingOnSupport: tickets.filter(
      (t) => t.lastReplyByRole === 'USER' && !['RESOLVED', 'CLOSED'].includes(t.status),
    ).length,
  };
}
