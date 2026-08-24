// End-to-end MCP test: start a fake plugin listener, spawn the built MCP
// server, and drive it over stdio with real MCP JSON-RPC (initialize,
// tools/list, tools/call). Proves the server<->SDK<->client path.
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

// Not the default port: a real OpenRCT2 may already be sitting on that one.
const PLUGIN_PORT = 7898;

// --- fake plugin: echoes any method back as ok, with a couple of shaped replies
const fake = net.createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      let result;
      if (req.method === "get_park_summary") result = { name: "Fake Park", cash: 42000, rating: 900 };
      else if (req.method === "ping") result = { pong: true, apiVersion: 999 };
      else result = { echoed: req.method, params: req.params };
      sock.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    }
  });
});
fake.listen(PLUGIN_PORT, "127.0.0.1");

// --- spawn the MCP server
const server = spawn(process.execPath, [path.resolve("dist/server.mjs")], {
  env: { ...process.env, RCT2_PORT: String(PLUGIN_PORT) },
  stdio: ["pipe", "pipe", "inherit"],
});

let outBuf = "";
const waiters = new Map();
server.stdout.setEncoding("utf8");
server.stdout.on("data", (d) => {
  outBuf += d;
  let i;
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i).trim();
    outBuf = outBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

function send(id, method, params) {
  return new Promise((resolve) => {
    if (id !== null) waiters.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    if (id === null) resolve();
  });
}

async function run() {
  await new Promise((r) => setTimeout(r, 400));
  const init = await send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  console.log("initialize:", init.result?.serverInfo?.name, init.result?.protocolVersion);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await send(2, "tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log(`tools/list: ${names.length} tools`);
  console.log(names.join(", "));

  const ping = await send(3, "tools/call", { name: "get_park_summary", arguments: {} });
  console.log("get_park_summary ->", ping.result?.content?.[0]?.text?.slice(0, 100));

  const priced = await send(4, "tools/call", { name: "set_ride_price", arguments: { ride_id: 1, price: 4.5 } });
  console.log("set_ride_price ->", priced.result?.content?.[0]?.text?.slice(0, 120));

  const expectFail = await send(5, "tools/call", { name: "get_ride", arguments: {} }); // missing required arg
  console.log("get_ride(no arg) isError:", expectFail.result?.isError === true || expectFail.error !== undefined);

  const built = await send(6, "tools/call", { name: "build_ride", arguments: { x: 50, y: 50, object: 3, direction: 1, name: "Carousel" } });
  console.log("build_ride ->", built.result?.content?.[0]?.text?.replace(/\s+/g, " ").slice(0, 160));

  const rideTools = ["list_ride_types", "build_ride", "build_ride_entrance", "remove_ride"];
  const haveRideTools = rideTools.every((t) => names.includes(t));
  console.log("ride tools registered:", haveRideTools);

  const okCount = names.length >= 25 && haveRideTools && init.result
    && ping.result?.content?.[0]?.text?.includes("Fake Park")
    && built.result?.content?.[0]?.text?.includes("\"direction\": 1");
  console.log(okCount ? "\nMCP SMOKE: PASS" : "\nMCP SMOKE: FAIL");
  server.kill();
  fake.close();
  process.exit(okCount ? 0 : 1);
}
run().catch((e) => { console.error(e); server.kill(); fake.close(); process.exit(1); });
