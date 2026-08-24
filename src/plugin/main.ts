/// <reference path="./openrct2.d.ts" />

/**
 * rct2-agent plugin (intransient).
 *
 * Opens a localhost TCP listener and answers newline-delimited JSON requests
 * from the MCP server. All game access happens on the main thread inside the
 * socket data callback, so reads and game actions are safe to call directly.
 *
 * Direction: the plugin LISTENS, the server dials in. The plugin is long-lived
 * (intransient), so the port is stable across park loads; the server reconnects.
 */

import {
  COORDS_Z_STEP,
  DEFAULT_PORT,
  LAND_STEP_Z,
  MONEY_FACTOR,
  Methods,
  type RpcRequest,
  type RpcResponse,
} from "../shared/protocol";

const PORT = DEFAULT_PORT;
const TILE = 32; // map units per tile

type Respond = (result: unknown) => void;
type Fail = (message: string) => void;
type Handler = (params: Record<string, unknown>, ok: Respond, fail: Fail) => void;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function money(dollars: number): number {
  return Math.round(dollars * MONEY_FACTOR);
}
function dollars(internal: number): number {
  return Math.round((internal / MONEY_FACTOR) * 100) / 100;
}
function rating2dp(v: number): number {
  return Math.round(v) / 100;
}
function num(params: Record<string, unknown>, key: string, dflt?: number): number {
  const v = params[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  if (dflt !== undefined) return dflt;
  throw new Error(`missing or invalid number param: ${key}`);
}
function str(params: Record<string, unknown>, key: string, dflt?: string): string {
  const v = params[key];
  if (typeof v === "string") return v;
  if (dflt !== undefined) return dflt;
  throw new Error(`missing or invalid string param: ${key}`);
}
function bool(params: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = params[key];
  if (typeof v === "boolean") return v;
  return dflt;
}

function execAction(action: ActionType, args: object): Promise<GameActionResult> {
  return new Promise((resolve, reject) => {
    context.executeAction(action as any, args as any, (res: GameActionResult) => {
      if (res.error && res.error !== 0) {
        reject(new Error(res.errorMessage || res.errorTitle || `action ${action} failed (code ${res.error})`));
      } else {
        resolve(res);
      }
    });
  });
}

function clockInfo() {
  const d = date;
  const monthNames = [
    "March", "April", "May", "June", "July", "August", "September", "October",
  ];
  return {
    day: d.day,
    month: d.month,
    monthName: monthNames[d.month] ?? String(d.month),
    year: d.year,
    monthsElapsed: d.monthsElapsed,
    ticksElapsed: d.ticksElapsed,
    gameSpeed: context.gameSpeed,
    paused: context.paused,
  };
}

// --- tiles & footpaths -----------------------------------------------------

interface TileCoord {
  x: number;
  y: number;
  z?: number;
  direction?: number;
  /** Tile a footpath must occupy to connect here. Entrances/exits only. */
  connectAt?: { x: number; y: number; z: number };
}

/**
 * Tile offsets per direction, matching OpenRCT2's CoordsDirectionDelta:
 * 0 = -X, 1 = +Y, 2 = +X, 3 = -Y.
 */
const DIRECTION_DELTA = [
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: -1 },
];

/**
 * Convert a game CoordsXY(ZD) to tile coordinates, keeping z in world units.
 * Unbuilt ride entrances/exits come back as a null-ish sentinel; report null.
 */
function tileCoords(c: CoordsXY | CoordsXYZ | CoordsXYZD | null | undefined): TileCoord | null {
  if (!c) return null;
  // 0x8000 is the "location null" sentinel used throughout the game.
  if (c.x === null || c.x === undefined || (c.x & 0xffff) === 0x8000) return null;
  if (c.x < 0 || c.y < 0) return null;
  const out: TileCoord = {
    x: Math.floor(c.x / TILE),
    y: Math.floor(c.y / TILE),
  };
  if ("z" in c && typeof (c as CoordsXYZ).z === "number") out.z = (c as CoordsXYZ).z;
  if ("direction" in c && typeof (c as CoordsXYZD).direction === "number") {
    out.direction = (c as CoordsXYZD).direction;
  }
  return out;
}

/**
 * The tile a footpath has to sit on to reach a ride entrance or exit.
 *
 * An entrance element's `direction` points INTO the ride, so the guest-facing
 * tile is the one opposite it, at the entrance's own height. Callers should
 * build here rather than re-deriving the direction convention.
 */
function apronTile(x: number, y: number, z: number, direction: number) {
  const d = DIRECTION_DELTA[(direction + 2) & 3];
  return { x: x + d.dx, y: y + d.dy, z };
}

/** tileCoords plus the apron tile, for ride entrances and exits. */
function accessCoords(c: CoordsXYZD | null | undefined): TileCoord | null {
  const t = tileCoords(c);
  if (!t || t.z === undefined || t.direction === undefined) return t;
  t.connectAt = apronTile(t.x, t.y, t.z, t.direction);
  return t;
}

function surfaceOf(tile: Tile): SurfaceElement | null {
  for (const el of tile.elements) {
    if (el.type === "surface") return el as SurfaceElement;
  }
  return null;
}

/**
 * World z of the ground at a tile. A footpath laid flat on the ground shares
 * the surface element's base z; on a sloped surface that is the low corner.
 */
function groundZ(tile: Tile): number | null {
  const surf = surfaceOf(tile);
  return surf ? surf.baseZ : null;
}

/**
 * World z of the HIGHEST corner of a tile's surface. Surface slope bits 0-3
 * mark raised corners and bit 4 marks a double-height ("steep") slope, each
 * worth one land step. A flat path on sloping ground has to sit up here;
 * baseZ (the low corner) is only valid for a path sloped to match.
 */
const SURFACE_SLOPE_CORNERS = 0x0f;
const SURFACE_SLOPE_STEEP = 0x10;
function surfaceTopZ(surf: SurfaceElement): number {
  let z = surf.baseZ;
  if (surf.slope & SURFACE_SLOPE_CORNERS) z += LAND_STEP_Z;
  if (surf.slope & SURFACE_SLOPE_STEEP) z += LAND_STEP_Z;
  return z;
}

/** Direction labels matching DIRECTION_DELTA: 0 = -X, 1 = +Y, 2 = +X, 3 = -Y. */
const DIRECTION_LABEL = ["-X", "+Y", "+X", "-Y"];

/**
 * World z of each of a path tile's four edges, indexed by direction.
 *
 * A flat path presents its own baseZ on all four sides. A sloped path rises one
 * land level toward `slopeDirection`, so that side sits a level up while the
 * opposite side stays at baseZ. The two perpendicular sides are mid-slope and
 * the game never connects through them, so they come back null -- "no edge to
 * meet here", as distinct from an edge that happens to sit at z 0.
 *
 * Two neighbouring paths connect only when the edges they turn to each other
 * are both non-null and exactly equal.
 */
function pathEdgeZ(baseZ: number, slopeDirection: number | null | undefined): Array<number | null> {
  if (slopeDirection === null || slopeDirection === undefined) {
    return [baseZ, baseZ, baseZ, baseZ];
  }
  const d = slopeDirection & 3;
  const edges: Array<number | null> = [null, null, null, null];
  edges[d] = baseZ + LAND_STEP_Z;
  edges[(d + 2) & 3] = baseZ;
  return edges;
}

/** pathEdgeZ keyed by direction label, so readers never do index arithmetic. */
function edgeZLabelled(baseZ: number, slopeDirection: number | null | undefined) {
  const out: Record<string, number | null> = {};
  const e = pathEdgeZ(baseZ, slopeDirection);
  for (let d = 0; d < 4; d++) out[DIRECTION_LABEL[d]] = e[d];
  return out;
}

