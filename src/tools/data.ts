/**
 * Data tools — the core get_indicator_data tool plus the compound tools built on it
 * (rank_areas, rank_areas_by_change, get_area_profile) and health. See
 * docs/els-mcp-server-design.md "Data" for the full reasoning, including the coverage shape,
 * the pivot/download_format merge of what were originally two extra tools, and the
 * per-indicator (not per-row) confidenceIntervals handling.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elsGet, upperGss } from "../http-client.js";
import { getAllIndicators, getIndicatorBySlug } from "../cache.js";
import { ELS_API_BASE_URL } from "../config.js";
import type { Coverage, DataRow, Indicator } from "../types.js";
import { errorResult, jsonResult } from "../tool-helpers.js";

type DataBySlug = Record<string, DataRow[]>;

function countryOf(areacd: string): string {
  return areacd.slice(0, 1).toUpperCase();
}
function typeCodeOf(areacd: string): string {
  return areacd.slice(0, 3).toUpperCase();
}

/** Port of the Python proof-of-concept's bulk guard: at most one of {indicator/topic,
 * geography, time} may be left fully unrestricted at once — the underlying API can't serve a
 * request unbounded on more than one dimension. */
function checkBulkGuard(opts: {
  indicators?: string[];
  topic?: string;
  areaCodes?: string[];
  geoType?: string;
  geoExtent?: string;
  time: string;
}): string | null {
  const datasetsUnbounded = (!opts.indicators || opts.indicators.length === 0) && !opts.topic;
  const geoUnbounded =
    (!opts.areaCodes || opts.areaCodes.length === 0) && (!opts.geoType || !opts.geoExtent);
  const timeUnbounded = opts.time === "all";
  const unboundedCount = [datasetsUnbounded, geoUnbounded, timeUnbounded].filter(Boolean).length;
  if (unboundedCount >= 2) {
    return (
      "Too broad: at most one of indicator/topic, geography, or time can be unrestricted at " +
      "once. Narrow with a topic, a geo_type + geo_extent (or specific area_codes), or a " +
      "specific time period."
    );
  }
  return null;
}

async function fetchDataRows(params: {
  indicators?: string[];
  topic?: string;
  areaCodes?: string[];
  geoType?: string;
  geoExtent?: string;
  time: string;
  dimensions?: Record<string, string>;
}): Promise<DataBySlug> {
  // Area codes must already be upper-cased by the caller (GSS codes are case-insensitive on
  // the API, so we normalise them once, upstream). geo_type level keys (ltla, rgn, ...) must
  // NOT be upper-cased — confirmed live that "LTLA" silently returns zero rows where "ltla"
  // works, unlike GSS codes, which really are case-insensitive. Don't blanket-uppercase this
  // joined string.
  const geoParts = [...(params.areaCodes ?? [])];
  if (params.geoType) geoParts.push(params.geoType);
  const geo = geoParts.length > 0 ? geoParts.join(",") : "all";

  // KNOWN LIVE-API LIMITATION, not a bug here: filtering by more than one dimension_{code} at
  // once (e.g. sex AND age together) reproducibly returns zero rows even via a raw curl against
  // the API directly, while each filter works fine alone. Confirmed during next-steps.md step 4
  // verification — not something this tool layer can absorb, since the underlying data endpoint
  // itself is doing this. Worth flagging upstream; until then, callers combining >1 dimension
  // filter will see an empty result that looks like "no data" rather than "API can't do this
  // yet" — get_indicator_data's coverage.missing has no way to distinguish the two today.
  const dimensionParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.dimensions ?? {})) {
    // The dimension_{code} filter is case-sensitive and requires LOWER CASE values even though
    // the API's own rows return capitalised values (e.g. "Female") — confirmed live, not
    // documented anywhere. Absorbed here so no tool caller has to know this.
    dimensionParams[`dimension_${key}`] = value.toLowerCase();
  }

  return elsGet<DataBySlug>("/data.rows.json", {
    indicator:
      params.indicators && params.indicators.length > 0 ? params.indicators.join(",") : "all",
    topic: params.topic,
    geo,
    geoExtent: params.geoExtent ? upperGss(params.geoExtent) : undefined,
    includeNames: true,
    time: params.time,
    timeNearest: "any",
    ...dimensionParams,
  });
}

