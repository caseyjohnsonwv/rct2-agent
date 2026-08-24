// Smoke test: load the BUILT plugin into a fake OpenRCT2 environment (stubbed
// globals) and exercise the wire protocol + a sample of handlers over a real
// TCP socket. Validates plugin dispatch without needing the game running.
//
// Usage: node scripts/smoke.mjs
import net from "node:net";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

// Run off the default port so a real OpenRCT2 sitting on 7860 doesn't collide.
const PORT = 7899;
const pluginCode = fs
  .readFileSync(path.resolve("dist/rct2-agent.plugin.js"), "utf8")
  .split("7860").join(String(PORT));

// --- fake game state -------------------------------------------------------
function mkRide(id, name, classification, status, price, ex, inten, naus) {
  return {
    id, name, classification, status,
    type: 1, object: { name: name + " obj" },
    price: [price, 0], excitement: ex, intensity: inten, nausea: naus,
    totalCustomers: 100 + id, totalProfit: 5000 + id * 10, runningCost: 300,
    value: 4000, incomePerHour: 1200, satisfaction: 90, reliability: 200,
    downtime: 3, breakdown: "none", inspectionInterval: 2, age: 12,
    mode: 0, minimumWaitingTime: 10, maximumWaitingTime: 60, liftHillSpeed: 20,
    stations: [{ start: { x: 320, y: 640, z: 32 }, queueTime: 4 }],
  };
}
const rides = [
  mkRide(0, "Wooden Coaster", "ride", "open", 25, 650, 700, 300),
  mkRide(1, "Merry Go Round", "ride", "open", 15, 200, 150, 100),
  mkRide(2, "Burger Stall", "stall", "open", 8, -1, -1, -1),
];
const guests = [];
for (let i = 0; i < 50; i++) {
  guests.push({
    id: 1000 + i, isInPark: true, isLost: i % 20 === 0,
    happiness: 100 + (i % 150), cash: 200 + i,
    thoughts: i % 3 === 0
      ? [{ type: "hungry", freshness: 10, toString: () => "I'm hungry" }]
      : i % 3 === 1
      ? [{ type: "bad_value", freshness: 10, toString: () => "Wooden Coaster costs too much" }]
      : [],
  });
}
const staff = [
  { id: 500, name: "Handy 1", staffType: "handyman", energy: 100 },
  { id: 501, name: "Mech 1", staffType: "mechanic", energy: 90 },
];


// --- fake world: tiles, objects, track segments ----------------------------
// Enough of the map/object API for the build tools. Ground is flat at z=32 and
// owned everywhere; elements accumulate as actions place them.
const GROUND_Z = 32;
const tileStore = new Map();
const tileKey = (x, y) => `${x},${y}`;
function tileElements(x, y) {
  const k = tileKey(x, y);
  let els = tileStore.get(k);
  if (!els) {
    els = [{
      type: "surface", baseZ: GROUND_Z, clearanceZ: GROUND_Z, slope: 0, waterHeight: 0,
      hasOwnership: true, hasConstructionRights: true, surfaceStyle: 0, edgeStyle: 0,
    }];
    tileStore.set(k, els);
  }
  return els;
}

// Flat-ride track pieces, offsets in map units, matching OpenRCT2's TED tables.
const SEG = {
  257: [[0, 0], [-64, 0], [-32, 0], [32, 0]],              // 1x4A
  258: [[0, 0], [0, 32], [32, 0], [32, 32]],               // 2x2
  259: [],                                                  // 4x4, filled below
  260: [],                                                  // 2x4, filled below
  261: [[0, 0], [-64, 0], [-32, 0], [32, 0], [64, 0]],     // 1x5
  262: [[0, 0]],                                            // 1x1A
  263: [[0, 0], [-64, 0], [-32, 0], [32, 0]],              // 1x4B
  264: [[0, 0]],                                            // 1x1B
  265: [[0, 0], [-64, 0], [-32, 0], [32, 0]],              // 1x4C
  266: [[0, 0], [-32, -32], [-32, 0], [-32, 32], [0, -32], [0, 32], [32, -32], [32, 32], [32, 0]], // 3x3
};
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) SEG[259].push([i * 32, j * 32]);
for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) SEG[260].push([i * 32, j * 32]);

