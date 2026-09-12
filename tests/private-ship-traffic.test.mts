import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ShipTrafficFeed,
  appendTrackPoint,
  boundsQuery,
  boundsSpan,
  classifyShipType,
  mergeContacts,
  normalizeContact,
  pruneContacts,
  type ShipContact,
} from '../src/services/private-ship-traffic.ts';

const contact = (over: Partial<ShipContact> = {}): ShipContact => ({
  mmsi: '211000001', name: 'TEST', lat: 52.0, lon: 4.0, timestamp: 1_000, shipType: 70,
  heading: 90, speed: 12, course: 88, source: 'relay', ...over,
});

test('classifyShipType follows the ITU first-digit classes', () => {
  assert.equal(classifyShipType(70), 'cargo');
  assert.equal(classifyShipType(89), 'tanker');
  assert.equal(classifyShipType(60), 'passenger');
  assert.equal(classifyShipType(30), 'fishing');
  assert.equal(classifyShipType(35), 'military');
  assert.equal(classifyShipType(51), 'sar');
  assert.equal(classifyShipType(0), 'other');
  assert.equal(classifyShipType(undefined), 'other');
});

test('normalizeContact rejects bad coordinates and coerces the rest', () => {
  assert.equal(normalizeContact({ mmsi: 1, lat: 91, lon: 0 }, 'relay'), null);
  assert.equal(normalizeContact({ lat: 1, lon: 2 }, 'relay'), null);
  const c = normalizeContact({ mmsi: 211000001, name: ' X ', lat: 1, lon: 2, timestamp: 5, shipType: 80, heading: 'n/a', speed: 3 }, 'vesselapi', 99);
  assert.deepEqual(c, { mmsi: '211000001', name: 'X', lat: 1, lon: 2, timestamp: 5, shipType: 80, heading: null, speed: 3, course: null, source: 'vesselapi', imo: null, navStatus: null });
  assert.equal(normalizeContact({ mmsi: '1', lat: 1, lon: 2 }, 'relay', 77)?.timestamp, 77);
});

test('mergeContacts keeps the newest fix regardless of source and preserves known name/type', () => {
  const map = new Map<string, ShipContact>();
  assert.equal(mergeContacts(map, [contact()]), 1);
  // Older VesselAPI fix must not clobber the newer relay fix.
  assert.equal(mergeContacts(map, [contact({ timestamp: 500, source: 'vesselapi', lat: 10 })]), 0);
  assert.equal(map.get('211000001')?.lat, 52);
  // Newer fix without a name keeps the name and type it already had.
  assert.equal(mergeContacts(map, [contact({ timestamp: 2_000, name: '', shipType: 0, lat: 52.1 })]), 1);
  assert.equal(map.get('211000001')?.name, 'TEST');
  assert.equal(map.get('211000001')?.shipType, 70);
  // Identical fix is a no-op.
  assert.equal(mergeContacts(map, [contact({ timestamp: 2_000, lat: 52.1 })]), 0);
});

test('pruneContacts drops stale fixes', () => {
  const map = new Map<string, ShipContact>([['a', contact({ mmsi: 'a', timestamp: 0 })], ['b', contact({ mmsi: 'b', timestamp: 10_000 })]]);
  assert.equal(pruneContacts(map, 10_500, 1_000), 1);
  assert.deepEqual([...map.keys()], ['b']);
});

test('appendTrackPoint dedupes, keeps order, and bounds the trail', () => {
  const track: { lon: number; lat: number; timestamp: number }[] = [];
  assert.equal(appendTrackPoint(track, contact({ timestamp: 1 })), true);
  assert.equal(appendTrackPoint(track, contact({ timestamp: 1 })), false, 'same timestamp');
  assert.equal(appendTrackPoint(track, contact({ timestamp: 2 })), false, 'same position');
  assert.equal(appendTrackPoint(track, contact({ timestamp: 0, lat: 53 })), false, 'out of order');
  assert.equal(appendTrackPoint(track, contact({ timestamp: 3, lat: 53 })), true);
  for (let i = 4; i < 20; i++) appendTrackPoint(track, contact({ timestamp: i, lat: 53 + i }), 5);
  assert.equal(track.length, 5);
  assert.equal(track[track.length - 1]?.timestamp, 19);
});

test('bounds helpers', () => {
  assert.equal(boundsSpan({ swLat: 0, swLon: 0, neLat: 2, neLon: 5 }), 5);
  assert.equal(boundsQuery({ swLat: 1.23456, swLon: -2, neLat: 3, neLon: 4 }), '1.235,-2.000,3.000,4.000');
});

test('feed polls the relay route for the view, tracks fixes, and refuses wide views', async () => {
  const calls: string[] = [];
  let bounds = { swLat: 50, swLon: 3, neLat: 53, neLon: 6 };
  let seq = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    seq++;
    return new Response(JSON.stringify({ vessels: [{ mmsi: 1, name: 'A', lat: 52 + seq * 0.01, lon: 4, timestamp: Date.now() - 60_000 + seq * 1_000, shipType: 70, speed: 10 }], total: 1, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const updates: number[] = [];
  const feed = new ShipTrafficFeed({ getBounds: () => bounds, onUpdate: (contacts) => updates.push(contacts.length), fetchImpl });
  await feed.poll();
  await feed.poll();
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^\/api\/private\/ais\/vessels\?bbox=50\.000,3\.000,53\.000,6\.000&limit=/);
  assert.equal(feed.getContacts().length, 1);
  assert.equal(feed.getTrack('1').length, 2, 'two distinct fixes make a two-point trail');
  assert.equal(feed.getStatus().state, 'polling');

  bounds = { swLat: -40, swLon: -60, neLat: 40, neLon: 60 };
  await feed.poll();
  assert.equal(calls.length, 2, 'wide view does not hit the relay');
  assert.equal(feed.getStatus().state, 'zoom-in');
  assert.ok(updates.length >= 3);
});

test('checkVesselApi enforces the 4-degree span client-side and merges results', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ vessels: [{ mmsi: 9, name: 'V', lat: 25.5, lon: 56.2, timestamp: Date.now() - 5_000, heading: 10, speed: 8, course: 12, imo: 123 }], total: 1, remainingMonth: '143', usedToday: 1, dailyCap: 12 }), { status: 200 });
  }) as unknown as typeof fetch;
  const feed = new ShipTrafficFeed({ getBounds: () => ({ swLat: 20, swLon: 50, neLat: 30, neLon: 60 }), onUpdate: () => undefined, fetchImpl });
  const wide = await feed.checkVesselApi();
  assert.equal(wide.ok, false);
  assert.equal(calls.length, 0);

  const narrow = new ShipTrafficFeed({ getBounds: () => ({ swLat: 25, swLon: 55, neLat: 27, neLon: 57 }), onUpdate: () => undefined, fetchImpl });
  const result = await narrow.checkVesselApi();
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.remainingMonth, '143');
  assert.equal(narrow.getContact('9')?.source, 'vesselapi');
  assert.equal(narrow.getContact('9')?.imo, 123);
  assert.match(calls[0]!, /^\/api\/private\/vesselapi\/bbox\?bbox=25\.000,55\.000,27\.000,57\.000$/);
});
