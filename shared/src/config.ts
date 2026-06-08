// Central, fully-adjustable configuration for the ceiling tracker.
// This object is the single source of truth shared between the display
// (projector) and the control panel (phone). Everything here is live-tunable
// and persisted server-side so changes survive reboots.

import type {
  CameraLimits,
  GeoPoint,
  MountModel,
  TargetCriteria,
  TargetMode,
  ViscaUnitScale,
} from "./camera.js";
import type { FovPoint } from "./aim.js";

export type Theme = "ambient" | "telemetry" | "focus";
export type LabelDensity = "all" | "nearestN" | "nearestOnly";
export type DataSource = "radio" | "api";

export interface Palette {
  bg: string;
  glyph: string;
  trail: string;
  accent: string;
  warn: string;
  /** Range rings / compass ticks. */
  grid: string;
  /** Label / card text. */
  text: string;
}

export interface Fonts {
  label: string;
  mono: string;
}

export interface ShowFields {
  airline: boolean;
  flight: boolean;
  type: boolean;
  altitude: boolean;
  speed: boolean;
  verticalRate: boolean;
  destination: boolean;
  registration: boolean;
}

// --- PTZ camera tracker (roof camera that films the aircraft) ---

export interface TrackerConfig {
  /** Drive the real camera ("visca") or the software simulator ("sim"). */
  driver: "sim" | "visca";
  cameraIp: string;
  viscaPort: number;
  /** RTSP main stream (full quality, passed through untouched to the TV). */
  rtspUrl: string;
  /** RTSP substream (lower res) feeding the vision detector + MJPEG debug. */
  rtspSubUrl: string;
  /** Camera location — lat/lon + meters above the WGS84 ellipsoid. */
  site: GeoPoint;
  limits: CameraLimits;
  units: ViscaUnitScale;
  mount: MountModel;
  targetMode: TargetMode;
  target: TargetCriteria;
  predict: {
    /** ADS-B decode/transport latency beyond the fix's `seen` age, s. */
    adsbLatencySec: number;
    /**
     * Command-to-motion latency of the camera (UDP + firmware + accel ramp),
     * s. Folded into the aim lead so the setpoint trajectory is evaluated
     * where the plane will be when the command actually bites — the rate
     * feedforward then carries the right value for free.
     */
    motorLatencySec: number;
    /** Never extrapolate further than this. */
    maxLeadSec: number;
    /** Don't re-command moves smaller than this, deg. */
    deadbandDeg: number;
    /** Smoothed-setpoint command cadence, Hz. */
    commandHz: number;
    /** Alpha-beta filter constants for the setpoint tracker. */
    alpha: number;
    beta: number;
    /**
     * Pursuit style: "carrot" = speed-matched absolute moves toward a goal
     * slightly ahead (smoothest); "velocity" = closed-loop drive commands.
     */
    pursuit: "carrot" | "velocity";
    /** Carrot lead horizon, s, and re-issue cadence, ms. */
    carrotHorizonSec: number;
    carrotMs: number;
  };
  zoom: {
    auto: boolean;
    /** Estimated pointing sigma used for the zoom-out floor, deg. */
    sigmaDeg: number;
    /** Fraction of frame height the plane should fill. */
    fillFrac: number;
    /** HFOV used when auto is off, deg. */
    manualHfovDeg: number;
    /** Measured zoom-units -> HFOV samples (endpoints from the datasheet). */
    fovLut: FovPoint[];
  };
  vision: {
    /** Run the in-frame plane detector while tracking. */
    enabled: boolean;
    /** Close the loop: nudge the aim by the detected offset. */
    applyCorrection: boolean;
    /** Stay at full wide while searching (Phase B bring-up). */
    lockWide: boolean;
    /** Detector cadence, ms. */
    intervalMs: number;
    /**
     * Residual video latency BEFORE arrival at the tracker: exposure ->
     * camera encode -> RTSP -> ffmpeg decode -> pipe. (Arrival itself is
     * timestamped per frame; this covers only the unobservable part.)
     */
    encodeLagMs: number;
  };
  /** Idle "ready position" when auto mode has no target. */
  home: {
    enabled: boolean;
    /** "sfo" = aim along the bearing site->SFO; "fixed" = use azDeg. */
    mode: "sfo" | "fixed";
    azDeg: number;
    elDeg: number;
    /** Go home after this long without a target, s. */
    afterSec: number;
  };
}

