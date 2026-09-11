import { describe, expect, it } from 'vitest';
import { getAisCandidateSummary, getStrategicSourceStatus } from '@/components/strategic-posture-status';

describe('strategic posture source status', () => {
  it('distinguishes initial load from an unavailable source', () => {
    expect(getStrategicSourceStatus({ now: 10_000 })).toBe('initial');
    expect(getStrategicSourceStatus({ now: 10_000, available: false })).toBe('unavailable');
  });

  it('distinguishes empty, stale, and connected snapshots', () => {
    expect(getStrategicSourceStatus({ now: 10_000, available: true, hasSnapshot: true, count: 0 })).toBe('empty');
    expect(getStrategicSourceStatus({ now: 10_000, available: true, hasSnapshot: true, count: 2, stale: true })).toBe('stale');
    expect(getStrategicSourceStatus({ now: 10_000, available: true, connected: true, hasSnapshot: true, count: 2 })).toBe('connected');
  });

  it('treats an old snapshot as stale without inventing a provider field', () => {
    expect(getStrategicSourceStatus({ now: 10_000, available: true, connected: true, hasSnapshot: true, count: 2, fetchedAt: 1_000, staleAfterMs: 5_000 })).toBe('stale');
  });

  it('does not turn AIS candidates into confirmed military matches', () => {
    expect(getAisCandidateSummary(3, true)).toContain('3 candidate reports');
    expect(getAisCandidateSummary(3, true)).not.toContain('military-matched');
    expect(getAisCandidateSummary(0, true)).toContain('0 candidate reports');
  });
});
