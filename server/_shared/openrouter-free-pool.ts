/**
 * OpenRouter free-model pool.
 *
 * The personal/private build runs on an OpenRouter free-tier key and the
 * owner's instruction is "use any/all free OpenRouter models, cycle as needed".
 * OpenRouter's `:free` catalogue rotates weekly, so the pool is DISCOVERED from
 * the live /models listing (cached per process) rather than pinned, and the
 * caller walks it in order, skipping models that just rate-limited or errored.
 *
 * Enabled by LLM_FREE_POOL=1. Ordering: an explicit per-profile override model
 * first, then OPENROUTER_FREE_PRIMARY_MODEL / OPENROUTER_FREE_BACKUP_MODEL, then
 * the rest of the catalogue by context length. LLM_FREE_MODEL_POOL (comma
 * separated ids) replaces discovery entirely when set.
 *
 * Only text-in/text-out chat models are eligible: audio/music generators and
 * content-safety classifiers are listed as free but cannot answer a prompt.
 * `openrouter/free` (the random router) is excluded because a failure there
 * says nothing about which model to skip next.
 *
 * Note for the operator: OpenRouter caps free-tier accounts at a small number
 * of free-model requests per day (50/day without purchased credits at the time
 * of writing). Cycling helps with per-model rate limits and delistings; it
 * does not raise that account-wide cap.
 */

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const POOL_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
const ERROR_COOLDOWN_MS = 30 * 1000;
const NOT_FOUND_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FREE_POOL_ATTEMPTS = 6;

interface OpenRouterModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

let cache: { fetchedAt: number; models: string[] } | null = null;
let inFlight: Promise<string[]> | null = null;
const cooldowns = new Map<string, number>();

export function isFreePoolEnabled(): boolean {
  return process.env.LLM_FREE_POOL === '1' && !!process.env.OPENROUTER_API_KEY;
}

function isZero(value: string | number | undefined): boolean {
  return value !== undefined && Number(value) === 0;
}

/** Pure selection rule over a /models payload; exported for tests. */
export function selectFreeChatModels(models: readonly OpenRouterModel[]): string[] {
  return models
    .filter((m) => typeof m.id === 'string' && m.id.endsWith(':free'))
    .filter((m) => isZero(m.pricing?.prompt) && isZero(m.pricing?.completion))
    .filter((m) => {
      const input = m.architecture?.input_modalities ?? ['text'];
      const output = m.architecture?.output_modalities ?? ['text'];
      return input.includes('text') && output.includes('text') && !output.includes('audio');
    })
    .filter((m) => !/content-safety|guard|moderation|embed/i.test(m.id))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
    .map((m) => m.id);
}

/** Order the pool: preferred ids first (deduplicated), then the rest as discovered. */
export function orderFreePool(discovered: readonly string[], preferred: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...preferred, ...discovered]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function discover(): Promise<string[]> {
  const explicit = (process.env.LLM_FREE_MODEL_POOL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const response = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`OpenRouter /models HTTP ${response.status}`);
  const data = (await response.json()) as { data?: OpenRouterModel[] };
  return selectFreeChatModels(Array.isArray(data.data) ? data.data : []);
}

/**
 * The current pool, ordered. Never throws: on discovery failure it falls back
 * to the two configured free legs so the chain still has something to try.
 */
export async function getOpenRouterFreePool(preferredModel?: string): Promise<string[]> {
  const preferred = [preferredModel, process.env.OPENROUTER_FREE_PRIMARY_MODEL, process.env.OPENROUTER_FREE_BACKUP_MODEL];
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > POOL_TTL_MS) {
    inFlight ??= discover()
      .then((models) => { cache = { fetchedAt: Date.now(), models }; return models; })
      .catch((error) => {
        console.warn('[openrouter-free-pool] discovery failed, using configured free legs only:', error instanceof Error ? error.message : error);
        if (!cache) cache = { fetchedAt: Date.now() - POOL_TTL_MS + 60_000, models: [] };
        return cache.models;
      })
      .finally(() => { inFlight = null; });
    await inFlight;
  }
  return orderFreePool(cache?.models ?? [], preferred);
}

/** Models still cooling down after a rate limit / outage / delisting are skipped this call. */
export function isFreeModelCooling(model: string, now = Date.now()): boolean {
  const until = cooldowns.get(model);
  if (until === undefined) return false;
  if (now >= until) { cooldowns.delete(model); return false; }
  return true;
}

export function recordFreeModelFailure(model: string, status: number, now = Date.now()): void {
  const ms = status === 429 ? RATE_LIMIT_COOLDOWN_MS : status === 404 || status === 400 ? NOT_FOUND_COOLDOWN_MS : status >= 500 ? ERROR_COOLDOWN_MS : 0;
  if (ms > 0) cooldowns.set(model, now + ms);
}

export function recordFreeModelSuccess(model: string): void {
  cooldowns.delete(model);
}

/** Test seam. */
export function __resetFreePoolForTests(): void {
  cache = null;
  inFlight = null;
  cooldowns.clear();
}
