// Changing DNS records, at the provider where that is possible.
//
// A domain's zone can live in one of two places, and a record belongs to one
// of them:
//
//   live    The provider holds the zone and will accept changes. Editing here
//           changes what the internet resolves, within the record's TTL.
//   local   Either the domain is not linked to a provider, or the record was
//           typed in by hand. Changing it changes what this portal shows and
//           nothing else.
//
// Which one applies is decided here rather than in the browser, and reported
// back on every call so the page can say plainly which just happened. A person
// editing an MX record deserves to know whether they have just redirected real
// mail or only updated a note.

import { prisma } from '../db.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { ZoneError } from '../lib/dnsZone.js';
import { loadProviderWithToken } from './providerService.js';

/// The provider connection for a domain whose zone can actually be written,
/// or null when changes can only be local.
async function liveZone(domain) {
  if (!domain.providerId) return null;

  let connection;
  try {
    connection = await loadProviderWithToken(domain.providerId);
  } catch {
    // No usable token: fall back to local rather than failing the edit. The
    // provider area is where a broken connection gets reported.
    return null;
  }

  const { adapter, token } = connection;
  if (!adapter?.capabilities?.dnsWrite) return null;
  if (typeof adapter.createDnsRecord !== 'function') return null;
  return { adapter, token };
}

/// Turns a zone failure into an HTTP error that keeps its explanation. These
/// messages say what was refused and why, which is the whole point of them.
function asHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof ZoneError) return new HttpError(err.status === 502 ? 502 : err.status, err.message);
  return badRequest(err?.message || 'The provider rejected that DNS change.');
}

/// Replaces this domain's provider records with the zone as it now stands.
///
/// Hand-entered records are left alone: they were never part of the zone, so a
/// zone read has nothing to say about them.
async function storeZone(domainId, records) {
  await prisma.$transaction([
    prisma.dnsRecord.deleteMany({ where: { domainId, isFromProvider: true } }),
    prisma.dnsRecord.createMany({
      data: records.map((r) => ({
        domainId,
        name: r.name || '@',
        type: r.type || 'A',
        content: r.content || '',
        ttl: r.ttl || 3600,
        isFromProvider: true,
      })),
    }),
  ]);
}

/// How many records this portal already believes are in the live zone.
///
/// Passed into every write so a zone read that comes back unexpectedly empty
/// is treated as a failed read, not as a zone to overwrite.
const liveRecordCount = (domainId) =>
  prisma.dnsRecord.count({ where: { domainId, isFromProvider: true } });

const describe = (r) => `${r.type} ${r.name}`;

/// Notes the side effect Hostinger's model imposes: TTL belongs to the
/// (name, type) group, so changing it moves the records alongside.
const ttlNote = (count) =>
  count ? ` The TTL now applies to ${count} other record${count === 1 ? '' : 's'} at the same name and type.` : '';

// ---------------------------------------------------------------------------

export async function createRecord(domain, input) {
  const live = await liveZone(domain);

  if (!live) {
    const record = await prisma.dnsRecord.create({
      data: { domainId: domain.id, ...input, isFromProvider: false },
    });
    return {
      record,
      live: false,
      message: domain.providerId
        ? 'Record saved in the portal. It was not added to the live zone.'
        : 'Record saved.',
    };
  }

  let result;
  try {
    result = await live.adapter.createDnsRecord(live.token, domain.name, input, {
      minimumBefore: await liveRecordCount(domain.id),
    });
  } catch (err) {
    throw asHttpError(err);
  }

  await storeZone(domain.id, result.records);
  return {
    live: true,
    message: `Added ${describe(input)} to the live DNS zone.${ttlNote(result.ttlAffected)}`,
  };
}

export async function updateRecord(domain, existing, input) {
  // A hand-entered record is not in the zone, so there is nothing upstream to
  // change — whatever the domain is linked to.
  const live = existing.isFromProvider ? await liveZone(domain) : null;

  if (!live) {
    const record = await prisma.dnsRecord.update({
      where: { id: existing.id },
      // An edited provider record is no longer a faithful copy of the zone, so
      // it becomes a manual record and survives the next sync.
      data: { ...input, isFromProvider: false },
    });
    return {
      record,
      live: false,
      message: existing.isFromProvider
        ? 'Record updated in the portal only. The live zone was not changed.'
        : 'Record updated.',
    };
  }

  let result;
  try {
    result = await live.adapter.updateDnsRecord(
      live.token,
      domain.name,
      {
        before: { name: existing.name, type: existing.type, content: existing.content },
        after: input,
      },
      { minimumBefore: await liveRecordCount(domain.id) },
    );
  } catch (err) {
    throw asHttpError(err);
  }

  await storeZone(domain.id, result.records);
  return {
    live: true,
    message: `Updated ${describe(input)} in the live DNS zone.${ttlNote(result.ttlAffected)}`,
  };
}

export async function deleteRecord(domain, existing) {
  const live = existing.isFromProvider ? await liveZone(domain) : null;

  if (!live) {
    await prisma.dnsRecord.delete({ where: { id: existing.id } });
    return {
      live: false,
      message: existing.isFromProvider
        ? 'Record removed from the portal only. The live zone still has it.'
        : 'Record deleted.',
    };
  }

  let result;
  try {
    result = await live.adapter.deleteDnsRecord(
      live.token,
      domain.name,
      { name: existing.name, type: existing.type, content: existing.content },
      { minimumBefore: await liveRecordCount(domain.id) },
    );
  } catch (err) {
    throw asHttpError(err);
  }

  await storeZone(domain.id, result.records);
  return { live: true, message: `Removed ${describe(existing)} from the live DNS zone.` };
}

/// Whether this domain's zone accepts changes, for the page to show before
/// somebody presses anything.
export async function canWriteZone(domain) {
  return Boolean(await liveZone(domain));
}
