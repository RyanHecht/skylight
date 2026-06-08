// Data acquisition: poll the active source (radio | api), normalize records
// into our Aircraft shape, enrich them, and emit snapshots. dump1090-fa and
// airplanes.live both use the readsb JSON schema, so one normalizer covers both.

import type { Aircraft, Config, DataSource } from "@shared/index.js";
import type { SourceStatus } from "@shared/index.js";
import { lookupAirline, lookupType, iataFlightFromCallsign } from "./enrich/tables.js";
import type { RouteEnricher } from "./enrich/routes.js";

/** Raw readsb-style aircraft record (subset we use). */
interface RawAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
  r?: string;
  t?: string;
  seen?: number;
  rssi?: number;
}

function normalize(raw: RawAircraft, ts: number): Aircraft | null {
  if (!raw.hex) return null;
  const onGround = raw.alt_baro === "ground";
  return {
    hex: raw.hex,
    flight: raw.flight?.trim() || undefined,
    lat: raw.lat,
    lon: raw.lon,
    altBaro: onGround ? null : (raw.alt_baro as number | undefined) ?? null,
    altGeom: raw.alt_geom ?? null,
    gs: raw.gs,
    track: raw.track,
    baroRate: raw.baro_rate ?? null,
    squawk: raw.squawk,
    category: raw.category,
    onGround,
    registration: raw.r,
    typeCode: raw.t,
    seen: raw.seen,
    rssi: raw.rssi,
    ts,
  };
}

const NM_PER_MILE = 0.868976;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * How the API supplements the radio when `supplementApi` is on.
 *
 * - "merge"  : full union by hex. The API can add aircraft your antenna never
 *              heard and can take over a fix once the radio's goes stale. Best
 *              for completeness (keeps landing aircraft alive).
 * - "fields" : the radio is the source of truth for *which* aircraft exist and
 *              *where* they are. The API only backfills fields the local
 *              receiver didn't decode (callsign, type, registration, …), which
 *              in turn unlocks route enrichment. No ghost aircraft, no API
 *              position takeover.
 */
export type SupplementMode = "merge" | "fields";

export interface PollerOptions {
  source: DataSource;
  /** dump1090 aircraft.json URL (radio source). */
  radioUrl: string;
  /** airplanes.live point template, {lat}/{lon}/{r} are filled from config. */
  apiUrlTemplate: string;
  pollMs: number;
  /** When source is "radio", also poll the API and merge (keeps landing
   *  aircraft alive when local ADS-B drops them). */
  supplementApi: boolean;
  /** Strategy for the supplement: union ("merge") vs radio-authoritative
   *  field backfill ("fields"). Only used when supplementApi is on. */
  supplementMode: SupplementMode;
  /** API poll cadence when supplementing (slower, to respect rate limits). */
  apiPollMs: number;
  getConfig: () => Config;
  enricher: RouteEnricher;
  onSnapshot: (now: number, aircraft: Aircraft[]) => void;
  onStatus: (status: SourceStatus) => void;
}

/**
 * Merge a primary (radio) list with a secondary (API) list by hex, preferring
 * whichever fix is fresher. Radio is biased a couple seconds so it wins while
 * it's tracking; the API takes over only once the radio fix goes stale.
 *
 * A positioned fix always beats a position-less one: indoors the radio often
 * decodes a plane's messages (altitude/velocity) but never a CPR position pair,
 * so the local record has no lat/lon. Without this guard that empty radio fix
 * would shadow the API's positioned fix and the plane would never draw.
 */
function mergeSources(radio: Aircraft[], api: Aircraft[]): Aircraft[] {
  const byHex = new Map<string, Aircraft>();
  for (const a of api) byHex.set(a.hex, a);
  for (const r of radio) {
    const existing = byHex.get(r.hex);
    if (!existing) {
      byHex.set(r.hex, r);
      continue;
    }
    const rHasPos = r.lat != null && r.lon != null;
    const aHasPos = existing.lat != null && existing.lon != null;
    if (rHasPos !== aHasPos) {
      byHex.set(r.hex, rHasPos ? r : existing);
      continue;
    }
    const rSeen = (r.seen ?? 0) - 2; // bias toward the local radio
    const aSeen = existing.seen ?? 999;
    byHex.set(r.hex, rSeen <= aSeen ? r : existing);
  }
  return [...byHex.values()];
}