function rotate(x, y, d) {
  switch (d & 3) {
    case 1: return [y, -x];
    case 2: return [-x, -y];
    case 3: return [-y, x];
    default: return [x, y];
  }
}

const rideObjects = [
  { index: 0, name: "Merry-Go-Round", identifier: "rct2.ride.merry", rideType: [33, 255, 255],
    excitementMultiplier: 60, intensityMultiplier: 15, nauseaMultiplier: 25, carsPerFlatRide: 1 },
  { index: 1, name: "Ferris Wheel", identifier: "rct2.ride.ferris", rideType: [37, 255, 255],
    excitementMultiplier: 60, intensityMultiplier: 25, nauseaMultiplier: 30, carsPerFlatRide: 1 },
  { index: 2, name: "Burger Bar", identifier: "rct2.ride.burger", rideType: [28, 255, 255],
    excitementMultiplier: 0, intensityMultiplier: 0, nauseaMultiplier: 0, carsPerFlatRide: 255 },
  { index: 3, name: "Wooden Coaster", identifier: "rct2.ride.wooden", rideType: [52, 255, 255],
    excitementMultiplier: 90, intensityMultiplier: 90, nauseaMultiplier: 60, carsPerFlatRide: 255 },
];

let nextRideId = 3;
function mkBuiltRide(id, name) {
  return {
    id, name, classification: "ride", status: "closed",
    type: 0, object: { name }, price: [0, 0],
    excitement: -1, intensity: -1, nausea: -1,
    totalCustomers: 0, totalProfit: 0, runningCost: 100, value: 0, incomePerHour: 0,
    satisfaction: -1, reliability: 255, downtime: 0, breakdown: "none",
    inspectionInterval: 2, age: 0, mode: 0, minimumWaitingTime: 0, maximumWaitingTime: 0,
    liftHillSpeed: 0, stations: [],
  };
}

function buildActions(action, args) {
  switch (action) {
    case "ridecreate": {
      const obj = rideObjects.find((o) => o.index === args.rideObject);
      const id = nextRideId++;
      rides.push(mkBuiltRide(id, obj ? obj.name + " 1" : "Ride " + id));
      return { error: 0, ride: id, cost: 1000 };
    }
    case "trackplace": {
      const ride = rides.find((r) => r.id === args.ride);
      if (!ride) return { error: 1, errorMessage: "no such ride" };
      const blocks = SEG[args.trackType];
      if (!blocks) return { error: 1, errorMessage: `unknown track type ${args.trackType}` };
      const ox = args.x / 32, oy = args.y / 32;
      blocks.forEach(([bx, by], i) => {
        const [rx, ry] = rotate(bx / 32, by / 32, args.direction);
        tileElements(ox + rx, oy + ry).push({
          type: "track", ride: args.ride, trackType: args.trackType, rideType: args.rideType,
          sequence: i, direction: args.direction & 3, baseZ: args.z, clearanceZ: args.z + 32, station: 0,
        });
      });
      ride.stations = [{ start: { x: args.x, y: args.y, z: args.z }, length: 1, entrance: null, exit: null, queueTime: 0 }];
      return { error: 0, cost: 2000 };
    }
    case "rideentranceexitplace": {
      const ride = rides.find((r) => r.id === args.ride);
      if (!ride) return { error: 1, errorMessage: "no such ride" };
      const st = ride.stations[args.station] || ride.stations[0];
      const z = st.start.z;
      const els = tileElements(args.x / 32, args.y / 32);
      const existing = args.isExit ? st.exit : st.entrance;
      if (existing) {
        const old = tileElements(existing.x / 32, existing.y / 32);
        const i = old.findIndex((e) => e.type === "entrance" && e.ride === args.ride);
        if (i >= 0) old.splice(i, 1);
      }
      els.push({
        type: "entrance", ride: args.ride, station: args.station,
        baseZ: z, clearanceZ: z + 32, direction: args.direction & 3,
      });
      const loc = { x: args.x, y: args.y, z, direction: args.direction & 3 };
      if (args.isExit) st.exit = loc; else st.entrance = loc;
      return { error: 0, cost: 100 };
    }
    case "ridedemolish": {
      const i = rides.findIndex((r) => r.id === args.ride);
      if (i < 0) return { error: 1, errorMessage: "no such ride" };
      for (const [, els] of tileStore) {
        for (let j = els.length - 1; j >= 0; j--) {
          if ((els[j].type === "track" || els[j].type === "entrance") && els[j].ride === args.ride) els.splice(j, 1);
        }
      }
      rides.splice(i, 1);
      return { error: 0, cost: -500 };
    }
    case "ridesetname": {
      const ride = rides.find((r) => r.id === args.ride);
      if (ride) ride.name = args.name;
      return { error: 0 };
    }
    case "footpathplace": {
      tileElements(args.x / 32, args.y / 32).push({
        type: "footpath", baseZ: args.z, clearanceZ: args.z + 16, slopeDirection: null,
        isQueue: !!args.queue, ride: null, edges: 0, corners: 0,
      });
      return { error: 0, cost: 50 };
    }
    default:
      return null;
  }
}

