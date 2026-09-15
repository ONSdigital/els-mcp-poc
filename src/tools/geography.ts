/**
 * Geography tools — resolving place names/postcodes/coordinates to GSS area codes, area
 * detail/relations, and the geo-level vocabulary. See docs/design.md "Geography".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elsGet, isEmptySearchResult, upperGss } from "../http-client.js";
import { getGeoLevels } from "../cache.js";
import type { AreaSearchResult } from "../types.js";
import { errorResult, jsonResult } from "../tool-helpers.js";

// Sensible "administrative area" levels for resolving a place name typed by a person (city /
// town / local authority / region / country). Excludes finer levels like parliamentary
// constituencies unless nothing else matches.
const DEFAULT_PLACE_LEVELS = "ltla,utla,cauth,rgn,ctry";

interface GeoSearchResponse {
  meta: { count: number; total: number };
  data: AreaSearchResult[];
}

async function searchAreasImpl(
  query: string,
  geoLevels: string | undefined,
  limit: number,
): Promise<AreaSearchResult[]> {
  const geoLevel = geoLevels === undefined || geoLevels === "all" ? undefined : geoLevels;
  const result = await elsGet<GeoSearchResponse>(`/geo/search/${encodeURIComponent(query)}`, {
    geoLevel,
    limit,
  });
  return isEmptySearchResult(result) ? [] : result.data;
}

async function resolveAreaImpl(
  query: string,
  geoLevels: string | undefined,
): Promise<{ match: AreaSearchResult | null; alternatives: AreaSearchResult[] }> {
  let results = await searchAreasImpl(query, geoLevels, 10);
  if (results.length === 0) {
    results = await searchAreasImpl(query, "all", 10);
  }
  if (results.length === 0) {
    return { match: null, alternatives: [] };
  }
  const exact = results.filter((r) => r.areanm.toLowerCase() === query.toLowerCase());
  return { match: exact[0] ?? results[0]!, alternatives: results };
}

export function registerGeographyTools(server: McpServer): void {
  server.registerTool(
    "search_areas",
    {
      title: "Search areas",
      description:
        "Look up UK geographic areas (countries, regions, local authorities, etc.) by name. " +
        'Use this to convert a place name (e.g. "Birmingham", "Northern Ireland") into the ' +
        "GSS area code(s) needed by get_indicator_data. Returns candidate matches with their " +
        "area code (areacd), name (areanm) and area type (type). Note: this API has no concept " +
        'of "city" as a geography level (a ceremonial UK designation, not an administrative ' +
        "one) — a city name will resolve only if it also happens to be a local authority name.",
      inputSchema: {
        query: z.string().describe('Place name or partial name to search for (e.g. "Norwich").'),
        geo_levels: z
          .string()
          .optional()
          .describe(
            'Comma-separated geography level(s) to restrict results to (e.g. "ltla,rgn,ctry"). ' +
              "Defaults to common administrative levels (local authority up to country). Pass " +
              '"all" to search every level, including parliamentary constituencies etc. Note: ' +
              "this takes a LIST of levels to filter by, unlike the single geo_type used in " +
              "get_indicator_data/rank_areas/get_related_areas, which names one area type to " +
              "fetch every area of.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Maximum results (default 10)."),
      },
    },
    async ({ query, geo_levels, limit }) => {
      const results = await searchAreasImpl(query, geo_levels ?? DEFAULT_PLACE_LEVELS, limit ?? 10);
      return jsonResult(results);
    },
  );

  server.registerTool(
    "resolve_area",
    {
      title: "Resolve area",
      description:
        "Resolve a place name to its single best-matching area, with alternates. Prefers an " +
        "exact (case-insensitive) name match; otherwise returns the top search result. Use this " +
        "instead of search_areas when you just need one area code for a place, e.g. before " +
        "calling get_indicator_data.",
      inputSchema: {
        query: z.string().describe('Place name to resolve (e.g. "Belfast").'),
        geo_levels: z
          .string()
          .optional()
          .describe(
            "See search_areas. Falls back to an unrestricted search if no results are found at " +
              "the requested level(s).",
          ),
      },
    },
    async ({ query, geo_levels }) => {
      const result = await resolveAreaImpl(query, geo_levels ?? DEFAULT_PLACE_LEVELS);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "get_area_details",
    {
      title: "Get area details",
      description:
        "Get metadata for a single area by its GSS code: full name, area type, and immediate " +
        "child areas (large lists of small-area codes like output areas are omitted to keep the " +
        "response compact).",
      inputSchema: {
        area_code: z.string().describe('GSS area code, e.g. "E08000025" for Birmingham.'),
      },
    },
    async ({ area_code }) => {
      const data = await elsGet<{ properties: Record<string, unknown> }>(
        `/geo/lookup/${encodeURIComponent(upperGss(area_code))}`,
      );
      const props = { ...data.properties };
      for (const bulky of ["oa21cds", "lsoa21cds", "msoa21cds"]) {
        delete props[bulky];
      }
      return jsonResult(props);
    },
  );

  server.registerTool(
    "get_related_areas",
    {
      title: "Get related areas",
      description:
        "Find areas related to a given area: administrative parents/children/siblings, or " +
        "statistically similar areas. `similar` is statistical similarity (comparable " +
        "socio-economic profile), NOT geographic proximity — use lookup_area or " +
        'get_nearby_areas for genuine "nearby" queries. Useful for building comparisons, e.g. ' +
        "finding the region/country a local authority sits within.",
      inputSchema: {
        area_code: z.string().describe("GSS code of the area to find relations for."),
        relation: z
          .enum(["parents", "children", "siblings", "similar"])
          .default("parents")
          .describe(
            "parents/children/siblings = administrative hierarchy. similar = statistical " +
              "similarity, not geography.",
          ),
        geo_type: z
          .string()
          .optional()
          .describe(
            "A single area-type code (e.g. \"ltla\" - see list_geo_levels). For 'children', " +
              "optionally request a lower-level grouping. For 'siblings', optionally request " +
              "siblings within a wider parent level via the same parameter.",
          ),
      },
    },
    async ({ area_code, relation, geo_type }) => {
      const params: Record<string, string> = {};
      if (relation === "children" && geo_type) params.geoLevel = geo_type;
      if (relation === "siblings" && geo_type) params.parentLevel = geo_type;
      const data = await elsGet(
        `/geo/related/${encodeURIComponent(upperGss(area_code))}/${relation}`,
        params,
      );
      return jsonResult(data);
    },
  );

  server.registerTool(
    "get_nearby_areas",
    {
      title: "Get nearby areas",
      description:
        "Find areas genuinely near a given area by geographic distance (straight-line, from " +
        "area centroids) — distinct from get_related_areas' 'siblings'/'similar', which are " +
        "administrative/statistical, not spatial. Searches among areas of the same geo_type as " +
        "the given area (or a specified geo_type) within a bounding parent region for " +
        "efficiency, then ranks by actual distance.",
      inputSchema: {
        area_code: z.string().describe("GSS code of the area to find neighbours for."),
        geo_type: z
          .string()
          .optional()
          .describe(
            "Area-type code to search among (default: same type as area_code — see " +
              "list_geo_levels).",
          ),
        count: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Number of nearby areas to return (default 10)."),
      },
    },
    async ({ area_code, geo_type, count }) => {
      const code = upperGss(area_code);
      const origin = await elsGet<{
        properties: { centroid?: [number, number]; groupcd?: string };
      }>(`/geo/lookup/${encodeURIComponent(code)}`);
      const centroid = origin.properties.centroid;
      if (!centroid) {
        return errorResult(`Area ${code} has no centroid available; cannot compute distance.`);
      }
      const level = geo_type ?? origin.properties.groupcd;
      if (!level) {
        return errorResult(`Could not determine a geo_type to search among for ${code}.`);
      }

      // Bound the candidate set to a parent area for efficiency (searching every ltla in the UK
      // for every call would be wasteful) — try the origin's parents from most to least specific
      // until one yields a workable candidate list, since not every area has every parent level
      // (e.g. only some English areas sit within a combined authority).
      const parents = await elsGet<{ areacd: string; areanm: string }[]>(
        `/geo/related/${encodeURIComponent(code)}/parents`,
      );
      let candidates: { areacd: string; areanm: string }[] = [];
      for (const parent of parents) {
        const children = await elsGet<{ areacd: string; areanm: string }[]>(
          `/geo/related/${encodeURIComponent(parent.areacd)}/children`,
          { geoLevel: level },
        ).catch(() => []);
        if (children.length > 1) {
          candidates = children;
          break;
        }
      }

      const eligibleCandidates = candidates.filter((c) => c.areacd !== code);
      // Cap parallel /geo/lookup calls for a single tool call (a country-wide ltla scope could
      // otherwise mean ~300 sequential-ish requests). This caps candidates BEFORE ranking by
      // distance, in whatever order the API returned them — so if the cap actually bites, the
      // true nearest areas could be outside the capped slice, not just "slower to compute."
      // Surfaced via `truncated` below rather than silently returning a possibly-wrong result as
      // if it were exhaustive.
      const CANDIDATE_CAP = 200;
      const truncated = eligibleCandidates.length > CANDIDATE_CAP;
      const withCentroids = await Promise.all(
        eligibleCandidates.slice(0, CANDIDATE_CAP).map(async (c) => {
          const detail = await elsGet<{ properties: { centroid?: [number, number] } }>(
            `/geo/lookup/${encodeURIComponent(c.areacd)}`,
          ).catch(() => null);
          const candidateCentroid = detail?.properties.centroid;
          return candidateCentroid
            ? {
                areacd: c.areacd,
                areanm: c.areanm,
                distance_km: haversineKm(centroid, candidateCentroid),
              }
            : null;
        }),
      );

      const ranked = withCentroids
        .filter((r): r is { areacd: string; areanm: string; distance_km: number } => r !== null)
        .sort((a, b) => a.distance_km - b.distance_km)
        .map((r) => ({ ...r, distance_km: Math.round(r.distance_km * 10) / 10 }));

      return jsonResult({
        results: ranked.slice(0, count ?? 10),
        ...(truncated
          ? {
              note:
                `Candidate set capped at ${CANDIDATE_CAP} areas (${eligibleCandidates.length} ` +
                "found) before distance-ranking — results may not include the true nearest " +
                "areas. Try a narrower geo_type or a more local starting area.",
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "list_geo_levels",
    {
      title: "List geo levels",
      description:
        "List the available geography level codes. Used as the single geo_type in " +
        "get_indicator_data, rank_areas, and get_related_areas (one area type to fetch/group " +
        "every area of), or as one entry within the comma-separated geo_levels filter in " +
        'search_areas/resolve_area. Codes include: "ltla" (lower-tier/unitary authorities), ' +
        '"utla" (upper-tier/unitary authorities), "cauth" (combined authorities), "rgn" ' +
        '(English regions plus Wales/Scotland/Northern Ireland), "ctry" (countries, UK, Great ' +
        "Britain). Each entry gives the level's code, label, and the underlying ONS area-type " +
        "codes it covers.",
      inputSchema: {},
    },
    async () => jsonResult(await getGeoLevels()),
  );

  server.registerTool(
    "lookup_area",
    {
      title: "Lookup area by postcode or coordinates",
      description:
        "Resolve a UK postcode or a latitude/longitude coordinate to the area(s) containing " +
        'it, at every geography level — answers "what\'s it like where I live". Provide exactly ' +
        "one of postcode, or the lat+lng pair.",
      inputSchema: {
        postcode: z.string().optional().describe('UK postcode, e.g. "NR2 1AA".'),
        lat: z.number().optional().describe("Latitude (requires lng)."),
        lng: z.number().optional().describe("Longitude (requires lat)."),
      },
    },
    async ({ postcode, lat, lng }) => {
      if (postcode) {
        const data = await elsGet(`/geo/postcodes/${encodeURIComponent(postcode)}`, {
          groupByLevel: true,
        });
        return jsonResult(data);
      }
      if (lat !== undefined && lng !== undefined) {
        const data = await elsGet("/geo/reverse", { lat, lng, groupByLevel: true });
        return jsonResult(data);
      }
      return errorResult("Provide either postcode, or both lat and lng.");
    },
  );
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * sinDLng * sinDLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