/** Shallow-by-section patch for TrackerConfig (nested sections may be partial). */
export type TrackerConfigPatch = {
  [K in keyof TrackerConfig]?: TrackerConfig[K] extends object
    ? Partial<TrackerConfig[K]>
    : TrackerConfig[K];
};

export interface Config {
  // --- location & scope ---
  centerLat: number;
  centerLon: number;
  radiusMiles: number;

  // --- calibration (tune against a real overhead pass) ---
  /** Rotate the whole field, degrees. */
  rotationDeg: number;
  /** Horizontal flip for the looking-up problem. */
  mirrorX: boolean;
  /** Vertical flip (rarely needed; available for awkward mounts). */
  mirrorY: boolean;
  /** Rotate only the text labels (so they read right-side-up from where you
   *  lie), independent of the field rotation. Degrees. */
  labelRotationDeg: number;

  // --- filtering ---
  minAltitudeFt: number;
  maxAltitudeFt: number;
  hideOnGround: boolean;

  // --- motion ---
  /** Display interpolation toggle (server poll cadence is separate). */
  interpolate: boolean;
  maxExtrapolationSec: number;
  /**
   * Coast through radio dropouts: keep an aircraft gliding (dead-reckoned along
   * its last heading/speed) at full brightness for this many seconds after its
   * last fix. Smooths over a sporadic receiver that keeps losing and
   * re-acquiring planes, so they don't blink out and pop back. After the coast
   * window the glyph fades and is dropped at `staleSec`.
   */
  coastSec: number;
  staleSec: number;
  /** Ease factor toward each fresh fix (0 = snap, 1 = never move). */
  smoothing: number;
  /** Cap the render loop, frames per second. 0 = uncapped (use display
   *  refresh rate). Lower this to cut GPU/CPU load (and laptop fan noise). */
  maxFps: number;

  // --- visuals ---
  theme: Theme;
  palette: Palette;
  fonts: Fonts;
  glyphSizePx: number;
  /** Color the glyph by altitude. */
  altitudeColor: boolean;
  trailSeconds: number;
  /** Global brightness 0..1 (helps keep projector blacks deep). */
  brightness: number;

  // --- labels ---
  labelDensity: LabelDensity;
  nearestN: number;
  showFields: ShowFields;

  // --- overlays ---
  rangeRings: boolean;
  compass: boolean;
  highlightEmergency: boolean;
  /** Draw the airport (runways) at its true geographic position. */
  showAirport: boolean;
  /** Show the on-screen calibration HUD on the display. */
  showHud: boolean;

  // --- sky layer (sun / moon / stars / satellites at true positions) ---
  showStars: boolean;
  showSun: boolean;
  showMoon: boolean;
  showSatellites: boolean; // includes the ISS
  /** Faintest star magnitude to draw (higher = more stars). */
  starMagLimit: number;
  /** Offset the sky clock for testing/scrubbing, minutes (0 = live). */
  skyTimeOffsetMin: number;

  // --- "window to elsewhere" ---
  /** Faint great-circle arc toward each plane's destination. */
  showDestArc: boolean;
  /** Add destination local time + distance-to-go to labels. */
  showRouteDetail: boolean;

  // --- PTZ camera tracker ---
  tracker: TrackerConfig;
}

