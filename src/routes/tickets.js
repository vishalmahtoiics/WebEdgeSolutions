// Support tickets.
//
// Both roles use the same endpoints, and the difference is in what each one is
// allowed to see. A customer reaches their own tickets and the messages on
// them that were not marked internal; the Super Admin reaches everything. That
// boundary is enforced in the query on every route, never by what the browser
// chooses to render.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import {
  CATEGORIES, addReply, createTicket, getTicket, listTickets, setStatus,
} from '../services/ticketService.js';

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

/// Opening a ticket sends mail. Not something to let anyone hold down.
const openLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'That is a lot of tickets in one hour. Add to an existing one instead.' },
});

ticketsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await listTickets(req.user, { status: req.query.status });
    res.json({ ...result, categories: CATEGORIES });
  }),
);

const createSchema = z.object({
  subject: z.string().trim().min(3, 'Give it a short subject.').max(200),
  body: z.string().trim().min(5, 'Tell us what is wrong.').max(10000),
  category: z.string().trim().max(40).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  domainId: z.string().trim().max(40).optional(),
});

ticketsRouter.post(
  '/',
  openLimiter,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const ticket = await createTicket({ user: req.user, ...req.body });
    res.status(201).json({ ticket });
  }),
);

ticketsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ticket = await getTicket(req.user, req.params.id);
    if (!ticket) throw notFound('That ticket does not exist.');
    res.json({ ticket });
  }),
);

const replySchema = z.object({
  body: z.string().trim().min(1, 'Write something first.').max(10000),
  isInternal: z.coerce.boolean().optional(),
  status: z.enum(['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_SUPPORT', 'RESOLVED', 'CLOSED']).optional(),
});

ticketsRouter.post(
  '/:id/reply',
  validate(replySchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicket(req.user, req.params.id);
    if (!ticket) throw notFound('That ticket does not exist.');

    if (ticket.status === 'CLOSED' && !isAdmin(req.user)) {
      throw badRequest('This ticket is closed. Open a new one and mention ' + ticket.reference + '.');
    }
    // Only your side sets the status from a reply; a customer replying always
    // means "waiting on support", whatever they send.
    const status = isAdmin(req.user) ? req.body.status : undefined;

    const result = await addReply({
      user: req.user,
      ticket,
      body: req.body.body,
      isInternal: req.body.isInternal,
      status,
    });

    // Re-read through the same gate, so a customer never receives an internal
    // note in the response to their own reply.
    res.status(201).json({ ticket: await getTicket(req.user, ticket.id), message: result.message });
  }),
);

const statusSchema = z.object({
  status: z.enum(['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_SUPPORT', 'RESOLVED', 'CLOSED']),
});

/// Closing is the Super Admin's call. A customer who considers it finished
/// says so in a reply, which is a fact worth keeping rather than a state
/// change that loses it.
ticketsRouter.post(
  '/:id/status',
  requireAdmin,
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!ticket) throw notFound('That ticket does not exist.');

    const updated = await setStatus({ user: req.user, ticket, status: req.body.status });
    res.json({ ticket: updated });
  }),
);