/**
 * Radio-authoritative supplement. The radio list defines exactly which aircraft
 * appear and where they sit on the ceiling; the API is consulted only to fill
 * in non-positional fields the local receiver never decoded for a plane it *is*
 * already tracking. This is what lets routes show up for aircraft whose
 * callsign your antenna couldn't pull down (no callsign -> no route lookup),
 * without inventing ghost aircraft or letting the API nudge a fix off its true
 * radio position.
 *
 * Only `undefined` fields are filled (never `null`), so the on-ground altitude
 * sentinel and any other deliberate gaps from the radio survive untouched.
 */
function supplementFields(radio: Aircraft[], api: Aircraft[]): Aircraft[] {
  const apiByHex = new Map<string, Aircraft>();
  for (const a of api) apiByHex.set(a.hex, a);
  for (const r of radio) {
    const a = apiByHex.get(r.hex);
    if (!a) continue;
    // Identity / metadata the radio may have missed (these unlock enrichment).
    r.flight ??= a.flight;
    r.registration ??= a.registration;
    r.typeCode ??= a.typeCode;
    r.category ??= a.category;
    r.squawk ??= a.squawk;
    // Kinematics that are plain "missing" (not the null ground sentinel).
    r.gs ??= a.gs;
    r.track ??= a.track;
    // Note: lat/lon are intentionally NOT filled — radio owns position.
  }
  return radio;
}

/** Enrichment we've resolved for an aircraft, kept sticky for its session. */
interface StickyEnrichment {
  /** Last callsign decoded for this hex. Kept so an intermittent receiver that
   *  drops the callsign field mid-track still resolves (and keeps) its route:
   *  the adsbdb lookup is keyed on callsign, so without this a route fetched
   *  just after the callsign flickered out would be stranded uncached-to-hex. */
  flight?: string;
  flightIata?: string;
  typeName?: string;
  airline?: string;
  origin?: string;
  destination?: string;
  registration?: string;
  originName?: string;
  destName?: string;
  originLat?: number;
  originLon?: number;
  destLat?: number;
  destLon?: number;
  lastSeen: number;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private apiTimer: ReturnType<typeof setInterval> | null = null;
  private status: SourceStatus;
  private last: Aircraft[] = [];
  /** Most recent API snapshot, used to supplement the radio. */
  private lastApi: Aircraft[] = [];
  /** hex -> last good enrichment, so resolved routes never flicker back to "—". */
  private sticky = new Map<string, StickyEnrichment>();

  constructor(private o: PollerOptions) {
    this.status = {
      source: o.source,
      ok: false,
      count: 0,
      lastOk: null,
    };
  }

  getSnapshot(): { now: number; aircraft: Aircraft[] } {
    return { now: Date.now(), aircraft: this.last };
  }
  getStatus(): SourceStatus {
    return this.status;
  }
  setSource(source: DataSource): void {
    this.o.source = source;
    this.status.source = source;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    if (this.o.supplementApi) {
      void this.refreshApi();
      this.apiTimer = setInterval(() => void this.refreshApi(), this.o.apiPollMs);
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.apiTimer) clearInterval(this.apiTimer);
    this.timer = null;
    this.apiTimer = null;
  }

  private async fetchList(source: DataSource, now: number): Promise<Aircraft[] | null> {
    try {
      const url = source === "radio" ? this.o.radioUrl : this.buildApiUrl();
      const json = await fetchJson(url);
      const rawList: RawAircraft[] = json.aircraft ?? json.ac ?? [];
      const list: Aircraft[] = [];
      for (const raw of rawList) {
        const ac = normalize(raw, now);
        if (ac) list.push(ac);
      }
      return list;
    } catch {
      return null;
    }
  }

  private async refreshApi(): Promise<void> {
    const list = await this.fetchList("api", Date.now());
    if (list) this.lastApi = list;
  }