export const DEFAULT_CONFIG: Config = {
  // Default center: San Francisco International (SFO). Set this to your own
  // location — ideally where you'll be looking up at the ceiling.
  centerLat: 37.6213,
  centerLon: -122.379,
  radiusMiles: 3,

  rotationDeg: 0,
  mirrorX: true,
  mirrorY: false,
  labelRotationDeg: 0,

  minAltitudeFt: 100,
  maxAltitudeFt: 60000,
  hideOnGround: true,

  interpolate: true,
  maxExtrapolationSec: 5,
  coastSec: 12,
  staleSec: 20,
  smoothing: 0.18,
  maxFps: 0,

  theme: "ambient",
  palette: {
    bg: "#000000",
    glyph: "#E8ECFF",
    trail: "#6B7280",
    accent: "#9B7ECF",
    warn: "#FF5A47",
    grid: "#3A4256",
    text: "#AEB6C6",
  },
  fonts: {
    label: "Inter, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
  glyphSizePx: 22,
  altitudeColor: true,
  trailSeconds: 45,
  brightness: 1,

  labelDensity: "all",
  nearestN: 5,
  showFields: {
    airline: true,
    flight: true,
    type: true,
    altitude: true,
    speed: true,
    verticalRate: false,
    destination: true,
    registration: false,
  },

  rangeRings: true,
  compass: true,
  highlightEmergency: true,
  showAirport: true,
  showHud: false,

  showStars: true,
  showSun: true,
  showMoon: true,
  showSatellites: true,
  starMagLimit: 2.6,
  skyTimeOffsetMin: 0,

  showDestArc: true,
  showRouteDetail: true,

  tracker: {
    driver: "sim",
    cameraIp: "192.168.0.206", // factory default; updated at network bring-up
    viscaPort: 52381,
    rtspUrl: "rtsp://{ip}:554/live/av0",
    rtspSubUrl: "rtsp://{ip}:554/live/av1",
    // Default site = the display center; replace with the camera's real spot.
    site: { lat: 37.6213, lon: -122.379, altM: 0 },
    limits: {
      panMinDeg: -175,
      panMaxDeg: 175,
      tiltMinDeg: -90,
      tiltMaxDeg: 90,
      panSpeedMaxDps: 100,
      tiltSpeedMaxDps: 80,
    },
    // Placeholder VISCA scales — measured for real in bring-up milestone M4.
    units: {
      panUnitsPerDeg: 14.4,
      tiltUnitsPerDeg: 14.4,
      panZeroUnits: 0,
      tiltZeroUnits: 0,
      zoomWideUnits: 0,
      zoomTeleUnits: 16384,
    },
    mount: {
      panOffsetDeg: 0,
      tiltOffsetDeg: 0,
      panGain: 1,
      tiltGain: 1,
      levelTiltDeg: 0,
      levelDirDeg: 0,
    },
    targetMode: "overhead",
    target: {
      minElevationDeg: 12,
      maxRangeMi: 15,
      minAltFt: 500,
      hysteresisSec: 8,
      switchMargin: 0.15,
    },
    predict: {
      adsbLatencySec: 0.6,
      motorLatencySec: 0.2,
      maxLeadSec: 5,
      deadbandDeg: 0.05,
      commandHz: 15,
      alpha: 0.5,
      beta: 0.1,
      pursuit: "velocity",
      carrotHorizonSec: 1.5,
      carrotMs: 600,
    },
    zoom: {
      auto: true,
      sigmaDeg: 0.6,
      fillFrac: 0.28,
      manualHfovDeg: 20,
      // Datasheet endpoints; refined empirically at M4.
      fovLut: [
        { units: 0, hfovDeg: 62.3 },
        { units: 16384, hfovDeg: 3.46 },
      ],
    },
    vision: {
      enabled: true,
      applyCorrection: false,
      lockWide: true,
      intervalMs: 250,
      encodeLagMs: 350,
    },
    home: {
      enabled: true,
      mode: "sfo",
      azDeg: 120,
      elDeg: 15,
      afterSec: 10,
    },
  },
};

/**
 * Deep-merge a partial config onto a base, so persisted/partial payloads
 * never drop nested keys (palette, showFields, fonts, tracker sections).
 */
export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    palette: { ...base.palette, ...(patch.palette ?? {}) },
    fonts: { ...base.fonts, ...(patch.fonts ?? {}) },
    showFields: { ...base.showFields, ...(patch.showFields ?? {}) },
    tracker: mergeTrackerConfig(base.tracker, patch.tracker ?? {}),
  };
}

/** Deep-merge a tracker patch (each nested section may be partial). */
export function mergeTrackerConfig(
  base: TrackerConfig,
  patch: TrackerConfigPatch,
): TrackerConfig {
  return {
    ...base,
    ...patch,
    site: { ...base.site, ...(patch.site ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    units: { ...base.units, ...(patch.units ?? {}) },
    mount: { ...base.mount, ...(patch.mount ?? {}) },
    target: { ...base.target, ...(patch.target ?? {}) },
    predict: { ...base.predict, ...(patch.predict ?? {}) },
    zoom: { ...base.zoom, ...(patch.zoom ?? {}) },
    vision: { ...base.vision, ...(patch.vision ?? {}) },
    home: { ...base.home, ...(patch.home ?? {}) },
  } as TrackerConfig;
}
