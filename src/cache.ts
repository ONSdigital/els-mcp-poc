/**
 * Best-effort, in-process caching for the indicator catalogue and geo-levels list — both are
 * fetched often (every search/lookup tool reads the catalogue) and change rarely (indicators
 * weekly at most, geo levels effectively never).
 *
 * IMPORTANT: on Vercel's serverless Node runtime, this module-level state persists only across
 * a warm function instance, not reliably across every invocation — a cold start resets it. This
 * is a latency optimisation only; nothing here may assume the cache is populated (see
 * CLAUDE.md's "Caching" note). Each getter below re-fetches on a miss, so correctness never
 * depends on the cache surviving.
 */

import { elsGet } from "./http-client.js";
import type { GeoLevel, Indicator } from "./types.js";

let indicatorsCache: Indicator[] | undefined;
let indicatorsCacheAt = 0;
let geoLevelsCache: GeoLevel[] | undefined;

const INDICATOR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — best-effort, not correctness-bearing.

export async function getAllIndicators(): Promise<Indicator[]> {
  const now = Date.now();
  if (indicatorsCache && now - indicatorsCacheAt < INDICATOR_CACHE_TTL_MS) {
    return indicatorsCache;
  }
  const indicators = await elsGet<Indicator[]>("/metadata/indicators");
  indicatorsCache = indicators;
  indicatorsCacheAt = now;
  return indicators;
}

export async function getIndicatorBySlug(slug: string): Promise<Indicator | undefined> {
  const indicators = await getAllIndicators();
  return indicators.find((i) => i.slug === slug);
}

export async function getGeoLevels(): Promise<GeoLevel[]> {
  if (geoLevelsCache) return geoLevelsCache;
  const levels = await elsGet<GeoLevel[]>("/geo/levels", { includeAreas: "false" });
  geoLevelsCache = levels;
  return levels;
}
