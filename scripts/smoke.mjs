// Smoke test: load the BUILT plugin into a fake OpenRCT2 environment (stubbed
// globals) and exercise the wire protocol + a sample of handlers over a real
// TCP socket. Validates plugin dispatch without needing the game running.
//
// Usage: node scripts/smoke.mjs
import net from "node:net";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

const PORT = 7899;
const pluginCode = fs.readFileSync(path.resolve("dist/rct2-agent.plugin.js"), "utf8");

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
    executeAction(action, args, cb) {
      // simulate side effects for a couple of actions
      if (action === "gamesetspeed") gameSpeed = args.speed;
      if (action === "ridesetprice") {
        const r = rides.find((x) => x.id === args.ride);
        if (r) r.price[args.isPrimaryPrice ? 0 : 1] = args.price;
      }
      if (action === "staffhire") { cb && cb({ error: 0, peep: 777 }); return; }
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
    get numRides() { return rides.length; },
    get rides() { return rides; },
    getRide: (id) => rides.find((r) => r.id === id),
    getAllEntities: (type) => (type === "guest" ? guests : type === "staff" ? staff : []),
  },
  park: {
    name: "Test Park", cash: 500000, rating: 850, bankLoan: 100000, maxBankLoan: 200000,
    entranceFee: 50, guests: guests.length, suggestedGuestMaximum: 800,
    value: 1200000, companyValue: 1600000, totalAdmissions: 4321,
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

// The plugin listens on its DEFAULT_PORT (7860). Connect there.
const TARGET = 7860;

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
    ["snapshot", { filename: "agent/play/week-1" }],
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

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  sock.end();
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