let paused = true;
let gameSpeed = 1;
const daySubs = new Set();
const tickSubs = new Set();

const sandbox = {
  console: { log: (...a) => process.stderr.write("[plugin] " + a.join(" ") + "\n") },
  Promise, Math, JSON, Date, Object, Array, String, Number, setTimeout, clearTimeout,
  registerPlugin: (meta) => { sandbox.__meta = meta; },
  network: {
    mode: "none",
    createListener() {
      let server;
      const api = {
        get listening() { return !!server && server.listening; },
        on(event, cb) {
          if (event === "connection") {
            this._connCb = cb;
          }
          return this;
        },
        listen(port, host) {
          server = net.createServer((raw) => {
            raw.setEncoding("utf8");
            const adapter = {
              setNoDelay: (v) => raw.setNoDelay(v),
              write: (s) => raw.write(s),
              _handlers: {},
              on(ev, cb) { this._handlers[ev] = cb; return this; },
            };
            raw.on("data", (d) => adapter._handlers.data && adapter._handlers.data(d));
            raw.on("close", () => adapter._handlers.close && adapter._handlers.close(false));
            raw.on("error", (e) => adapter._handlers.error && adapter._handlers.error(String(e)));
            api._connCb && api._connCb(adapter);
          });
          server.listen(port, host);
          return this;
        },
        close() { server && server.close(); return this; },
      };
      return api;
    },
  },
  context: {
    apiVersion: 999,
    get gameSpeed() { return gameSpeed; },
    get paused() { return paused; },
    set paused(v) { paused = v; },
    subscribe(hook, cb) {
      const set = hook === "interval.day" ? daySubs : tickSubs;
      set.add(cb);
      return { dispose: () => set.delete(cb) };
    },
    getTrackSegment(type) {
      const blocks = SEG[type];
      if (!blocks) return null;
      return { type, elements: blocks.map(([x, y]) => ({ x, y, z: 0 })) };
    },
    // Queries never mutate, and the fake world has no reason to refuse.
    queryAction(action, args, cb) { cb && cb({ error: 0 }); },
    executeAction(action, args, cb) {
      // simulate side effects for a couple of actions
      if (action === "gamesetspeed") gameSpeed = args.speed;
      if (action === "ridesetprice") {
        const r = rides.find((x) => x.id === args.ride);
        if (r) r.price[args.isPrimaryPrice ? 0 : 1] = args.price;
      }
      if (action === "staffhire") { cb && cb({ error: 0, peep: 777 }); return; }
      const built = buildActions(action, args);
      if (built) { cb && cb(built); return; }
      cb && cb({ error: 0 });
    },
    captureImage(opts) {
      // write a tiny fake PNG so the server-side reader (not used here) is happy
      const dir = process.env.RCT2_SCREENSHOT_DIR || ".";
      try { fs.writeFileSync(path.join(dir, opts.filename), Buffer.from([0x89, 0x50, 0x4e, 0x47])); } catch {}
    },
    saveGame(opts) { sandbox.__lastSave = opts.filename; },
  },
  map: {
    size: { x: 128, y: 128 },
    get numRides() { return rides.length; },
    get rides() { return rides; },
    getRide: (id) => rides.find((r) => r.id === id),
    getAllEntities: (type) => (type === "guest" ? guests : type === "staff" ? staff : []),
    getTile: (x, y) => ({ x, y, get elements() { return tileElements(x, y); } }),
  },
  objectManager: {
    getAllObjects: (type) => (type === "ride" ? rideObjects : []),
    getObject: (type, index) => (type === "ride" ? rideObjects.find((o) => o.index === index) : null),
  },
  park: {
    name: "Test Park", cash: 500000, rating: 850, bankLoan: 100000, maxBankLoan: 200000,
    entranceFee: 50, guests: guests.length, suggestedGuestMaximum: 800,
    value: 1200000, companyValue: 1600000, totalAdmissions: 4321,
    getFlag: (name) => name === "open",
    getMonthlyExpenditure: (t) => (t === "park_ride_tickets" ? [12000, 11000] : t === "wages" ? [-4000, -4000] : [0, 0]),
  },
  scenario: {
    name: "Test Scenario", details: "Make money", status: "inProgress",
    objective: { type: "guestsBy", guests: 1000, year: 3, parkValue: 0, monthlyIncome: 0, excitement: 0, length: 0 },
    parkRatingWarningDays: 0,
  },
  date: { day: 5, month: 2, year: 1, monthsElapsed: 2, ticksElapsed: 12345, monthProgress: 100 },
};
sandbox.global = sandbox;

