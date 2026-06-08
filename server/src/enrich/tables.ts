// Static, instant enrichment from bundled tables. adsbdb (routes.ts) layers
// on top for anything these miss.

import airlines from "./airlines.json" with { type: "json" };
import airlinesIata from "./airlines-iata.json" with { type: "json" };
import types from "./types.json" with { type: "json" };

const AIRLINES = airlines as Record<string, string>;
const AIRLINES_IATA = airlinesIata as Record<string, string>;
const TYPES = types as Record<string, string>;

/** Map an ICAO type code (e.g. "B738") to a human name. */
export function lookupType(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return TYPES[code.toUpperCase()];
}

/**
 * Map a callsign to an airline name via its 3-letter ICAO prefix.
 * Only airline-style callsigns resolve; GA tail numbers (e.g. "N123AB") won't.
 */
export function lookupAirline(callsign: string | undefined): string | undefined {
  if (!callsign) return undefined;
  const cs = callsign.trim().toUpperCase();
  if (cs.length < 4) return undefined;
  const prefix = cs.slice(0, 3);
  // Airline callsigns are LLLdddd: 3 letters then a digit.
  if (!/^[A-Z]{3}$/.test(prefix) || !/\d/.test(cs[3])) return undefined;
  return AIRLINES[prefix];
}

/**
 * Best-effort IATA flight number from an ICAO airline callsign, by swapping the
 * 3-letter ICAO airline prefix for its 2-letter IATA code (e.g. "SWA2710" ->
 * "WN2710"). adsbdb's `callsign_iata` is authoritative and preferred; this is
 * the offline fallback for airlines in the bundled table. Returns undefined for
 * GA tail numbers or airlines we don't have an IATA mapping for.
 *
 * Note: the numeric suffix is assumed shared between the ICAO and IATA forms,
 * which holds for the vast majority of scheduled flights but not universally —
 * hence "best effort", used only when adsbdb has nothing.
 */
export function iataFlightFromCallsign(callsign: string | undefined): string | undefined {
  if (!callsign) return undefined;
  const cs = callsign.trim().toUpperCase();
  if (cs.length < 4) return undefined;
  const prefix = cs.slice(0, 3);
  if (!/^[A-Z]{3}$/.test(prefix) || !/\d/.test(cs[3])) return undefined;
  const iata = AIRLINES_IATA[prefix];
  if (!iata) return undefined;
  return iata + cs.slice(3);
}
