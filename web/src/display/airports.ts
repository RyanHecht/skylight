// Bundled airport geometry, drawn at true geographic position so departures and
// arrivals visibly line up with the runways. Coordinates from OurAirports (KMCO).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  runways: Runway[];
}

export const MCO: Airport = {
  icao: "KMCO",
  name: "MCO",
  runways: [
    { leIdent: "17L", heIdent: "35R", le: [28.443701, -81.282600], he: [28.418900, -81.282303], widthFt: 150 },
    { leIdent: "17R", heIdent: "35L", le: [28.435600, -81.295898], he: [28.408100, -81.295601], widthFt: 150 },
    { leIdent: "18L", heIdent: "36R", le: [28.448299, -81.322304], he: [28.415300, -81.322000], widthFt: 200 },
    { leIdent: "18R", heIdent: "36L", le: [28.448299, -81.327003], he: [28.415300, -81.326599], widthFt: 200 },
  ],
};

/** Airports drawn on the map (currently just MCO; easy to extend). */
export const AIRPORTS: Airport[] = [MCO];
