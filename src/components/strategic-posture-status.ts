export type StrategicSourceStatus = 'initial' | 'unavailable' | 'empty' | 'stale' | 'connected';

export interface StrategicSourceStatusInput {
  available?: boolean;
  connected?: boolean;
  hasSnapshot?: boolean;
  count?: number;
  stale?: boolean;
  fetchedAt?: number;
  now?: number;
  staleAfterMs?: number;
}

/** Classify only evidence supplied by the source; missing data is not success. */
export function getStrategicSourceStatus(input: StrategicSourceStatusInput): StrategicSourceStatus {
  if (input.available === undefined && !input.hasSnapshot) return 'initial';
  if (input.available === false) return 'unavailable';
  if (!input.hasSnapshot) return 'initial';
  const staleByAge = input.fetchedAt !== undefined && input.fetchedAt > 0 && input.now !== undefined
    && input.staleAfterMs !== undefined && input.now - input.fetchedAt > input.staleAfterMs;
  if (input.stale || staleByAge) return 'stale';
  if ((input.count ?? 0) === 0) return 'empty';
  return input.connected ? 'connected' : 'stale';
}

export const STRATEGIC_SOURCE_STATUS_LABELS: Record<StrategicSourceStatus, string> = {
  initial: 'initial load',
  unavailable: 'unavailable',
  empty: 'connected, no records',
  stale: 'stale snapshot',
  connected: 'connected snapshot',
};

export function getAisCandidateSummary(candidateCount: number, candidatesRequested: boolean): string {
  return candidatesRequested
    ? `${candidateCount} candidate reports; military classification not confirmed`
    : 'individual military matching not requested';
}