  private buildApiUrl(): string {
    const c = this.o.getConfig();
    const r = Math.min(250, Math.ceil(c.radiusMiles * NM_PER_MILE) + 1);
    return this.o.apiUrlTemplate
      .replace("{lat}", String(c.centerLat))
      .replace("{lon}", String(c.centerLon))
      .replace("{r}", String(r));
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const primary = await this.fetchList(this.o.source, now);
    if (primary === null) {
      this.status = { ...this.status, ok: false, message: "source fetch failed" };
      this.o.onStatus(this.status);
      return;
    }
    const supplement = this.o.source === "radio" && this.o.supplementApi;
    const fieldsMode = supplement && this.o.supplementMode === "fields";
    let merged: Aircraft[];
    if (!supplement) {
      merged = primary;
    } else if (fieldsMode) {
      merged = supplementFields(primary, this.lastApi);
    } else {
      merged = mergeSources(primary, this.lastApi);
    }
    for (const ac of merged) this.enrich(ac, now);
    this.last = merged;
    this.pruneSticky(now);
    this.status = {
      source: this.o.source,
      ok: true,
      count: merged.length,
      lastOk: now,
      message: supplement
        ? fieldsMode
          ? `radio (+API fields from ${this.lastApi.length})`
          : `radio + ${this.lastApi.length} via API`
        : undefined,
    };
    this.o.onSnapshot(now, merged);
    this.o.onStatus(this.status);
  }

  private enrich(ac: Aircraft, now: number): void {
    const prev = this.sticky.get(ac.hex);

    // Keep the last-known callsign for this hex. An intermittent receiver often
    // decodes a plane's position on one sweep but drops the callsign field on
    // the next; without this the route (looked up by callsign, asynchronously)
    // could resolve into the cache yet never get re-attached. Restoring it also
    // stops the flight label from flickering between the callsign and blank.
    ac.flight = ac.flight ?? prev?.flight;

    // Instant table lookups first.
    ac.typeName = lookupType(ac.typeCode);
    ac.airline = lookupAirline(ac.flight);

    // adsbdb fills gaps (route + better type), from cache when available.
    const e = this.o.enricher.enrichSync(ac.hex, ac.flight, now);
    if (e.route) {
      ac.airline = ac.airline ?? e.route.airline;
      ac.flightIata = ac.flightIata ?? e.route.callsignIata;
      ac.origin = e.route.origin ?? ac.origin;
      ac.destination = e.route.destination ?? ac.destination;
      ac.originName = e.route.originName ?? ac.originName;
      ac.destName = e.route.destName ?? ac.destName;
      ac.originLat = e.route.originLat ?? ac.originLat;
      ac.originLon = e.route.originLon ?? ac.originLon;
      ac.destLat = e.route.destLat ?? ac.destLat;
      ac.destLon = e.route.destLon ?? ac.destLon;
    }
    if (e.aircraft) {
      ac.typeName = ac.typeName ?? e.aircraft.typeName;
      ac.registration = ac.registration ?? e.aircraft.registration;
    }

    // Fall back to a table-derived IATA flight number when adsbdb had none.
    ac.flightIata = ac.flightIata ?? iataFlightFromCallsign(ac.flight);

    // Sticky merge: once we've resolved something for this hex, never drop it
    // back to undefined on a later snapshot (prevents label flicker).
    ac.flightIata = ac.flightIata ?? prev?.flightIata;
    ac.typeName = ac.typeName ?? prev?.typeName;
    ac.airline = ac.airline ?? prev?.airline;
    ac.origin = ac.origin ?? prev?.origin;
    ac.destination = ac.destination ?? prev?.destination;
    ac.registration = ac.registration ?? prev?.registration;
    ac.originName = ac.originName ?? prev?.originName;
    ac.destName = ac.destName ?? prev?.destName;
    ac.originLat = ac.originLat ?? prev?.originLat;
    ac.originLon = ac.originLon ?? prev?.originLon;
    ac.destLat = ac.destLat ?? prev?.destLat;
    ac.destLon = ac.destLon ?? prev?.destLon;
    this.sticky.set(ac.hex, {
      flight: ac.flight,
      flightIata: ac.flightIata,
      typeName: ac.typeName,
      airline: ac.airline,
      origin: ac.origin,
      destination: ac.destination,
      registration: ac.registration,
      originName: ac.originName,
      destName: ac.destName,
      originLat: ac.originLat,
      originLon: ac.originLon,
      destLat: ac.destLat,
      destLon: ac.destLon,
      lastSeen: now,
    });
  }

  /** Drop sticky entries for aircraft long gone (keep the map small). */
  private pruneSticky(now: number): void {
    for (const [hex, s] of this.sticky) {
      if (now - s.lastSeen > 600_000) this.sticky.delete(hex);
    }
  }
}