vm.createContext(sandbox);
vm.runInContext(pluginCode, sandbox, { filename: "rct2-agent.plugin.js" });
// call main() to start the listener (patch PORT via env not available; plugin uses DEFAULT_PORT 7860)
// We override by re-pointing: the plugin listens on DEFAULT_PORT; run a second listener test instead.
sandbox.__meta.main();

const TARGET = PORT;

function rpc(sock, id, method, params) {
  return new Promise((resolve) => {
    const onData = (buf) => {
      for (const line of buf.toString().split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) { sock.off("data", onData); resolve(msg); }
      }
    };
    sock.on("data", onData);
    sock.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

async function run() {
  await new Promise((r) => setTimeout(r, 300));
  const sock = net.connect(TARGET, "127.0.0.1");
  await new Promise((r) => sock.on("connect", r));
  let n = 1;
  const checks = [
    ["ping", {}],
    ["get_park_summary", {}],
    ["get_finance_report", {}],
    ["list_rides", {}],
    ["get_ride", { ride_id: 0 }],
    ["list_shops", {}],
    ["get_guest_overview", {}],
    ["sample_guest_thoughts", { limit: 5 }],
    ["list_staff", {}],
    ["get_scenario", {}],
    ["set_ride_price", { ride_id: 0, price: 30, is_primary: true }],
    ["hire_staff", { type: "handyman" }],
    ["get_clock", {}],
    ["snapshot", { filename: "agent__play__week-1" }],
  ];
  let pass = 0, fail = 0;
  for (const [method, params] of checks) {
    const res = await rpc(sock, n++, method, params);
    const ok = res.ok;
    if (ok) pass++; else fail++;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${method}: ${JSON.stringify(res.ok ? res.result : res.error).slice(0, 140)}\n`);
  }
  // advance_days: drive the fake day subscriptions so it completes
  const advId = n++;
  const advP = rpc(sock, advId, "advance_days", { days: 2, max_speed: 4 });
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 2; i++) { for (const cb of daySubs) cb(); }
  const adv = await advP;
  process.stdout.write(`${adv.ok ? "PASS" : "FAIL"} advance_days: ${JSON.stringify(adv.ok ? adv.result : adv.error).slice(0, 140)}\n`);
  if (adv.ok) pass++; else fail++;

  // --- build: flat rides ---------------------------------------------------
  // Geometry is the part that cannot be eyeballed, so assert on it: a 3x3 ride
  // is placed by its centre tile, and only certain sides take an entrance.
  const expect = (label, cond, detail) => {
    if (cond) { pass++; process.stdout.write(`PASS ${label}\n`); }
    else { fail++; process.stdout.write(`FAIL ${label}: ${detail}\n`); }
  };

  const types = await rpc(sock, n++, "list_ride_types", {});
  expect("list_ride_types returns flat rides only", types.ok
    && types.result.rideTypes.length === 2
    && types.result.rideTypes.every((t) => t.name !== "Burger Bar" && t.name !== "Wooden Coaster"),
    JSON.stringify(types.result || types.error).slice(0, 200));
  const merry = types.ok && types.result.rideTypes.find((t) => t.name === "Merry-Go-Round");
  expect("merry-go-round is 3x3 built from its centre tile",
    merry && merry.footprint === "3x3" && merry.originOffset.x === -1 && merry.originOffset.y === -1,
    JSON.stringify(merry));

  // A path on (47,50) makes (48,50) the entrance site guests can already reach.
  sandbox.context.executeAction("footpathplace", { x: 47 * 32, y: 50 * 32, z: 32 }, () => {});

  const build = await rpc(sock, n++, "build_ride", { x: 50, y: 50, object: 0, name: "Carousel" });
  expect("build_ride places a merry-go-round", build.ok, JSON.stringify(build.error));
  const b = build.result || {};
  expect("footprint covers (49,49)-(51,51)",
    b.footprint && b.footprint.tiles.length === 9
    && b.footprint.tiles.some((t) => t.x === 49 && t.y === 49)
    && b.footprint.tiles.some((t) => t.x === 51 && t.y === 51)
    && !b.footprint.tiles.some((t) => t.x === 52 || t.y === 52),
    JSON.stringify(b.footprint));
  expect("entrance goes to the side a path already reaches",
    b.entrance && b.entrance.placed && b.entrance.x === 48 && b.entrance.y === 50
    && b.entrance.connectAt.x === 47 && b.entrance.connectAt.y === 50 && b.entrance.path.connected,
    JSON.stringify(b.entrance));
  expect("exit is built on a different legal tile",
    b.exit && b.exit.placed && !(b.exit.x === 48 && b.exit.y === 50)
    && !(b.exit.x === 48 && b.exit.y === 48) && !(b.exit.x === 52 && b.exit.y === 52),
    JSON.stringify(b.exit));
  expect("build_ride warns that nothing reaches the exit",
    Array.isArray(b.warnings) && b.warnings.some((w) => w.indexOf("exit") >= 0),
    JSON.stringify(b.warnings));

  const rideId = b.rideId;
  const access = await rpc(sock, n++, "check_ride_access", { ride_id: rideId });
  expect("check_ride_access sees both pieces built",
    access.ok && access.result.stations[0].entrance.built && access.result.stations[0].exit.built,
    JSON.stringify(access.result || access.error).slice(0, 240));

  const badSide = await rpc(sock, n++, "build_ride_entrance", { ride_id: rideId, x: 48, y: 48, is_exit: true });
  expect("build_ride_entrance refuses a corner the piece cannot take",
    !badSide.ok && String(badSide.error).indexOf("not a tile") >= 0, String(badSide.error).slice(0, 200));

  const moved = await rpc(sock, n++, "build_ride_entrance", { ride_id: rideId, x: 52, y: 50, is_exit: true });
  expect("build_ride_entrance moves the exit to a legal tile",
    moved.ok && moved.result.x === 52 && moved.result.y === 50
    && moved.result.connectAt.x === 53 && moved.result.connectAt.y === 50,
    JSON.stringify(moved.result || moved.error).slice(0, 200));

  const wrongTool = await rpc(sock, n++, "build_ride", { x: 60, y: 60, object: 2 });
  expect("build_ride sends stalls to build_shop",
    !wrongTool.ok && String(wrongTool.error).indexOf("build_shop") >= 0, String(wrongTool.error).slice(0, 160));

  const coaster = await rpc(sock, n++, "build_ride", { x: 60, y: 60, object: 3 });
  expect("build_ride says why a coaster is out of reach",
    !coaster.ok && String(coaster.error).indexOf("tracked ride") >= 0, String(coaster.error).slice(0, 160));

  const gone = await rpc(sock, n++, "remove_ride", { ride_id: rideId });
  expect("remove_ride takes the whole footprint",
    gone.ok && gone.result.tiles.length === 9, JSON.stringify(gone.result || gone.error).slice(0, 200));

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  sock.end();
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