/** A height difference said in the units routes are actually built in. */
function levelsApart(diff: number): string {
  const n = Math.abs(diff) / LAND_STEP_Z;
  if (n !== Math.floor(n)) return `${Math.abs(diff)} z units`;
  return `${n} land level${n === 1 ? "" : "s"}`;
}

/**
 * What the path at (x,y,z) actually touches -- and what it only appears to.
 *
 * A footpath's own `edges` bitmask answers the first half, after the fact and
 * as a bitmask. It says nothing about the second: a path one land level off its
 * neighbour reads as a continuous route from above and is not walkable. Naming
 * those near misses at placement time is the whole point, because otherwise the
 * break surfaces many tiles later, if at all.
 */
function connectivityAt(x: number, y: number, z: number) {
  let found: FootpathElement | null = null;
  for (const el of map.getTile(x, y).elements) {
    if (el.type === "footpath" && el.baseZ === z) { found = el as FootpathElement; break; }
  }
  if (!found) return null;
  const me = found;

  const mySlope = me.slopeDirection;
  const myEdges = pathEdgeZ(me.baseZ, mySlope);
  const connectedTo: Array<Record<string, unknown>> = [];
  const notConnected: Array<Record<string, unknown>> = [];

  for (let d = 0; d < 4; d++) {
    const nx = x + DIRECTION_DELTA[d].dx;
    const ny = y + DIRECTION_DELTA[d].dy;
    if (nx < 0 || ny < 0 || nx >= map.size.x || ny >= map.size.y) continue;
    const side = DIRECTION_LABEL[d];
    const myEdge = myEdges[d];
    const opp = (d + 2) & 3;

    for (const el of map.getTile(nx, ny).elements) {
      if (el.type === "footpath") {
        const f = el as FootpathElement;
        const kind = f.isQueue ? "queue" : "footpath";
        const theirEdge = pathEdgeZ(f.baseZ, f.slopeDirection)[opp];
        const who: Record<string, unknown> = { x: nx, y: ny, side, direction: d, z: f.baseZ, type: kind };
        if (f.isQueue) who.ride = f.ride;

        if (myEdge !== null && theirEdge !== null && myEdge === theirEdge) {
          connectedTo.push(who);
        } else if (myEdge === null) {
          who.reason = `this tile slopes toward ${DIRECTION_LABEL[(mySlope as number) & 3]}, so its ${side} side is mid-slope; a sloped path connects only at the two ends of its slope`;
          notConnected.push(who);
        } else if (theirEdge === null) {
          who.reason = `the ${kind} at (${nx},${ny}) slopes toward ${DIRECTION_LABEL[(f.slopeDirection as number) & 3]}, so the side it turns to this tile is mid-slope and cannot connect`;
          notConnected.push(who);
        } else {
          who.reason = `height mismatch: this tile's ${side} edge is at z=${myEdge}, but the ${kind} at (${nx},${ny}) presents z=${theirEdge} on the facing side (${levelsApart(theirEdge - myEdge)} ${theirEdge > myEdge ? "higher" : "lower"}). Adjacent from above; guests cannot walk between them.`;
          who.connectAtZ = theirEdge - (mySlope === d ? LAND_STEP_Z : 0);
          notConnected.push(who);
        }
      } else if (el.type === "entrance") {
        const e = el as EntranceElement;
        const apron = apronTile(nx, ny, e.baseZ, e.direction);
        // An entrance faces exactly one tile; skip the ones facing elsewhere.
        if (apron.x !== x || apron.y !== y) continue;
        const role = entranceRole(e, nx, ny);
        const label = role === "park" ? "park entrance" : `ride ${role}`;
        const who: Record<string, unknown> = {
          x: nx, y: ny, side, direction: d, z: e.baseZ,
          type: role === "park" ? "park_entrance" : `ride_${role}`,
          ride: e.ride,
        };
        // An entrance takes a flat path at exactly its own z; a ramp will not do.
        if (mySlope === null && me.baseZ === e.baseZ) {
          connectedTo.push(who);
        } else {
          who.reason = mySlope !== null
            ? `the ${label} at (${nx},${ny}) needs a FLAT path on this tile at z=${e.baseZ}; this tile is sloped`
            : `the ${label} at (${nx},${ny}) connects only at z=${e.baseZ}; this tile sits at z=${me.baseZ}`;
          who.connectAtZ = e.baseZ;
          notConnected.push(who);
        }
      }
    }
  }

  return { edgeZ: edgeZLabelled(me.baseZ, mySlope), connectedTo, notConnected };
}

/**
 * Game actions refuse to run while the game is paused, and the agent's loop
 * leaves it paused (advance_days auto-pauses). Lift the pause for the duration
 * of a build action and put it back afterwards; the action resolves within the
 * same tick, so no game time passes.
 */
function unpauseFor(): () => void {
  const wasPaused = context.paused;
  if (wasPaused) context.paused = false;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (wasPaused) context.paused = true;
  };
}

/**
 * Footpath objects come in two generations. New-style (NSF) parks split a path
 * into a surface object plus a railings object; legacy parks use a single
 * "footpath" object and need the legacy bit set in constructFlags.
 */
const PATH_FLAG_QUEUE = 1 << 0;
const PATH_FLAG_LEGACY = 1 << 1;

interface PathStyle {
  legacy: boolean;
  object: number;
  railingsObject: number;
}

function pathStyleList(queue: boolean): PathStyle[] {
  const out: PathStyle[] = [];
  const surfaces = objectManager.getAllObjects("footpath_surface") || [];
  if (surfaces.length > 0) {
    const railings = objectManager.getAllObjects("footpath_railings") || [];
    const railIndex = railings.length > 0 ? railings[0].index : 0;
    for (const sfc of surfaces) {
      if (isQueueSurface(sfc) !== queue) continue;
      out.push({ legacy: false, object: sfc.index, railingsObject: railIndex });
    }
    if (out.length > 0) return out;
  }
  // legacy fallback: single combined object, railings unused.
  const legacy = objectManager.getAllObjects("footpath") || [];
  for (const obj of legacy) {
    out.push({ legacy: true, object: obj.index, railingsObject: 0 });
  }
  return out;
}

/**
 * Queue surfaces are flagged by the object; older/DAT-derived objects do not
 * always set it, so fall back to the localised name.
 */
const FOOTPATH_SURFACE_FLAG_IS_QUEUE = 1 << 3; // FOOTPATH_ENTRY_FLAG_IS_QUEUE
function isQueueSurface(sfc: FootpathSurfaceObject): boolean {
  if ((sfc.flags & FOOTPATH_SURFACE_FLAG_IS_QUEUE) !== 0) return true;
  return sfc.name.toLowerCase().indexOf("queue") >= 0;
}

/** Resolve the style to build with, honouring an explicit object index. */
function resolvePathStyle(
  explicitObject: number | undefined,
  explicitRailings: number | undefined,
  queue: boolean,
): PathStyle {
  const styles = pathStyleList(queue);
  if (styles.length === 0) {
    throw new Error(
      `no ${queue ? "queue" : "footpath"} objects are loaded in this park; call list_path_styles`,
    );
  }
  const chosen = explicitObject === undefined
    ? styles[0]
    : { legacy: styles[0].legacy, object: explicitObject, railingsObject: styles[0].railingsObject };
  if (explicitRailings !== undefined) chosen.railingsObject = explicitRailings;
  return chosen;
}

/**
 * A tile can carry water and still be buildable: on a shoreline the surface's
 * high corner reaches the waterline or above, and a path can sit on it -- the
 * game allows a path level with the water, so only water strictly above the
 * high corner puts the tile out of reach.
 */
