// Editing a DNS zone the way Hostinger stores one.
//
// Hostinger does not offer per-record endpoints. A zone is a list of groups,
// each group being one (name, type) pair with a TTL and the values under it:
//
//   [{ name: '@', type: 'MX', ttl: 3600,
//      records: [{ content: 'mx1.example.com', isDisabled: false }, …] }]
//
// So "add one record" really means: read the whole zone, change one thing,
// write the whole zone back. That is the dangerous shape of operation — every
// field we fail to model would be dropped on the way through, and a bug would
// not corrupt one record but all of them.
//
// Two rules hold the danger down, and both are enforced here rather than left
// to the caller:
//
//   1. The upstream objects are deep-cloned and carried through untouched.
//      Only the group being edited is rebuilt, and only its `records` array
//      changes — anything Hostinger sends that we have never heard of survives.
//   2. Every edit is checked before it is allowed out. An edit that would
//      remove records it was not asked to remove does not get written.

export class ZoneError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const norm = (value) => String(value ?? '').trim();
/// Record names are case-insensitive in DNS, and "" means the apex, same as "@".
const sameName = (a, b) => {
  const x = norm(a).toLowerCase() || '@';
  const y = norm(b).toLowerCase() || '@';
  return x === y;
};
const sameType = (a, b) => norm(a).toUpperCase() === norm(b).toUpperCase();
const sameContent = (a, b) => norm(a) === norm(b);

const clone = (groups) => structuredClone(groups);

const entriesOf = (group) => (Array.isArray(group?.records) ? group.records : []);

/// Flattens a zone into one row per value, which is how a person reads it.
export function flattenZone(groups) {
  const flat = [];
  for (const group of groups || []) {
    for (const entry of entriesOf(group)) {
      flat.push({
        name: group.name ?? '@',
        type: group.type ?? 'A',
        content: entry?.content ?? '',
        ttl: Number(group.ttl) || 3600,
        isDisabled: Boolean(entry?.isDisabled),
      });
    }
  }
  return flat;
}

/// How many values a zone holds in total, which is what the safety check counts.
export const countRecords = (groups) =>
  (groups || []).reduce((total, group) => total + entriesOf(group).length, 0);

const findGroup = (groups, name, type) =>
  groups.find((g) => sameName(g.name, name) && sameType(g.type, type));

/// Adds one value.
///
/// TTL belongs to the group upstream, not to the individual value, so adding a
/// record with a different TTL to an existing (name, type) moves every value
/// there. That is Hostinger's model rather than a choice made here, so the
/// change is reported back and the caller can say so out loud.
export function addRecord(groups, { name, type, content, ttl = 3600 }) {
  const next = clone(groups || []);
  const group = findGroup(next, name, type);

  if (!group) {
    next.push({
      name: norm(name) || '@',
      type: norm(type).toUpperCase(),
      ttl: Number(ttl) || 3600,
      records: [{ content: norm(content), isDisabled: false }],
    });
    return { groups: next, ttlAffected: 0 };
  }

  if (entriesOf(group).some((e) => sameContent(e?.content, content))) {
    throw new ZoneError('That exact record already exists in the zone.', 409);
  }

  const siblings = entriesOf(group).length;
  const ttlChanged = Number(ttl) && Number(group.ttl) !== Number(ttl);
  if (ttlChanged) group.ttl = Number(ttl);

  group.records = [...entriesOf(group), { content: norm(content), isDisabled: false }];
  return { groups: next, ttlAffected: ttlChanged ? siblings : 0 };
}

/// Removes one value, and the group with it once the group is empty — an empty
/// group is not something a zone should be asked to carry.
export function removeRecord(groups, { name, type, content }) {
  const next = clone(groups || []);
  const group = findGroup(next, name, type);
  if (!group) throw new ZoneError('That record is no longer in the zone.', 404);

  const kept = entriesOf(group).filter((e) => !sameContent(e?.content, content));
  if (kept.length === entriesOf(group).length) {
    throw new ZoneError('That record is no longer in the zone.', 404);
  }

  group.records = kept;
  return { groups: next.filter((g) => entriesOf(g).length > 0) };
}

/// Changes one value. A change of name or type moves it between groups, which
/// is why this is a removal followed by an addition rather than an edit in
/// place.
export function updateRecord(groups, before, after) {
  const removed = removeRecord(groups, before);
  try {
    return addRecord(removed.groups, after);
  } catch (err) {
    // Re-adding onto a value that already exists would silently delete the
    // original, so the edit is refused with the zone untouched.
    if (err instanceof ZoneError && err.status === 409) {
      throw new ZoneError('The zone already holds a record with those values.', 409);
    }
    throw err;
  }
}

/// The last gate before a zone is written.
///
/// A whole-zone write is the one call in this system that can destroy data it
/// was never asked to touch, and it does so in two ways.
///
/// The first is a bad edit, caught by comparing record counts: an edit asked to
/// add one record must produce exactly one more than it read. Anything else
/// means the transformation went wrong, and that check covers wiping the zone
/// as a special case of it — so deliberately deleting the last record in a zone
/// is still allowed, because there the delta is exactly what was asked for.
///
/// The second is more insidious. `getDnsZoneRaw` turns a 404 into an empty
/// zone, which is right — a domain can genuinely have no zone here. But if a
/// live zone 404s transiently, "read empty, add one record, write" would
/// replace a real zone with a single record. So the caller passes how many
/// records it already believes are up there, and a read that contradicts that
/// is treated as a failed read rather than as an emptied zone.
export function assertSafeWrite(before, after, { expectedDelta, minimumBefore = 0 }) {
  const from = countRecords(before);
  const to = countRecords(after);

  if (minimumBefore > 0 && from === 0) {
    throw new ZoneError(
      'Refusing to write: this domain should have DNS records, but reading the zone returned none. ' +
        'Writing now would replace the whole zone. Nothing has been changed — reload the zone and try again.',
      409,
    );
  }

  if (to - from !== expectedDelta) {
    throw new ZoneError(
      `Refusing to write: the zone would go from ${from} record${from === 1 ? '' : 's'} to ${to}, ` +
        'which is not the change that was asked for. Nothing has been altered — reload the zone and try again.',
      409,
    );
  }
}

/// Finds a value in a zone, so a change can be checked against what is really
/// there rather than against what a page was showing a minute ago.
export const hasRecord = (groups, { name, type, content }) =>
  entriesOf(findGroup(groups || [], name, type)).some((e) => sameContent(e?.content, content));

/// Whether two records are one and the same — name, type and value — as
/// they are when an edit changes only the TTL. Compared the way the zone
/// itself compares them, so "@" and a quoted TXT value match as they would
/// there.
export const sameRecord = (a, b) =>
  hasRecord([{ name: a.name, type: a.type, records: [{ content: a.content }] }], b);
