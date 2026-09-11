/**
 * RPC: getFredSeries -- reads seeded FRED time series data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';
import { fetchLocalFredSeries } from './_local-fred';

export async function getFredSeries(
  _ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  try {
    const seedKey = fredSeedKey(req.seriesId);
    const result = await getCachedJson(seedKey, true) as GetFredSeriesResponse | null;
    const limit = normalizeFredLimit(req.limit);
    if (!result?.series) {
      // Private local preview only (null otherwise): keyless fredgraph
      // export for a seed miss. See ./_local-fred.ts.
      const local = await fetchLocalFredSeries([req.seriesId]);
      const series = local?.get(req.seriesId.trim().toUpperCase());
      return { series: series ? applyFredObservationLimit(series, limit) : undefined };
    }
    return { series: applyFredObservationLimit(result.series, limit) };
  } catch {
    return { series: undefined };
  }
}
