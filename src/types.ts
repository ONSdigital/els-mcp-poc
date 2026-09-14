/**
 * Shared domain types, confirmed against the live ELS API preview
 * (see docs/els-mcp-server-design.md and next-steps.md for the verification trail).
 */

/** One entry from /metadata/indicators (and the shape of /metadata/indicators/{slug}). */
export interface Indicator {
  slug: string;
  label: string;
  topic: string;
  subTopic: string;
  description?: string;
  subtitle?: string;
  unit?: string;
  source?: { name: string; href?: string; date?: string }[];
  caveats?: string[];
  updated?: string;
  dataModified?: string;
  metadataModified?: string;
  frequency?: string;
  periodFormat?: string;
  isMultivariate?: boolean;
  hasTimeseries?: boolean;
  /** Per-indicator, not per-row: whether this indicator's data rows carry lci_95/uci_95.
   * Confirmed live to appear on every /metadata/indicators list entry, not only the
   * single-indicator endpoint — get_indicator_data reads this from the cached catalogue rather
   * than sampling rows. */
  confidenceIntervals?: boolean;
  dimensions?: Record<string, { id: string; label: string; order: number }>;
  geography: {
    countries: string[];
    levels: string[];
    types: string[];
    year?: number;
    initialLevel?: string;
  };
}

/** One entry from /geo/levels. */
export interface GeoLevel {
  key: string;
  label: string;
  codes: string[];
}

/** One row from /geo/search/{query}. */
export interface AreaSearchResult {
  areacd: string;
  areanm: string;
  type: string;
}

/** One observation row from /data.rows.json. `period` is passed through exactly as the API
 * returns it — a single date for a point-in-time indicator, or an ISO 8601 interval (e.g.
 * "2023-01-01/P1Y") for a period-average one; never normalised, since collapsing a range to a
 * point would misrepresent what the figure covers. `lci_95`/`uci_95` are present only when the
 * indicator's own `confidenceIntervals` metadata is true — see get_indicator_data. */
export interface DataRow {
  areacd: string;
  areanm: string;
  period: string;
  value: number | null;
  lci_95?: number;
  uci_95?: number;
  /** Multivariate indicators (isMultivariate: true) add one extra column per dimension, e.g.
   * `sex`/`age` for population-by-age-and-sex — values are typically capitalised
   * ("Female", "0 to 4") even though the API's own dimension_{code} filter requires lower-case
   * input (confirmed live; not documented — see get_indicator_data). */
  [dimensionKey: string]: string | number | null | undefined;
}

/** What was asked for vs. what actually came back, for any tool that fetches indicator data.
 * Deliberately built around *what* is missing and *why* when known (a country, an area, an
 * indicator) rather than a bare count — a count alone can't surface a gap like
 * employment-rate/employment-rate-ni, which is the concrete case that motivated this field. */
export interface Coverage {
  requested: {
    indicators: string[];
    areas?: string[];
    countries?: string[];
  };
  returned: {
    indicators: string[];
    areas: string[];
    countries: string[];
  };
  missing: {
    type: "indicator" | "country" | "area";
    value: string;
    reason?: string;
  }[];
}
