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
  DEFAULT_PORT,
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

// ride classification -> our buckets. stalls/facilities are "shops".
function isShop(r: Ride): boolean {
  return r.classification === "stall";
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
    stations: (r.stations || []).map((s, i) => ({
      index: i,
      queueTimeMinutes: s.queueTime,
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
  const shops = map.rides.filter((r) => r.classification === "stall" || r.classification === "facility");
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
  const st = r.stations && r.stations.length > 0 ? r.stations[0] : null;
  if (!st || !st.start) return fail(`ride ${id} has no station to center on`);
  const zoom = num(p, "zoom", 0);
  const rotation = num(p, "rotation", 0);
  doCapture({ x: st.start.x, y: st.start.y }, zoom, rotation, ok);
};

handlers[Methods.FindLocation] = (p, ok, fail) => {
  const name = str(p, "name").toLowerCase();
  const matches: Array<{ id: number; name: string; x: number; y: number }> = [];
  for (const r of map.rides) {
    if (r.name.toLowerCase().indexOf(name) >= 0) {
      const st = r.stations && r.stations.length > 0 ? r.stations[0] : null;
      if (st && st.start) {
        matches.push({ id: r.id, name: r.name, x: Math.round(st.start.x / TILE), y: Math.round(st.start.y / TILE) });
      }
    }
  }
  if (matches.length === 0) return fail(`no ride matching '${name}'`);
  ok({ matches });
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
  // filename is relative to the save directory (without .park). The server
  // composes the play/label path; we try it as-is (subfolders if supported).
  const filename = str(p, "filename");
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