function buildCoverage(opts: {
  requestedIndicators?: string[];
  requestedAreaCodes?: string[];
  indicatorMeta: Map<string, Indicator>;
  dataBySlug: DataBySlug;
}): Coverage {
  const allReturnedAreas = new Set<string>();
  for (const rows of Object.values(opts.dataBySlug)) {
    for (const row of rows) allReturnedAreas.add(row.areacd);
  }
  const returnedIndicators = Object.entries(opts.dataBySlug)
    .filter(([, rows]) => rows.length > 0)
    .map(([slug]) => slug);
  const requestedCountries = opts.requestedAreaCodes
    ? [...new Set(opts.requestedAreaCodes.map(countryOf))]
    : undefined;

  const missing: Coverage["missing"] = [];
  const flaggedCountries = new Set<string>();
  const slugsToCheck = opts.requestedIndicators ?? Object.keys(opts.dataBySlug);

  for (const slug of slugsToCheck) {
    const rows = opts.dataBySlug[slug] ?? [];
    const meta = opts.indicatorMeta.get(slug);

    if (opts.requestedAreaCodes && opts.requestedAreaCodes.length > 0) {
      const returnedAreasForSlug = new Set(rows.map((r) => r.areacd));
      for (const areacd of opts.requestedAreaCodes) {
        if (returnedAreasForSlug.has(areacd)) continue;
        const country = countryOf(areacd);
        const typeCode = typeCodeOf(areacd);
        if (meta && !meta.geography.countries.includes(country)) {
          const key = `${slug}:${country}`;
          if (!flaggedCountries.has(key)) {
            flaggedCountries.add(key);
            missing.push({
              type: "country",
              value: country,
              reason: `${slug} does not cover country ${country}`,
            });
          }
          continue;
        }
        if (meta && !meta.geography.types.includes(typeCode)) {
          missing.push({
            type: "area",
            value: areacd,
            reason: `${slug} covers ${country} nationally but not at this area's level (${typeCode})`,
          });
          continue;
        }
        missing.push({
          type: "area",
          value: areacd,
          reason: `${slug}: no observation returned for this area/period`,
        });
      }
    } else if (rows.length === 0) {
      missing.push({
        type: "indicator",
        value: slug,
        reason: "no observations returned for the requested geography/period",
      });
    }
  }

  return {
    requested: {
      indicators: opts.requestedIndicators ?? slugsToCheck,
      areas: opts.requestedAreaCodes,
      countries: requestedCountries,
    },
    returned: {
      indicators: returnedIndicators,
      areas: [...allReturnedAreas],
      countries: [...new Set([...allReturnedAreas].map(countryOf))],
    },
    missing,
  };
}

function indicatorMetadataBlock(meta: Indicator | undefined) {
  if (!meta) return undefined;
  return {
    label: meta.label,
    source: meta.source,
    unit: meta.unit,
    caveats: meta.caveats,
    updated: meta.updated,
    confidenceIntervals: meta.confidenceIntervals ?? false,
    // Both matter for reading `data` (or a pivoted cell) correctly: isMultivariate means more
    // than one row per area/period is normal (one per dimension combination, e.g. sex x age)
    // unless `dimensions` narrowed it to exactly one; hasTimeseries means the same for `time`
    // spanning more than one period. Surfaced explicitly so more-than-one-row-per-area isn't a
    // surprise — see pivotByArea below for the bug this was added to stop recurring.
    isMultivariate: meta.isMultivariate ?? false,
    hasTimeseries: meta.hasTimeseries ?? false,
  };
}

/** When exactly two areas are being compared on an indicator with confidence intervals, flag
 * whether the two areas' 95% CIs overlap — surfacing "is this actually different" directly
 * rather than leaving the model to eyeball two numbers against a margin of error. Not attempted
 * for >2 areas (no single well-defined pairwise comparison to highlight) or when the indicator
 * has no CI at all (explicitly noted as ci_available: false instead of silently saying nothing,
 * since silence could misread as "measured, no difference").
 *
 * Requires EXACTLY one row per area (rows.length === 2), not just two distinct area codes among
 * a larger set — a multivariate indicator or a multi-period `time` range can return several rows
 * per area, and picking "the first matching row" per area in that case would silently compare an
 * arbitrary dimension/period slice rather than a real, deliberate comparison (the same class of
 * bug fixed in pivotByArea below — caught via real usage). Comparison is skipped with an explicit
 * reason in that case rather than guessing which row was meant. */