function isSubmerged(surf: SurfaceElement | null): boolean {
  return !!surf && surf.waterHeight > 0 && surf.waterHeight > surfaceTopZ(surf);
}

/**
 * An entrance element covers ride entrances, ride exits and the park entrance
 * alike, and the plugin API exposes no type field. Work it out by asking the
 * ride whether this tile is its station's entrance or its exit.
 */
function entranceRole(e: EntranceElement, x: number, y: number): string {
  let r: Ride | null = null;
  try {
    r = e.ride === null || e.ride === undefined ? null : map.getRide(e.ride);
  } catch (_err) {
    r = null;
  }
  if (!r) return "park";
  const stations = r.stations || [];
  const st = e.station === null || e.station === undefined ? null : stations[e.station];
  if (!st) return "unknown";
  const en = tileCoords(st.entrance);
  if (en && en.x === x && en.y === y) return "entrance";
  const ex = tileCoords(st.exit);
  if (ex && ex.x === x && ex.y === y) return "exit";
  return "unknown";
}

/**
 * Whether a footpath actually reaches an apron tile, and if not, why. Height
 * matters as much as position: a path on the right tile at the wrong z does
 * not connect. Blocker reporting is a hint -- place_path's own query is the
 * authority on whether a given tile will take a path.
 */
function apronStatus(a: { x: number; y: number; z: number }) {
  const tile = map.getTile(a.x, a.y);
  const surf = surfaceOf(tile);
  if (!surf) return { connected: false, status: "off_map", detail: `no ground at (${a.x},${a.y})` };

  const paths: FootpathElement[] = [];
  for (const el of tile.elements) {
    if (el.type === "footpath") paths.push(el as FootpathElement);
  }
  for (const f of paths) {
    if (f.baseZ === a.z) {
      return {
        connected: true,
        status: "connected",
        detail: `${f.isQueue ? "queue" : "footpath"} present at z=${a.z}`,
        isQueue: f.isQueue,
        // The game binds a queue to the ride it serves; a bound queue is the
        // engine confirming the connection rather than us inferring it.
        queueBoundToRide: f.isQueue ? f.ride : null,
      };
    }
  }
  if (paths.length > 0) {
    return {
      connected: false, status: "wrong_height",
      detail: `path here at z ${paths.map((f) => f.baseZ).join(", ")}, but this entrance needs z=${a.z}`,
    };
  }
  if (!surf.hasOwnership && !surf.hasConstructionRights) {
    return { connected: false, status: "unowned", detail: `land at (${a.x},${a.y}) is not owned` };
  }
  if (isSubmerged(surf)) {
    return { connected: false, status: "under_water", detail: `(${a.x},${a.y}) is under water` };
  }
  const blockers: string[] = [];
  for (const el of tile.elements) {
    const t = el.type;
    if (t === "small_scenery" || t === "large_scenery" || t === "wall" || t === "track" || t === "entrance") {
      if (blockers.indexOf(t) < 0) blockers.push(t);
    }
  }
  if (blockers.length > 0) {
    return {
      connected: false, status: "blocked",
      detail: `(${a.x},${a.y}) is occupied by ${blockers.join(", ")}; clear it or move the entrance`,
    };
  }
  return {
    connected: false, status: "no_path",
    detail: `nothing at (${a.x},${a.y}); place a path there at z=${a.z}`,
  };
}

// One char per tile for the ASCII overview in inspect_area.
function tileGlyph(tile: Tile, surf: SurfaceElement | null): string {
  let glyph = ".";
  let sawPath = false;
  for (const el of tile.elements) {
    switch (el.type) {
      case "footpath":
        // queue lines are worth distinguishing; they cannot be walked freely.
        glyph = (el as FootpathElement).isQueue ? "Q" : "P";
        sawPath = true;
        break;
      case "track":
        if (!sawPath) glyph = "T";
        break;
      case "entrance":
        glyph = "E";
        sawPath = true; // entrances outrank scenery in the overview
        break;
      case "small_scenery":
      case "large_scenery":
        if (!sawPath && glyph === ".") glyph = "s";
        break;
      case "wall":
        if (!sawPath && glyph === ".") glyph = "w";
        break;
    }
  }
  if (glyph === "." && isSubmerged(surf)) glyph = "~";
  if (surf && !surf.hasOwnership && !surf.hasConstructionRights) {
    // unowned land cannot be built on at all; flag it over anything else.
    return glyph === "." ? "x" : glyph.toLowerCase();
  }
  return glyph;
}

// ride classification -> our buckets. stalls/facilities are "shops".
function isShop(r: Ride): boolean {
  return r.classification === "stall" || r.classification === "facility";
}

function rideSummary(r: Ride) {
  const primaryPrice = r.price && r.price.length > 0 ? dollars(r.price[0]) : 0;
  const queueTime = r.stations && r.stations.length > 0 ? r.stations[0].queueTime : 0;
  return {
    id: r.id,
    name: r.name,
    classification: r.classification,
    status: r.status,
    price: primaryPrice,
    excitement: r.excitement >= 0 ? rating2dp(r.excitement) : null,
    intensity: r.intensity >= 0 ? rating2dp(r.intensity) : null,
    nausea: r.nausea >= 0 ? rating2dp(r.nausea) : null,
    queueTimeMinutes: queueTime,
    incomePerHour: dollars(r.incomePerHour),
    totalProfit: dollars(r.totalProfit),
    totalCustomers: r.totalCustomers,
    satisfaction: r.satisfaction >= 0 ? r.satisfaction : null,
    reliability: r.reliability,
    downtime: r.downtime,
    breakdown: r.breakdown,
    inspectionInterval: r.inspectionInterval,
    ageMonths: r.age,
  };
}

/**
 * Rides carry a fixed-size station array (255 slots) with only the first few
 * ever built. Emit just the real ones -- otherwise a single-station ride
 * reports 254 empty objects.
 */
function realStations(r: Ride): Array<{ index: number; station: RideStation }> {
  const out: Array<{ index: number; station: RideStation }> = [];
  const stations = r.stations || [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (s && s.start && tileCoords(s.start)) out.push({ index: i, station: s });
  }
  return out;
}

/** First built station, for centring a view or reporting a ride's location. */
function primaryStation(r: Ride): RideStation | null {
  const real = realStations(r);
  return real.length > 0 ? real[0].station : null;
}

