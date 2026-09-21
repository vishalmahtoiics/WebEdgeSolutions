// Detecting and recording what a domain's site is built on.
//
// This sits between the detector, which knows how to look, and the database,
// which remembers what was found. It exists mainly to enforce one rule: a
// detection writes only the detected columns. An administrator's override is
// never touched by it, so re-running detection can correct itself without
// undoing somebody's decision.

import { prisma } from '../db.js';
import { decryptMaybe } from '../lib/crypto.js';
import { detectTechnology } from '../lib/technology.js';

/// Detects and stores the technology for one domain.
///
/// Returns `{ ok, technology, attempts }`. It never throws: this runs inside
/// Sync Everything and inside Refresh, and neither should fail because a site
/// was down or an FTP password had gone stale.
export async function detectAndStore(domain, { allowPrivate = false } = {}) {
  const settings =
    domain.settings ?? (await prisma.domainSettings.findUnique({ where: { domainId: domain.id } }));

  const ftpSettings = settings?.ftpHost
    ? {
        host: settings.ftpHost,
        port: settings.ftpPort,
        username: settings.ftpUsername,
        // Decrypted here and passed straight to the connection; it is never
        // returned, logged, or written to the detection result.
        password: decryptMaybe(settings.ftpPassword),
        protocol: settings.ftpProtocol,
      }
    : null;

  let found;
  try {
    found = await detectTechnology({
      domainName: domain.name,
      ftpSettings,
      rootPath: settings?.ftpRootPath || '/',
      allowPrivate,
    });
  } catch (err) {
    return { ok: false, technology: null, attempts: [{ source: 'detect', message: err?.message || 'Detection failed.' }] };
  }

  const { result, attempts } = found;

  if (!result) {
    // Nothing found. The previous answer is left alone rather than blanked: one
    // site being unreachable today is no reason to forget what it was
    // yesterday. Only the timestamp moves, so the UI can say when it last looked.
    await prisma.domain.update({
      where: { id: domain.id },
      data: { detectedTechAt: new Date() },
    });
    return { ok: false, technology: null, attempts };
  }

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      detectedTech: result.name,
      detectedTechVersion: result.version,
      detectedTechSource: result.source,
      detectedTechEvidence: result.evidence,
      detectedTechLevel: result.confidence,
      detectedTechAt: new Date(),
    },
  });

  return { ok: true, technology: result, attempts, domain: updated };
}