function buildComparisonNote(meta: Indicator | undefined, rows: DataRow[]) {
  const areas = [...new Set(rows.map((r) => r.areacd))];
  if (areas.length !== 2) return undefined;
  if (rows.length !== 2) {
    return {
      ci_available: false,
      note:
        `${rows.length} rows returned across 2 areas (expected 1 each) — likely a multivariate ` +
        "indicator or a multi-period time range. Narrow with `dimensions` and/or a single `time` " +
        "period to get a well-defined two-area comparison.",
    };
  }
  if (!meta?.confidenceIntervals) return { ci_available: false };
  const [a, b] = areas as [string, string];
  const rowA = rows.find((r) => r.areacd === a && r.lci_95 !== undefined);
  const rowB = rows.find((r) => r.areacd === b && r.lci_95 !== undefined);
  if (!rowA || !rowB || rowA.lci_95 === undefined || rowB.lci_95 === undefined) {
    return {
      ci_available: false,
      note: "CI expected for this indicator but missing on one or both rows",
    };
  }
  const overlapping = rowA.lci_95! <= rowB.uci_95! && rowB.lci_95! <= rowA.uci_95!;
  return {
    ci_available: true,
    areas: [a, b],
    overlapping,
    note: overlapping
      ? "95% confidence intervals overlap — difference is not statistically significant at this level."
      : "95% confidence intervals do not overlap — difference is statistically significant at this level.",
  };
}

/** One area's worth of a single indicator's rows — ALWAYS an array, never collapsed to a bare
 * object. An indicator can legitimately return more than one row for the same area: a
 * multivariate indicator (e.g. population-by-age-and-sex) returns one row per dimension
 * combination unless `dimensions` narrowed it to exactly one, and any indicator returns one row
 * per period when `time` spans more than a single point. An earlier version of this function
 * kept only the LAST such row per (area, indicator) — silently dropping the rest with no error
 * or warning, which read as a complete, correct single value rather than an arbitrary slice of
 * a bigger result (caught via real usage, not by any test here — see CLAUDE.md). Always
 * returning an array makes that shape impossible to misread as a scalar; check
 * indicatorsMeta[slug].isMultivariate/hasTimeseries to know whether >1 row here is expected. */
function pivotByArea(dataBySlug: DataBySlug) {
  const byArea = new Map<
    string,
    {
      areacd: string;
      areanm: string;
      indicators: Record<string, Omit<DataRow, "areacd" | "areanm">[]>;
    }
  >();
  for (const [slug, rows] of Object.entries(dataBySlug)) {
    for (const row of rows) {
      let entry = byArea.get(row.areacd);
      if (!entry) {
        entry = { areacd: row.areacd, areanm: row.areanm, indicators: {} };
        byArea.set(row.areacd, entry);
      }
      const rest = { ...row } as Partial<DataRow>;
      delete rest.areacd;
      delete rest.areanm;
      (entry.indicators[slug] ??= []).push(rest as Omit<DataRow, "areacd" | "areanm">);
    }
  }
  return [...byArea.values()];
}