function rideDetail(r: Ride) {
  return {
    ...rideSummary(r),
    type: r.type,
    object: r.object ? r.object.name : null,
    runningCost: dollars(r.runningCost),
    value: dollars(r.value),
    mode: r.mode,
    minWaitingTime: r.minimumWaitingTime,
    maxWaitingTime: r.maximumWaitingTime,
    liftHillSpeed: r.liftHillSpeed,
    prices: (r.price || []).map((p) => dollars(p)),
    // Only built stations. Tile coords are for connecting footpaths;
    // entrance/exit stay null until that piece is built.
    stations: realStations(r).map(({ index, station }) => ({
      index,
      queueTimeMinutes: station.queueTime,
      start: tileCoords(station.start),
      entrance: accessCoords(station.entrance),
      exit: accessCoords(station.exit),
    })),
  };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

const handlers: Record<string, Handler> = {};

handlers[Methods.Ping] = (_p, ok) => {
  ok({ pong: true, apiVersion: context.apiVersion, mode: network.mode, ...clockInfo() });
};

// --- read: state -----------------------------------------------------------

handlers[Methods.GetParkSummary] = (_p, ok) => {
  ok({
    name: park.name,
    cash: dollars(park.cash),
    loan: dollars(park.bankLoan),
    maxLoan: dollars(park.maxBankLoan),
    parkValue: dollars(park.value),
    companyValue: dollars(park.companyValue),
    rating: park.rating,
    guestsInPark: park.guests,
    suggestedGuestMaximum: park.suggestedGuestMaximum,
    entryFee: dollars(park.entranceFee),
    totalAdmissions: park.totalAdmissions,
    open: park.getFlag("open"),
    ...clockInfo(),
  });
};

const EXPENDITURE_TYPES: ExpenditureType[] = [
  "ride_construction", "ride_runningcosts", "land_purchase", "landscaping",
  "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock",
  "food_drink_sales", "food_drink_stock", "wages", "marketing", "research",
  "interest",
];

handlers[Methods.GetFinanceReport] = (_p, ok) => {
  const byCategory: Record<string, number> = {};
  let currentMonthNet = 0;
  for (const t of EXPENDITURE_TYPES) {
    const history = park.getMonthlyExpenditure(t) || [];
    const current = history.length > 0 ? history[0] : 0;
    const v = dollars(current);
    byCategory[t] = v;
    currentMonthNet += v;
  }
  ok({
    // Values are signed: income positive, costs negative, in dollars.
    byCategory,
    currentMonthNet: Math.round(currentMonthNet * 100) / 100,
    cash: dollars(park.cash),
    loan: dollars(park.bankLoan),
    note: "Amounts are current-month totals (income positive, costs negative).",
  });
};

handlers[Methods.ListRides] = (_p, ok) => {
  const rides = map.rides.filter((r) => r.classification === "ride");
  ok({ count: rides.length, rides: rides.map(rideSummary) });
};

handlers[Methods.GetRide] = (p, ok, fail) => {
  const id = num(p, "ride_id");
  const r = map.getRide(id);
  if (!r) return fail(`no ride with id ${id}`);
  ok(rideDetail(r));
};

handlers[Methods.ListShops] = (_p, ok) => {
  const shops = map.rides.filter(isShop);
  ok({
    count: shops.length,
    shops: shops.map((r) => ({
      id: r.id,
      name: r.name,
      classification: r.classification,
      status: r.status,
      prices: (r.price || []).map((x) => dollars(x)),
      incomePerHour: dollars(r.incomePerHour),
      totalProfit: dollars(r.totalProfit),
      totalCustomers: r.totalCustomers,
    })),
  });
};

handlers[Methods.GetGuestOverview] = (_p, ok) => {
  const guests = map.getAllEntities("guest").filter((g) => g.isInPark);
  let happinessSum = 0;
  let cashSum = 0;
  let hungry = 0, thirsty = 0, lost = 0, toilet = 0, unhappy = 0;
  for (const g of guests) {
    happinessSum += g.happiness;
    cashSum += g.cash;
    if (g.isLost) lost++;
    if (g.happiness < 128) unhappy++;
    for (const th of g.thoughts) {
      if (th.freshness <= 0) continue;
      if (th.type === "hungry") hungry++;
      else if (th.type === "thirsty") thirsty++;
      else if (th.type === "toilet") toilet++;
      else if (th.type === "lost" || th.type === "cant_find") lost++;
    }
  }
  const n = guests.length || 1;
  ok({
    guestsInPark: guests.length,
    averageHappiness: Math.round((happinessSum / n / 255) * 100), // percent 0-100
    averageCash: dollars(Math.round(cashSum / n)),
    hungry,
    thirsty,
    needToilet: toilet,
    lost,
    unhappy,
  });
};

handlers[Methods.SampleGuestThoughts] = (p, ok) => {
  const limit = num(p, "limit", 20);
  const guests = map.getAllEntities("guest").filter((g) => g.isInPark);
  const counts: Record<string, number> = {};
  for (const g of guests) {
    for (const th of g.thoughts) {
      if (th.freshness <= 0) continue;
      const text = th.toString();
      counts[text] = (counts[text] || 0) + 1;
    }
  }
  const grouped = Object.keys(counts)
    .map((text) => ({ text, guests: counts[text] }))
    .sort((a, b) => b.guests - a.guests)
    .slice(0, limit);
  ok({ sampledGuests: guests.length, thoughts: grouped });
};

handlers[Methods.ListStaff] = (_p, ok) => {
  const staff = map.getAllEntities("staff");
  const list = staff.map((s) => ({
    id: s.id,
    name: s.name,
    staffType: s.staffType,
    energy: s.energy,
  }));
  const byType: Record<string, number> = {};
  for (const s of list) byType[s.staffType] = (byType[s.staffType] || 0) + 1;
  ok({ count: list.length, byType, staff: list });
};

handlers[Methods.GetScenario] = (_p, ok) => {
  ok({
    name: scenario.name,
    details: scenario.details,
    status: scenario.status,
    objective: {
      type: scenario.objective.type,
      guests: scenario.objective.guests,
      year: scenario.objective.year,
      parkValue: dollars(scenario.objective.parkValue),
      monthlyIncome: dollars(scenario.objective.monthlyIncome),
      excitement: scenario.objective.excitement,
      length: scenario.objective.length,
    },
    parkRatingWarningDays: scenario.parkRatingWarningDays,
    ...clockInfo(),
  });
};

// --- act: business ---------------------------------------------------------

handlers[Methods.SetRidePrice] = (p, ok, fail) => {
  const ride = num(p, "ride_id");
  const price = money(num(p, "price"));
  const isPrimary = bool(p, "is_primary", true);
  execAction("ridesetprice", { ride, price, isPrimaryPrice: isPrimary })
    .then(() => ok({ ride_id: ride, price: dollars(price), isPrimaryPrice: isPrimary }))
    .catch((e) => fail(String(e.message || e)));
};

handlers[Methods.SetShopPrice] = (p, ok, fail) => {
  const ride = num(p, "shop_id");
  const price = money(num(p, "price"));
  // Shops: primary price is the item price. "item" (secondary) is on-ride photo etc.
  const isPrimary = bool(p, "is_primary", true);
  execAction("ridesetprice", { ride, price, isPrimaryPrice: isPrimary })
    .then(() => ok({ shop_id: ride, price: dollars(price), isPrimaryPrice: isPrimary }))
    .catch((e) => fail(String(e.message || e)));
};

handlers[Methods.SetParkEntryFee] = (p, ok, fail) => {
  const value = money(num(p, "amount"));
  execAction("parksetentrancefee", { value })
    .then(() => ok({ entryFee: dollars(value) }))
    .catch((e) => fail(String(e.message || e)));
};

// ParkSetParameter: parameter 0 = close park, 1 = open park. Separate from
// individual ride open/closed status — guests never spawn while the park
// itself is closed, regardless of ride status.
handlers[Methods.SetParkOpen] = (p, ok, fail) => {
  const open = bool(p, "open", true);
  execAction("parksetparameter", { parameter: open ? 1 : 0, value: 0 })
    .then(() => ok({ open }))
    .catch((e) => fail(String(e.message || e)));
};

// RideStatus numeric: 0 closed, 1 open, 2 testing, 3 simulating
handlers[Methods.OpenRide] = (p, ok, fail) => {
  const ride = num(p, "ride_id");
  execAction("ridesetstatus", { ride, status: 1 })
    .then(() => ok({ ride_id: ride, status: "open" }))
    .catch((e) => fail(String(e.message || e)));
};
handlers[Methods.CloseRide] = (p, ok, fail) => {
  const ride = num(p, "ride_id");
  execAction("ridesetstatus", { ride, status: 0 })
    .then(() => ok({ ride_id: ride, status: "closed" }))
    .catch((e) => fail(String(e.message || e)));
};

// RideSetSetting: setting index 5 == inspection interval.
// interval codes: 0=10min,1=20,2=30,3=45,4=60,5=120,6=never
handlers[Methods.SetInspectionInterval] = (p, ok, fail) => {
  const ride = num(p, "ride_id");
  const minutes = num(p, "minutes");
  let code: number;
  if (minutes <= 0 || minutes > 120) code = 6; // never
  else if (minutes <= 10) code = 0;
  else if (minutes <= 20) code = 1;
  else if (minutes <= 30) code = 2;
  else if (minutes <= 45) code = 3;
  else if (minutes <= 60) code = 4;
  else code = 5;
  execAction("ridesetsetting", { ride, setting: 5, value: code })
    .then(() => ok({ ride_id: ride, inspectionInterval: code }))
    .catch((e) => fail(String(e.message || e)));
};

// Marketing campaign types (ADVERTISING_CAMPAIGN):
// 0 park_entry_free, 1 ride_free, 2 park_entry_half_price,
// 3 food_or_drink_free, 4 park (advertise park), 5 ride (advertise a ride)
const CAMPAIGN_TYPES: Record<string, number> = {
  free_park_entry: 0,
  free_ride: 1,
  half_price_park_entry: 2,
  free_food_drink: 3,
  advertise_park: 4,
  advertise_ride: 5,
};
handlers[Methods.StartMarketingCampaign] = (p, ok, fail) => {
  const typeName = str(p, "type");
  const type = CAMPAIGN_TYPES[typeName];
  if (type === undefined) return fail(`unknown campaign type '${typeName}'. valid: ${Object.keys(CAMPAIGN_TYPES).join(", ")}`);
  const weeks = num(p, "weeks");
  const item = num(p, "item", 0); // ride id or shop item, for ride/food campaigns
  execAction("parkmarketing", { type, item, duration: weeks })
    .then(() => ok({ type: typeName, weeks, item }))
    .catch((e) => fail(String(e.message || e)));
};

// Research funding level: 0 none, 1 minimum, 2 normal, 3 maximum.
handlers[Methods.SetResearchFunding] = (p, ok, fail) => {
  const level = num(p, "level");
  // priorities is a category bitmask; default to all categories enabled (0x7F).
  const priorities = num(p, "priorities", 0x7f);
  execAction("parksetresearchfunding", { priorities, fundingAmount: level })
    .then(() => ok({ level, priorities }))
    .catch((e) => fail(String(e.message || e)));
};

// Staff type numeric: 0 handyman, 1 mechanic, 2 security, 3 entertainer
const STAFF_TYPES: Record<string, number> = {
  handyman: 0, mechanic: 1, security: 2, entertainer: 3,
};
handlers[Methods.HireStaff] = (p, ok, fail) => {
  const typeName = str(p, "type");
  const staffType = STAFF_TYPES[typeName];
  if (staffType === undefined) return fail(`unknown staff type '${typeName}'. valid: ${Object.keys(STAFF_TYPES).join(", ")}`);
  // Handyman default orders: sweep+water+empty+mow = 0x0F; others 0.
  const staffOrders = staffType === 0 ? 0x0f : 0;
  execAction("staffhire", { autoPosition: true, staffType, costumeIndex: 0, staffOrders })
    .then((res: GameActionResult) => {
      const r = res as StaffHireNewActionResult;
      ok({ hired: typeName, staffId: r.peep ?? null });
    })
    .catch((e) => fail(String(e.message || e)));
};
handlers[Methods.FireStaff] = (p, ok, fail) => {
  const id = num(p, "staff_id");
  execAction("stafffire", { id })
    .then(() => ok({ fired: id }))
    .catch((e) => fail(String(e.message || e)));
};
handlers[Methods.SetStaffPatrol] = (p, ok, fail) => {
  const id = num(p, "staff_id");
  // area in tiles; convert to map units. mode 0 = set, 1 = clear.
  const x1 = num(p, "x1") * TILE;
  const y1 = num(p, "y1") * TILE;
  const x2 = num(p, "x2") * TILE;
  const y2 = num(p, "y2") * TILE;
  const mode = num(p, "mode", 0);
  execAction("staffsetpatrolarea", { id, x1, y1, x2, y2, mode })
    .then(() => ok({ staff_id: id, mode }))
    .catch((e) => fail(String(e.message || e)));
};

handlers[Methods.SetLoan] = (p, ok, fail) => {
  const value = money(num(p, "amount"));
  execAction("parksetloan", { value })
    .then(() => ok({ loan: dollars(value) }))
    .catch((e) => fail(String(e.message || e)));
};

// --- build: paths ----------------------------------------------------------

const MAX_INSPECT_RADIUS = 24;

handlers[Methods.InspectArea] = (p, ok, fail) => {
  const cx = Math.floor(num(p, "x"));
  const cy = Math.floor(num(p, "y"));
  const radius = Math.max(0, Math.min(MAX_INSPECT_RADIUS, Math.floor(num(p, "radius", 6))));

  // map.size is in tiles and counts the impassable border ring on each side.
  const maxX = map.size.x - 1;
  const maxY = map.size.y - 1;
  const x0 = Math.max(1, cx - radius);
  const y0 = Math.max(1, cy - radius);
  const x1 = Math.min(maxX - 1, cx + radius);
  const y1 = Math.min(maxY - 1, cy + radius);
  if (x1 < x0 || y1 < y0) return fail(`area around (${cx},${cy}) is outside the map`);

  const rows: string[] = [];
  // Bounded-size overview only: counts stay cheap regardless of how built-out
  // the area is. Exact heights and full element data are get_tile_detail's job.
  const counts = { path: 0, queue: 0, entrance: 0, track: 0, scenery: 0, wall: 0, water: 0, unowned: 0 };

  for (let y = y0; y <= y1; y++) {
    let row = "";
    for (let x = x0; x <= x1; x++) {
      const tile = map.getTile(x, y);
      const surf = surfaceOf(tile);
      row += tileGlyph(tile, surf);
      if (surf && !surf.hasOwnership && !surf.hasConstructionRights) counts.unowned++;
      if (isSubmerged(surf)) counts.water++;
      let hasPath = false, hasQueue = false, hasEntrance = false, hasTrack = false, hasScenery = false, hasWall = false;
      for (const el of tile.elements) {
        if (el.type === "footpath") { hasPath = true; if ((el as FootpathElement).isQueue) hasQueue = true; }
        else if (el.type === "entrance") hasEntrance = true;
        else if (el.type === "track") hasTrack = true;
        else if (el.type === "small_scenery" || el.type === "large_scenery") hasScenery = true;
        else if (el.type === "wall") hasWall = true;
      }
      if (hasPath) counts.path++;
      if (hasQueue) counts.queue++;
      if (hasEntrance) counts.entrance++;
      if (hasTrack) counts.track++;
      if (hasScenery) counts.scenery++;
      if (hasWall) counts.wall++;
    }
    rows.push(row);
  }

  ok({
    origin: { x: x0, y: y0 },
    size: { width: x1 - x0 + 1, height: y1 - y0 + 1 },
    // Row-major, rows[0] is y === origin.y; each string is one char per tile.
    map: rows,
    legend: ". empty ground | P path | Q queue | E entrance | T ride/track | s scenery | w wall "
      + "| ~ under water | lowercase or x = land not owned (cannot build). A tile with water but "
      + "no ~ is shoreline: its high corner clears the water, so a path can still be built there.",
    counts,
    note: "This is an overview only -- no heights, no per-tile detail. Call get_tile_detail on the "
      + "specific tiles you're about to inspect or build on for exact ground height/slope/water and "
      + "the full detail of anything placed there (paths, entrances, track, scenery, walls).",
  });
};

/** Resolve an object's display name; null if the index isn't loaded or valid. */
function objectName(type: ObjectType, index: number): string | null {
  try {
    const o = objectManager.getObject(type, index);
    return o ? o.name : null;
  } catch (_e) {
    return null;
  }
}

/** Per-element detail for get_tile_detail, one shape per tile element type. */
function describeElement(el: TileElement, x: number, y: number): Record<string, unknown> {
  const base = { type: el.type, z: el.baseZ };
  switch (el.type) {
    case "footpath": {
      const f = el as FootpathElement;
      return {
        ...base,
        isQueue: f.isQueue,
        slopeDirection: f.slopeDirection,
        // Two neighbouring paths are walkable between ONLY if the edges they
        // turn to each other are both non-null and exactly equal.
        edgeZ: edgeZLabelled(f.baseZ, f.slopeDirection),
        edges: f.edges,
        ride: f.ride,
        station: f.station,
      };
    }
    case "entrance": {
      const e = el as EntranceElement;
      return {
        ...base,
        role: entranceRole(e, x, y),
        direction: e.direction,
        ride: e.ride,
        station: e.station,
        // Where a path has to go to reach it -- `direction` points into the
        // ride, so this is the tile on the far side.
        connectAt: apronTile(x, y, e.baseZ, e.direction),
      };
    }
    case "track": {
      const t = el as TrackElement;
      return {
        ...base,
        ride: t.ride,
        trackType: t.trackType,
        direction: t.direction,
        station: t.station,
        hasChainLift: t.hasChainLift,
        isInverted: t.isInverted,
      };
    }
    case "small_scenery": {
      const s = el as SmallSceneryElement;
      return {
        ...base,
        object: s.object,
        name: objectName("small_scenery", s.object),
        direction: s.direction,
        quadrant: s.quadrant,
        colours: [s.primaryColour, s.secondaryColour, s.tertiaryColour],
      };
    }
    case "large_scenery": {
      const s = el as LargeSceneryElement;
      return {
        ...base,
        object: s.object,
        name: objectName("large_scenery", s.object),
        direction: s.direction,
        sequence: s.sequence,
        colours: [s.primaryColour, s.secondaryColour, s.tertiaryColour],
        bannerText: s.bannerText,
      };
    }
    case "wall": {
      const w = el as WallElement;
      return {
        ...base,
        object: w.object,
        name: objectName("wall", w.object),
        direction: w.direction,
        slope: w.slope,
        bannerText: w.bannerText,
      };
    }
    case "banner": {
      const b = el as BannerElement;
      return {
        ...base,
        object: b.object,
        direction: b.direction,
        text: b.bannerText,
        isNoEntry: b.isNoEntry,
      };
    }
    default:
      return base;
  }
}

const MAX_TILE_DETAIL = 40;

handlers[Methods.GetTileDetail] = (p, ok, fail) => {
  const raw = p.tiles;
  if (!Array.isArray(raw) || raw.length === 0) return fail("tiles must be a non-empty array of {x,y}");
  if (raw.length > MAX_TILE_DETAIL) return fail(`too many tiles (${raw.length}); max ${MAX_TILE_DETAIL} per call`);

  const maxX = map.size.x - 1;
  const maxY = map.size.y - 1;

  const tiles = raw.map((t: any) => {
    const x = Math.floor(Number(t && t.x));
    const y = Math.floor(Number(t && t.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: t && t.x, y: t && t.y, error: "invalid coordinates" };
    if (x < 1 || y < 1 || x > maxX - 1 || y > maxY - 1) return { x, y, error: "outside the map" };

    const tile = map.getTile(x, y);
    const surf = surfaceOf(tile);
    const ground = surf
      ? {
        z: surf.baseZ,
        topZ: surfaceTopZ(surf),
        slope: surf.slope,
        waterZ: surf.waterHeight,
        submerged: isSubmerged(surf),
        owned: surf.hasOwnership || surf.hasConstructionRights,
      }
      : null;

    const elements = tile.elements
      .filter((el) => el.type !== "surface")
      .map((el) => describeElement(el, x, y));

    return { x, y, ground, elements };
  });

  ok({
    tiles,
    zUnits: {
      coordsZStep: COORDS_Z_STEP,
      landStepZ: LAND_STEP_Z,
      note: "World z. ground.z is a tile's LOW corner, ground.topZ its HIGH corner; they are equal "
        + "on flat ground (slope 0). A flat path needs z = ground.topZ; a path sloped to match the "
        + "terrain sits at z = ground.z. Each land level is landStepZ. A footpath element's edgeZ is "
        + "the world z it presents on each of its four sides (-X, +Y, +X, -Y), or null where a "
        + "slope's mid-slope side cannot connect at all.",
    },
  });
};

handlers[Methods.ListPathStyles] = (_p, ok) => {
  const surfaces = objectManager.getAllObjects("footpath_surface") || [];
  const railings = objectManager.getAllObjects("footpath_railings") || [];
  const legacy = objectManager.getAllObjects("footpath") || [];
  ok({
    generation: surfaces.length > 0 ? "nsf" : "legacy",
    surfaces: surfaces.map((o) => ({
      index: o.index, name: o.name, identifier: o.identifier,
      isQueue: isQueueSurface(o), flags: o.flags,
    })),
    railings: railings.map((o) => ({ index: o.index, name: o.name, identifier: o.identifier })),
    legacy: legacy.map((o) => ({ index: o.index, name: o.name, identifier: o.identifier })),
    note: "Pass `object` (and optionally `railings_object`) to place_path to override the default style.",
  });
};

handlers[Methods.PlacePath] = (p, ok, fail) => {
  const x = Math.floor(num(p, "x"));
  const y = Math.floor(num(p, "y"));
  const tile = map.getTile(x, y);
  const gz = groundZ(tile);
  if (gz === null) return fail(`no ground at tile (${x},${y}); is it outside the map?`);

  const sloped = p.slope_direction !== undefined && p.slope_direction !== null;
  const slopeDirection = sloped ? (Math.floor(num(p, "slope_direction")) & 3) : 0;
  const queue = bool(p, "queue", false);

  // Default z follows the terrain: a path sloped to match the ground sits on
  // the low corner, a flat one has to sit on the high corner. They are the
  // same number on flat ground. height_offset then shifts by whole land levels.
  // Read the surface up front: placing the path inserts a tile element, which
  // invalidates element handles held across the action.
  const surf = surfaceOf(tile);
  const existingZs: number[] = [];
  for (const el of tile.elements) {
    if (el.type === "footpath") existingZs.push(el.baseZ);
  }
  const topZ = surf ? surfaceTopZ(surf) : gz;
  const defaultZ = sloped ? gz : topZ;
  const baseZ = p.z !== undefined ? num(p, "z") : defaultZ;
  const z = baseZ + Math.floor(num(p, "height_offset", 0)) * LAND_STEP_Z;
  if (z < 0) return fail(`resolved z ${z} is below ground level`);

  let style: PathStyle;
  try {
    style = resolvePathStyle(
      p.object === undefined ? undefined : num(p, "object"),
      p.railings_object === undefined ? undefined : num(p, "railings_object"),
      queue,
    );
  } catch (e: any) {
    return fail(String(e && e.message ? e.message : e));
  }

  const args = {
    x: x * TILE,
    y: y * TILE,
    z,
    // 0xFF means "no forced connection direction" -- let the game work out edges.
    direction: 0xff,
    object: style.object,
    railingsObject: style.railingsObject,
    slopeType: sloped ? 1 : 0,
    slopeDirection: slopeDirection as Direction,
    constructFlags: (queue ? PATH_FLAG_QUEUE : 0) | (style.legacy ? PATH_FLAG_LEGACY : 0),
  };

  // Query first so a rejected placement reports the game's own reason instead
  // of failing silently; the agent needs that text to pick the next tile.
  const restore = unpauseFor();
  context.queryAction("footpathplace", args as any, (q: GameActionResult) => {
    if (q.error && q.error !== 0) {
      restore();
      return fail(
        `cannot place path at (${x},${y}) z=${z}: ${q.errorMessage || q.errorTitle || `error ${q.error}`}`,
      );
    }
    execAction("footpathplace", args)
      .then((res: GameActionResult) => {
        restore();
        // Re-placing an identical path is a no-op the game reports as success
        // with no cost; say so rather than implying a tile was built.
        const alreadyPresent = existingZs.indexOf(z) >= 0;
        // Read the placed tile back out of the map rather than echoing the
        // request: the game normalises slopes, and what it stored is what the
        // next tile has to meet.
        const conn = connectivityAt(x, y, z);
        ok({
          placed: true, x, y, z, groundZ: gz, groundTopZ: topZ,
          sloped, slopeDirection: sloped ? slopeDirection : null,
          queue, object: style.object, railingsObject: style.railingsObject,
          cost: dollars(res.cost || 0),
          alreadyPresent,
          ...(conn ? {
            edgeZ: conn.edgeZ,
            connectedTo: conn.connectedTo,
            neighborsNotConnected: conn.notConnected,
            ...(conn.connectedTo.length === 0 ? {
              warning: conn.notConnected.length > 0
                ? "this tile connects to NOTHING: every neighbouring path or entrance was missed. "
                  + "Read neighborsNotConnected -- connectAtZ gives the z this tile needed. "
                  + "Do not keep extending the route until this is fixed."
                : "this tile connects to nothing: no path or ride entrance on any of the four "
                  + "neighbouring tiles. Expected for the first tile of a new route; otherwise "
                  + "the route is broken here.",
            } : {}),
          } : {}),
          ...(alreadyPresent
            ? { note: "a path already existed at this tile and z; cost 0 means nothing changed" }
            : {}),
        });
      })
      .catch((e) => {
        restore();
        fail(`place_path (${x},${y}) z=${z}: ${String(e.message || e)}`);
      });
  });
};

handlers[Methods.RemovePath] = (p, ok, fail) => {
  const x = Math.floor(num(p, "x"));
  const y = Math.floor(num(p, "y"));
  const tile = map.getTile(x, y);

  let z: number;
  if (p.z !== undefined) {
    z = num(p, "z");
  } else {
    // No z given: unambiguous only when the tile carries exactly one path.
    const paths = tile.elements.filter((el) => el.type === "footpath");
    if (paths.length === 0) return fail(`no footpath on tile (${x},${y})`);
    if (paths.length > 1) {
      const zs = paths.map((el) => el.baseZ);
      return fail(`tile (${x},${y}) has ${paths.length} stacked paths (z: ${zs.join(", ")}); pass z`);
    }
    z = paths[0].baseZ;
  }

  const restore = unpauseFor();
  execAction("footpathremove", { x: x * TILE, y: y * TILE, z })
    .then((res: GameActionResult) => {
      restore();
      ok({ removed: true, x, y, z, refund: dollars(res.cost || 0) });
    })
    .catch((e) => {
      restore();
      fail(`remove_path (${x},${y}) z=${z}: ${String(e.message || e)}`);
    });
};

handlers[Methods.CheckRideAccess] = (p, ok, fail) => {
  const id = num(p, "ride_id");
  let r: Ride | null = null;
  try {
    r = map.getRide(id);
  } catch (_e) {
    r = null;
  }
  if (!r) return fail(`no ride with id ${id}`);

  const problems: string[] = [];

  // Stalls and facilities have no entrance element at all: a guest uses one
  // from any adjacent footpath at the same height.
  if (isShop(r)) {
    const st = primaryStation(r);
    const here = st ? tileCoords(st.start) : null;
    if (!here || here.z === undefined) return fail(`shop ${id} has no placed tile to check`);
    const adjacent = DIRECTION_DELTA.map((d, direction) => {
      const a = { x: here.x + d.dx, y: here.y + d.dy, z: here.z as number };
      const res = apronStatus(a);
      return { direction, x: a.x, y: a.y, ...res };
    });
    const reachable = adjacent.filter((a) => a.connected);
    if (reachable.length === 0) {
      problems.push(
        `${r.name} has no adjacent footpath at z=${here.z}; guests cannot reach it. `
        + adjacent.map((a) => `(${a.x},${a.y}): ${a.detail}`).join(" | "),
      );
    }
    return ok({
      rideId: r.id, name: r.name, classification: r.classification, status: r.status,
      connected: reachable.length > 0,
      tile: here,
      adjacent,
      problems,
      note: "Stalls have no entrance or exit element; a guest can use one from any "
        + "adjacent footpath at the same height.",
    });
  }

  const stations = realStations(r).map(({ index, station }) => {
    const en = accessCoords(station.entrance);
    const ex = accessCoords(station.exit);

    const describe = (what: string, c: TileCoord | null) => {
      if (!c || !c.connectAt) {
        problems.push(`station ${index}: ${what} is not built`);
        return { built: false as const };
      }
      const access = apronStatus(c.connectAt);
      if (!access.connected) {
        problems.push(`station ${index} ${what}: ${access.detail}`);
      }
      return {
        built: true as const,
        x: c.x, y: c.y, z: c.z, direction: c.direction,
        connectAt: c.connectAt,
        access,
      };
    };

    return { index, entrance: describe("entrance", en), exit: describe("exit", ex) };
  });

  if (stations.length === 0) problems.push("ride has no built station");

  const connected = stations.length > 0 && stations.every(
    (s) => s.entrance.built && s.entrance.access.connected && s.exit.built && s.exit.access.connected,
  );

  ok({
    rideId: r.id, name: r.name, classification: r.classification, status: r.status,
    connected,
    stations,
    problems,
    note: "connectAt is the tile a footpath must occupy to reach that entrance or exit "
      + "-- build there, at the z given. Guests need BOTH the entrance and the exit "
      + "connected before a ride works.",
  });
};

// --- vision ----------------------------------------------------------------

function doCapture(position: CoordsXY | undefined, zoom: number, rotation: number, ok: Respond) {
  const filename = `rct2agent-cap-${date.ticksElapsed}-${Math.floor(Math.random() * 1e6)}.png`;
  const opts: CaptureOptions = {
    filename,
    zoom,
    rotation: rotation & 3,
    width: 1280,
    height: 720,
    transparent: false,
  };
  if (position) opts.position = position;
  context.captureImage(opts);
  // captureImage renders on a subsequent frame; the server polls for the file.
  ok({ filename, zoom, rotation: rotation & 3 });
}

handlers[Methods.CaptureView] = (p, ok) => {
  const zoom = num(p, "zoom", 1);
  const rotation = num(p, "rotation", 0);
  let position: CoordsXY | undefined;
  if (p.x !== undefined && p.y !== undefined) {
    position = { x: num(p, "x") * TILE, y: num(p, "y") * TILE };
  }
  doCapture(position, zoom, rotation, ok);
};

handlers[Methods.CaptureRide] = (p, ok, fail) => {
  const id = num(p, "ride_id");
  const r = map.getRide(id);
  if (!r) return fail(`no ride with id ${id}`);
  const st = primaryStation(r);
  if (!st) return fail(`ride ${id} has no built station to center on`);
  const zoom = num(p, "zoom", 0);
  const rotation = num(p, "rotation", 0);
  doCapture({ x: st.start.x, y: st.start.y }, zoom, rotation, ok);
};

handlers[Methods.FindLocation] = (p, ok, fail) => {
  const name = str(p, "name").toLowerCase();
  const matches: Array<Record<string, unknown>> = [];
  for (const r of map.rides) {
    if (r.name.toLowerCase().indexOf(name) >= 0) {
      const st = primaryStation(r);
      if (st) {
        const c = tileCoords(st.start)!;
        matches.push({
          id: r.id, name: r.name, x: c.x, y: c.y,
          entrance: accessCoords(st.entrance),
          exit: accessCoords(st.exit),
        });
      }
    }
  }
  if (matches.length === 0) return fail(`no ride matching '${name}'`);
  ok({ matches });
};

handlers[Methods.FindParkEntrance] = (_p, ok, fail) => {
  // No API exposes park entrance locations directly; the only way to find
  // one is to scan every tile for an "entrance" element that isn't owned by
  // a ride (entranceRole falls back to "park" when the ride lookup fails).
  const maxX = map.size.x - 1;
  const maxY = map.size.y - 1;
  const tiles: Array<Record<string, unknown>> = [];
  for (let y = 1; y < maxY; y++) {
    for (let x = 1; x < maxX; x++) {
      for (const el of map.getTile(x, y).elements) {
        if (el.type !== "entrance") continue;
        const e = el as EntranceElement;
        if (entranceRole(e, x, y) !== "park") continue;
        const connectAt = apronTile(x, y, e.baseZ, e.direction);
        tiles.push({
          x, y, z: e.baseZ, direction: e.direction, sequence: e.sequence,
          connectAt,
          access: apronStatus(connectAt),
        });
      }
    }
  }
  if (tiles.length === 0) return fail("no park entrance found on the map -- it may not be built yet");
  ok({
    tiles,
    note: "A park entrance spans three tiles (sequence 0-2 across one row); only the "
      + "walkable centre tile needs a path connected outside it at connectAt -- `access` "
      + "reports whether one is there. Use capture_view on any of these coordinates to see it.",
  });
};

// --- time ------------------------------------------------------------------

handlers[Methods.GetClock] = (_p, ok) => ok(clockInfo());

handlers[Methods.SetGameSpeed] = (p, ok, fail) => {
  const speed = Math.max(0, Math.min(4, num(p, "speed")));
  execAction("gamesetspeed", { speed })
    .then(() => ok(clockInfo()))
    .catch((e) => fail(String(e.message || e)));
};

handlers[Methods.Pause] = (_p, ok) => {
  context.paused = true;
  ok(clockInfo());
};
handlers[Methods.Resume] = (_p, ok) => {
  context.paused = false;
  ok(clockInfo());
};

// advance_days: unpause, crank speed, run until N in-game days pass, then
// restore speed and pause. Responds only when the target date is reached.
handlers[Methods.AdvanceDays] = (p, ok, fail) => {
  const days = Math.max(1, Math.floor(num(p, "days")));
  const maxSpeed = Math.max(1, Math.min(4, num(p, "max_speed", 4)));
  const prevSpeed = context.gameSpeed;
  const prevPaused = context.paused;

  let elapsed = 0;
  let sub: IDisposable | null = null;
  let watchdog = 0;
  const startTicks = date.ticksElapsed;
  // safety: a day is ~13,000+ ticks at 1x but far fewer wall-frames at turbo;
  // bound by wall ticks of THIS handler via interval.tick fallback.

  const finish = () => {
    if (sub) { sub.dispose(); sub = null; }
    if (tickSub) { tickSub.dispose(); tickSub = null; }
    execAction("gamesetspeed", { speed: prevSpeed })
      .catch(() => {})
      .then(() => {
        context.paused = true;
        ok({ advancedDays: elapsed, requestedDays: days, restoredSpeed: prevSpeed, wasPaused: prevPaused, ...clockInfo() });
      });
  };

  sub = context.subscribe("interval.day", () => {
    elapsed++;
    if (elapsed >= days) finish();
  });

  // watchdog: if no day ticks fire for a very long time, bail out gracefully.
  let tickSub: IDisposable | null = context.subscribe("interval.tick", () => {
    watchdog++;
    // ~40 ticks/sec at normal; allow generous ceiling before aborting.
    if (watchdog > 20000 && elapsed === 0 && date.ticksElapsed === startTicks) {
      if (sub) { sub.dispose(); sub = null; }
      if (tickSub) { tickSub.dispose(); tickSub = null; }
      execAction("gamesetspeed", { speed: prevSpeed }).catch(() => {}).then(() => {
        context.paused = prevPaused;
        fail("advance_days: game did not tick (is the game on the title screen or a modal blocking it?)");
      });
    }
  });

  context.paused = false;
  execAction("gamesetspeed", { speed: maxSpeed }).catch((e) => fail(String(e.message || e)));
};

// --- save ------------------------------------------------------------------

handlers[Methods.Snapshot] = (p, ok, fail) => {
  // filename is a leaf name in the save directory (without .park). saveGame
  // silently drops anything containing a path separator, so reject those here
  // instead of reporting a save that never happened; the server verifies the
  // file landed either way.
  const filename = str(p, "filename");
  if (/[\\/]/.test(filename)) {
    fail(`snapshot filename must not contain a path separator: ${filename}`);
    return;
  }
  try {
    context.saveGame({ filename });
    ok({ filename, savedTo: `${filename}.park` });
  } catch (e: any) {
    fail(`saveGame failed: ${String(e && e.message ? e.message : e)}`);
  }
};

// ---------------------------------------------------------------------------
// dispatch + connection handling
// ---------------------------------------------------------------------------

function dispatch(req: RpcRequest, send: (r: RpcResponse) => void) {
  const handler = handlers[req.method];
  if (!handler) {
    send({ id: req.id, ok: false, error: `unknown method: ${req.method}` });
    return;
  }
  const ok: Respond = (result) => send({ id: req.id, ok: true, result });
  const fail: Fail = (error) => send({ id: req.id, ok: false, error });
  try {
    handler(req.params || {}, ok, fail);
  } catch (e: any) {
    send({ id: req.id, ok: false, error: String(e && e.message ? e.message : e) });
  }
}

function main() {
  const listener = network.createListener();

  listener.on("connection", (socket: Socket) => {
    console.log("[rct2-agent] server connected");
    let buffer = "";
    socket.setNoDelay(true);

    const send = (r: RpcResponse) => {
      try {
        socket.write(JSON.stringify(r) + "\n");
      } catch (e) {
        console.log("[rct2-agent] write failed: " + e);
      }
    };

    socket.on("data", (data: string) => {
      buffer += data;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let req: RpcRequest;
        try {
          req = JSON.parse(line);
        } catch (e) {
          send({ id: -1, ok: false, error: "invalid JSON: " + line.slice(0, 120) });
          continue;
        }
        dispatch(req, send);
      }
    });

    socket.on("close", () => console.log("[rct2-agent] server disconnected"));
    socket.on("error", (err: string) => console.log("[rct2-agent] socket error: " + err));
  });

  try {
    listener.listen(PORT, "127.0.0.1");
    console.log(`[rct2-agent] listening on 127.0.0.1:${PORT} (api v${context.apiVersion})`);
  } catch (e) {
    console.log("[rct2-agent] failed to listen: " + e);
  }
}

registerPlugin({
  name: "rct2-agent",
  version: "0.1.0",
  authors: ["rct2-agent"],
  type: "intransient",
  licence: "MIT",
  targetApiVersion: 77,
  main,
});
