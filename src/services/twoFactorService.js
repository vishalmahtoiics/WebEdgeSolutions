// Two-factor sign-in.
//
// The Super Admin account on this portal holds the keys to every DNS zone,
// every database, every mailbox and every FTP account it manages. One password
// is not a proportionate defence for that, and a password is the one secret
// that gets reused, phished and typed into the wrong box.
//
// Three decisions are worth stating, because each is a place this is commonly
// got wrong:
//
//   A secret that has not been proven is not enrolment. The secret is held in
//   the sign-in session while the person sets it up, and only written to the
//   account once they have produced a working code from it. Somebody who
//   scans a QR badly, or photographs it and closes the tab, is not left with
//   an account they cannot get into.
//
//   Recovery codes are the whole point of recovery codes. A phone is lost,
//   wiped, or replaced, and without a second way in the account is gone —
//   there is no "email support" here, because you are support.
//
//   A code that has been used is spent. A six-digit code is valid for its
//   whole thirty-second window, so without remembering the last step
//   accepted, anyone who saw it over a shoulder could use it again.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { prisma } from '../db.js';
import { encrypt, decryptMaybe } from '../lib/crypto.js';
import {
  generateSecret,
  otpauthUrl,
  verify as verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  recoveryHint,
  normaliseRecoveryCode,
} from '../lib/totp.js';

/// How long somebody has to produce a code after their password was accepted.
/// Long enough to find a phone and unlock it; short enough that a pending
/// session left on a shared machine is not a way in.
export const PENDING_TTL_MS = 5 * 60 * 1000;

export const isEnrolled = (user) => Boolean(user?.totpEnabledAt && user?.totpSecret);

/// Starts enrolment: a fresh secret and the QR code for it.
///
/// Nothing is written to the account here. The caller holds the secret in the
/// session until a working code proves the authenticator has it too.
export async function beginEnrolment({ email, issuer = 'Hosting Portal' }) {
  const secret = generateSecret();
  const url = otpauthUrl({ secret, account: email, issuer });

  return {
    secret,
    otpauthUrl: url,
    // A data URL, which the page's Content-Security-Policy already allows for
    // images. Nothing is fetched from anywhere: the QR is drawn here, so the
    // shared secret never travels to a third-party chart service — which is
    // exactly how this gets leaked in other systems.
    qr: await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' }),
    // For somebody whose authenticator cannot scan, shown in readable groups.
    manualKey: secret.replace(/(.{4})/g, '$1 ').trim(),
  };
}

/// Completes enrolment, once a code from the new secret checks out.
///
/// Returns the recovery codes. They are shown once, here, and never again:
/// only their hashes are kept, so a later "show me my codes" is a question
/// this system genuinely cannot answer.
export async function completeEnrolment({ userId, secret, code }) {
  const step = verifyTotp(secret, code);
  if (step === null) {
    throw new Error('That code is not right. Check your authenticator app and try the current code.');
  }

  const codes = generateRecoveryCodes();

  await prisma.$transaction([
    // Any codes from a previous enrolment are dead the moment a new secret is
    // in place, so they go with it.
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: encrypt(secret),
        totpEnabledAt: new Date(),
        totpLastStep: BigInt(step),
      },
    }),
    prisma.recoveryCode.createMany({
      data: codes.map((value) => ({ userId, codeHash: hashRecoveryCode(value), hint: recoveryHint(value) })),
    }),
  ]);

  return { codes };
}

/// Checks a code at sign-in. Accepts either six digits or a recovery code.
///
/// One entry box for both is deliberate: somebody who has lost their phone is
/// already having a bad day, and making them find the right form first is a
/// cruelty with no security benefit.
export async function verifySecondFactor({ userId, code }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!isEnrolled(user)) return { ok: false, reason: 'Two-factor authentication is not set up on this account.' };

  const entered = String(code || '').trim();

  if (/^\d{6}$/.test(entered.replace(/\s/g, ''))) {
    const step = verifyTotp(decryptMaybe(user.totpSecret), entered, {
      afterStep: user.totpLastStep === null ? null : Number(user.totpLastStep),
    });
    if (step === null) {
      return { ok: false, reason: 'That code is not right, or it has already been used. Wait for the next one.' };
    }
    // Spend the step, so the same six digits cannot be used again inside
    // their window.
    await prisma.user.update({ where: { id: userId }, data: { totpLastStep: BigInt(step) } });
    return { ok: true, method: 'totp' };
  }

  return useRecoveryCode({ userId, code: entered });
}

/// Spends a recovery code, if it matches an unused one.
///
/// Compared in constant time against each unused hash. Without that, the time
/// taken would say how many codes are left and how far down the list a near
/// miss fell.
async function useRecoveryCode({ userId, code }) {
  const normalised = normaliseRecoveryCode(code);
  if (normalised.length < 8) {
    return { ok: false, reason: 'Enter the 6-digit code from your app, or one of your recovery codes.' };
  }

  const wanted = Buffer.from(hashRecoveryCode(normalised), 'hex');
  const unused = await prisma.recoveryCode.findMany({ where: { userId, usedAt: null } });

  let matched = null;
  for (const candidate of unused) {
    const stored = Buffer.from(candidate.codeHash, 'hex');
    if (stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted)) matched = candidate;
  }

  if (!matched) return { ok: false, reason: 'That code is not right, or it has already been used.' };

  // Marked used rather than deleted, so the list can still say ten were
  // issued and how many are gone.
  await prisma.recoveryCode.update({ where: { id: matched.id }, data: { usedAt: new Date() } });

  const left = await prisma.recoveryCode.count({ where: { userId, usedAt: null } });
  return { ok: true, method: 'recovery', codesLeft: left };
}

/// Turns it off and destroys everything behind it.
export async function disable(userId) {
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    }),
  ]);
}

/// A fresh set, invalidating the old one. For somebody who has used most of
/// theirs, or thinks a printed copy has been seen.
export async function regenerateRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: codes.map((value) => ({ userId, codeHash: hashRecoveryCode(value), hint: recoveryHint(value) })),
    }),
  ]);
  return codes;
}

/// What the profile page may know: whether it is on, since when, and how many
/// recovery codes are left. Never the secret, and never a code.
export async function status(userId) {
  const [user, total, unused] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true, totpSecret: true } }),
    prisma.recoveryCode.count({ where: { userId } }),
    prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
  ]);

  return {
    enabled: isEnrolled(user),
    enabledAt: user?.totpEnabledAt ?? null,
    recoveryCodesTotal: total,
    recoveryCodesLeft: unused,
  };
}