function buildDownloadUrl(
  format: "csv" | "xlsx",
  params: Record<string, string | undefined>,
): string {
  const url = new URL(`${ELS_API_BASE_URL}/data.${format}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

// Verified against the live indicator catalogue (see next-steps.md step 4) — there is no plain
// "life expectancy" or "median household income" slug, only the sex-split/differently-named
// equivalents below. Re-check this list if the catalogue changes; a wrong slug here would
// silently show up as a coverage gap rather than an error, which is correct behaviour for the
// tool but still worth getting right at the source.
const AREA_HEADLINE_INDICATORS = [
  "population-count",
  "median-age",
  "employment-rate",
  "healthy-life-expectancy-female",
  "gross-disposable-household-income-per-head",
];

export function registerDataTools(server: McpServer): void {
  server.registerTool(
    "get_indicator_data",
    {
      title: "Get indicator data",
      description:
        "Fetch observation values for one or many indicators across one or many areas — the " +
        "general-purpose data tool, covering everything from a single indicator/single area " +
        "lookup to bulk pulls. Every response includes a `coverage` block stating what was " +
        "requested vs. what actually came back (including *why* a gap exists when known, e.g. " +
        "an indicator not covering a requested country) — always check it rather than assuming " +
        "an empty or partial result means something went wrong.\n\n" +
        "CHOOSING area_codes vs geo_type/geo_extent: for a specific area or short list (even a " +
        'single one), use area_codes=["E07000087"]. For every area of a given type (e.g. ' +
        '"every ltla in the South East"), use geo_type + geo_extent together: geo_type names ' +
        "the level to fetch, geo_extent is a parent area code that bounds it.\n\n" +
        'Set pivot="area" to get one row per area with one column per indicator (for ' +
        '"compare these areas across these indicators" questions) instead of the default ' +
        "indicator-grouped shape — each cell is an ARRAY of observation rows, not a single " +
        "value: usually length 1, but longer whenever the indicator is multivariate (one row " +
        "per dimension combination, e.g. sex x age — check " +
        "indicatorsMeta[slug].isMultivariate) or time spans more than one period " +
        "(indicatorsMeta[slug].hasTimeseries) — narrow with `dimensions` and/or a single `time` " +
        "value if you want exactly one row per cell. Set download_format to also get a matching " +
        "CSV/XLSX download URL. Raises an error if the request is too broad: at most one of " +
        "{indicator/topic, geography, time} may be " +
        'left unrestricted ("all") at once.',
      inputSchema: {
        indicators: z
          .array(z.string())
          .optional()
          .describe(
            'Indicator slug(s) (from search_indicators), e.g. ["population-count"]. Omit to ' +
              "fetch every indicator (optionally narrowed by topic).",
          ),
        topic: z
          .string()
          .optional()
          .describe("Topic or sub-topic slug (from list_topics) to filter by."),
        area_codes: z
          .array(z.string())
          .optional()
          .describe('Specific GSS area codes, e.g. ["E08000025"]. Not filtered by geo_extent.'),
        geo_type: z
          .string()
          .optional()
          .describe('Area-type code (e.g. "ltla" — see list_geo_levels) to fetch every area of.'),
        geo_extent: z
          .string()
          .optional()
          .describe("Parent area GSS code bounding geo_type to areas within it."),
        time: z
          .string()
          .default("latest")
          .describe(
            '"latest" (default), "earliest", "all", a year "YYYY", or a range "YYYY,YYYY".',
          ),
        dimensions: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional {dimension: value} filter for breakdowns on multivariate indicators, " +
              'e.g. {"sex": "female"} — get the valid dimension keys/values from ' +
              "get_indicator_metadata or an unfiltered call first. KNOWN LIMITATION: filtering " +
              "by more than one dimension at once currently returns zero rows (a live API " +
              "issue, not filtered correctly here) — filter by one dimension per call for now.",
          ),
        pivot: z
          .enum(["indicator", "area"])
          .default("indicator")
          .describe('"indicator" (default) groups by indicator; "area" gives one row per area.'),
        download_format: z
          .enum(["csv", "xlsx"])
          .optional()
          .describe("Also return a matching download URL."),
      },
    },
    async ({
      indicators,
      topic,
      area_codes,
      geo_type,
      geo_extent,
      time,
      dimensions,
      pivot,
      download_format,
    }) => {
      const guardError = checkBulkGuard({
        indicators,
        topic,
        areaCodes: area_codes,
        geoType: geo_type,
        geoExtent: geo_extent,
        time,
      });
      if (guardError) return errorResult(guardError);

      const upperAreaCodes = area_codes?.map(upperGss);
      const dataBySlug = await fetchDataRows({
        indicators,
        topic,
        areaCodes: upperAreaCodes,
        geoType: geo_type,
        geoExtent: geo_extent,
        time,
        dimensions,
      });

      // The API omits the key entirely for an indicator slug it doesn't recognise, and for one
      // that resolves but has no matching observations it includes an empty array — both are
      // "no data," not an error, but an explicitly-requested slug should still always appear in
      // the response so the shape never changes based on match count (see design doc).
      if (indicators) {
        for (const slug of indicators) {
          if (!(slug in dataBySlug)) dataBySlug[slug] = [];
        }
      }

      const allIndicators = await getAllIndicators();
      const metaBySlug = new Map(allIndicators.map((i) => [i.slug, i]));

      const coverage = buildCoverage({
        requestedIndicators: indicators,
        requestedAreaCodes: upperAreaCodes,
        indicatorMeta: metaBySlug,
        dataBySlug,
      });

      const downloadUrl = download_format
        ? buildDownloadUrl(download_format, {
            indicator: indicators?.join(","),
            topic,
            geo: [...(upperAreaCodes ?? []), geo_type].filter(Boolean).join(",") || undefined,
            geoExtent: geo_extent,
            time,
            includeNames: "true",
          })
        : undefined;

      if (pivot === "area") {
        return jsonResult({
          coverage,
          pivot: "area",
          areas: pivotByArea(dataBySlug),
          indicatorsMeta: Object.fromEntries(
            Object.keys(dataBySlug).map((slug) => [
              slug,
              indicatorMetadataBlock(metaBySlug.get(slug)),
            ]),
          ),
          downloadUrl,
        });
      }

      return jsonResult({
        coverage,
        indicators: Object.fromEntries(
          Object.entries(dataBySlug).map(([slug, rows]) => [
            slug,
            {
              metadata: indicatorMetadataBlock(metaBySlug.get(slug)),
              data: rows,
              comparison: buildComparisonNote(metaBySlug.get(slug), rows),
            },
          ]),
        ),
        downloadUrl,
      });
    },
  );

  server.registerTool(
    "rank_areas",
    {
      title: "Rank areas by indicator",
      description:
        "Rank areas by an indicator's value, e.g. \"which local authority has the highest " +
        'broadband coverage?" or "top 10 areas by unemployment rate in the South East". ' +
        "Returns BOTH ends of the sorted list (top and bottom top_n), not a single " +
        "desc/asc-selected end — read the indicator's own unit/label and direction_note to pick " +
        "the relevant end yourself, rather than guessing a sort direction up front.",
      inputSchema: {
        indicator_slug: z.string().describe("Indicator slug (from search_indicators)."),
        geo_type: z.string().describe('Area-type code to rank across, e.g. "ltla".'),
        geo_extent: z
          .string()
          .optional()
          .describe("Optional parent area GSS code to bound the ranking to."),
        time: z
          .string()
          .default("latest")
          .describe('"latest" (default) or a specific year "YYYY".'),
        top_n: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Areas per end to return (default 10)."),
      },
    },
    async ({ indicator_slug, geo_type, geo_extent, time, top_n }) => {
      if (time === "all") {
        return errorResult(
          "time='all' is not supported for ranking; use 'latest' or a specific year.",
        );
      }
      const meta = await getIndicatorBySlug(indicator_slug);
      const dataBySlug = await fetchDataRows({
        indicators: [indicator_slug],
        areaCodes: undefined,
        geoType: geo_type,
        geoExtent: geo_extent,
        time,
      });
      const rows = (dataBySlug[indicator_slug] ?? []).filter((r) => r.value !== null);
      const sorted = [...rows].sort((a, b) => (b.value as number) - (a.value as number));
      const n = top_n ?? 10;
      return jsonResult({
        unit: meta?.unit,
        label: meta?.label,
        direction_note: "Sorted descending by value; `top` is highest, `bottom` is lowest.",
        total_ranked: sorted.length,
        top: sorted.slice(0, n),
        bottom: sorted.slice(-n).reverse(),
      });
    },
  );

  server.registerTool(
    "rank_areas_by_change",
    {
      title: "Rank areas by change over time",
      description:
        'Rank areas by how much an indicator changed between two periods, e.g. "which areas ' +
        'grew fastest?" or "biggest fall in unemployment since 2015". Same top/bottom response ' +
        "shape as rank_areas.",
      inputSchema: {
        indicator_slug: z.string().describe("Indicator slug (from search_indicators)."),
        geo_type: z.string().describe('Area-type code to rank across, e.g. "ltla".'),
        geo_extent: z
          .string()
          .optional()
          .describe("Optional parent area GSS code to bound the ranking to."),
        start_time: z.string().describe('Start period, e.g. "2015".'),
        end_time: z.string().describe('End period, e.g. "2023".'),
        top_n: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Areas per end to return (default 10)."),
      },
    },
    async ({ indicator_slug, geo_type, geo_extent, start_time, end_time, top_n }) => {
      const meta = await getIndicatorBySlug(indicator_slug);
      const dataBySlug = await fetchDataRows({
        indicators: [indicator_slug],
        geoType: geo_type,
        geoExtent: geo_extent,
        time: `${start_time},${end_time}`,
      });
      const rows = dataBySlug[indicator_slug] ?? [];
      const byArea = new Map<string, { areanm: string; start?: number; end?: number }>();
      for (const row of rows) {
        if (row.value === null) continue;
        let entry = byArea.get(row.areacd);
        if (!entry) {
          entry = { areanm: row.areanm };
          byArea.set(row.areacd, entry);
        }
        if (row.period.startsWith(start_time)) entry.start = row.value;
        if (row.period.startsWith(end_time)) entry.end = row.value;
      }
      const changes = [...byArea.entries()]
        .filter(([, v]) => v.start !== undefined && v.end !== undefined)
        .map(([areacd, v]) => ({
          areacd,
          areanm: v.areanm,
          start_value: v.start,
          end_value: v.end,
          change: v.end! - v.start!,
          percent_change: v.start !== 0 ? ((v.end! - v.start!) / v.start!) * 100 : null,
        }))
        .sort((a, b) => b.change - a.change);
      const n = top_n ?? 10;
      return jsonResult({
        unit: meta?.unit,
        label: meta?.label,
        start_time,
        end_time,
        direction_note:
          "Sorted descending by absolute change; `top` grew/rose most, `bottom` fell most.",
        total_ranked: changes.length,
        top: changes.slice(0, n),
        bottom: changes.slice(-n).reverse(),
      });
    },
  );

  server.registerTool(
    "get_area_profile",
    {
      title: "Get area profile",
      description:
        'A curated default set of headline indicators for one area — answers "tell me about ' +
        'X" with a consistent, cheap response instead of guessing across 110+ indicators. Pass ' +
        "an explicit indicators list to override the default set.",
      inputSchema: {
        area_code: z.string().describe("GSS code of the area to profile."),
        indicators: z
          .array(z.string())
          .optional()
          .describe("Override the default headline indicator list."),
      },
    },
    async ({ area_code, indicators }) => {
      const slugs = indicators && indicators.length > 0 ? indicators : AREA_HEADLINE_INDICATORS;
      const areaCode = upperGss(area_code);
      const dataBySlug = await fetchDataRows({
        indicators: slugs,
        areaCodes: [areaCode],
        time: "latest",
      });
      for (const slug of slugs) if (!(slug in dataBySlug)) dataBySlug[slug] = [];
      const allIndicators = await getAllIndicators();
      const metaBySlug = new Map(allIndicators.map((i) => [i.slug, i]));
      const coverage = buildCoverage({
        requestedIndicators: slugs,
        requestedAreaCodes: [areaCode],
        indicatorMeta: metaBySlug,
        dataBySlug,
      });
      return jsonResult({
        area_code: areaCode,
        coverage,
        indicators: Object.fromEntries(
          Object.entries(dataBySlug).map(([slug, rows]) => [
            slug,
            { metadata: indicatorMetadataBlock(metaBySlug.get(slug)), data: rows },
          ]),
        ),
      });
    },
  );

  server.registerTool(
    "health",
    {
      title: "Health check",
      description: "Diagnostic tool confirming the MCP server is up and can reach the ELS API.",
      inputSchema: {},
    },
    async () => {
      const elsApiReachable = await elsGet("/metadata/taxonomy")
        .then(() => true)
        .catch(() => false);
      // Hardcoded, not derived — the SDK doesn't expose registered-tool count publicly. Keep in
      // sync with server.ts's registrations by hand (7 geography + 3 metadata + 4 data + health
      // = 15); the Python version had this exact off-by-one bug once (see git history: "fix
      // tool_count in health check").
      return jsonResult({ status: "ok", els_api_reachable: elsApiReachable, tool_count: 15 });
    },
  );
}
