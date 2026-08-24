import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import fs from "node:fs";
import path from "node:path";
import { RctClient } from "./rct-client";
import { DEFAULT_PORT, Methods } from "../shared/protocol";

// --- config ----------------------------------------------------------------

const PORT = Number(process.env.RCT2_PORT || DEFAULT_PORT);
// OpenRCT2 user directory (Windows path, since the server runs under Windows node).
const USER_DIR =
  process.env.RCT2_USER_DIR ||
  "C:\\Users\\casey\\OneDrive\\Documents\\OpenRCT2";
const SCREENSHOT_DIR = path.join(USER_DIR, "screenshot");
const SAVE_DIR = path.join(USER_DIR, "save");
const SNAPSHOT_ROOT = "agent"; // filename prefix: SAVE_DIR/agent__<play>__<label>.park
const DELETE_CAPTURES = process.env.RCT2_KEEP_CAPTURES ? false : true;

const client = new RctClient(PORT);

// --- helpers ---------------------------------------------------------------

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function errText(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

const server = new McpServer({ name: "rct2-agent", version: "0.1.0" });

/** Register a tool that forwards args straight to a plugin method and returns JSON. */
function passthrough(
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  method: string,
  opts: { timeoutMs?: number; map?: (args: any) => Record<string, unknown> } = {},
) {
  server.registerTool(name, { description, inputSchema }, async (args: any) => {
    try {
      const params = opts.map ? opts.map(args) : (args ?? {});
      const result = await client.call(method, params, opts.timeoutMs ?? 30000);
      return jsonText(result);
    } catch (e: any) {
      return errText(e?.message ?? String(e));
    }
  });
}

// wait for a capture file to appear, read it, base64 it, optionally delete it.
async function readCapture(filename: string): Promise<{ data: string } | { error: string }> {
  const full = path.join(SCREENSHOT_DIR, filename);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(full);
      if (st.size > 0) {
        // give the writer a beat to finish flushing, then read.
        await new Promise((r) => setTimeout(r, 120));
        const buf = fs.readFileSync(full);
        if (DELETE_CAPTURES) {
          try { fs.unlinkSync(full); } catch { /* ignore */ }
        }
        return { data: buf.toString("base64") };
      }
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { error: `capture file did not appear at ${full} within timeout` };
}

async function captureTool(method: string, params: Record<string, unknown>) {
  try {
    const res: any = await client.call(method, params, 15000);
    const filename: string = res.filename;
    const img = await readCapture(filename);
    if ("error" in img) return errText(img.error);
    return {
      content: [
        { type: "image" as const, data: img.data, mimeType: "image/png" },
        { type: "text" as const, text: JSON.stringify({ filename, zoom: res.zoom, rotation: res.rotation }) },
      ],
    };
  } catch (e: any) {
    return errText(e?.message ?? String(e));
  }
}

// ===========================================================================
// 1. READ — the eyes
// ===========================================================================

passthrough("get_park_summary",
  "Park snapshot: cash, loan, park/company value, rating, guests, entry fee, and the current in-game date.",
  {}, Methods.GetParkSummary);

passthrough("get_finance_report",
  "Current-month income and cost broken down by category (income positive, costs negative), plus net and cash.",
  {}, Methods.GetFinanceReport);

passthrough("list_rides",
  "Every ride (not shops): price, ratings, queue time, hourly income, total profit/customers, satisfaction, reliability, breakdown, inspection interval.",
  {}, Methods.ListRides);

passthrough("get_ride",
  "Full detail for one ride by id.",
  { ride_id: z.number().int().describe("Ride id from list_rides") },
  Methods.GetRide);

passthrough("list_shops",
  "Stalls and facilities with their item prices, hourly income, total profit, and customers.",
  {}, Methods.ListShops);

passthrough("get_guest_overview",
  "Guest count, average happiness (0-100), average cash, and counts of hungry / thirsty / need-toilet / lost / unhappy guests.",
  {}, Methods.GetGuestOverview);

passthrough("sample_guest_thoughts",
  "Recent guest thoughts grouped and counted, most common first (e.g. '38 guests: X costs too much'). Cheap signal — does not dump every guest.",
  { limit: z.number().int().min(1).max(100).optional().describe("Max distinct thoughts to return (default 20)") },
  Methods.SampleGuestThoughts, { map: (a) => ({ limit: a.limit ?? 20 }) });

passthrough("list_staff",
  "Staff grouped by type (handyman / mechanic / security / entertainer) with ids and energy.",
  {}, Methods.ListStaff);

passthrough("get_scenario",
  "Scenario objective, deadline, status, and rating-warning days — the win/lose condition the agent is playing toward.",
  {}, Methods.GetScenario);

// ===========================================================================
// 2. ACT — the hands (all writes go through game actions; game limits apply)
// ===========================================================================

passthrough("set_ride_price",
  "Set a ride's admission price in dollars. Honors the game's price cap.",
  {
    ride_id: z.number().int(),
    price: z.number().min(0).describe("Price in dollars, e.g. 3.50"),
    is_primary: z.boolean().optional().describe("Primary (admission) vs secondary (on-ride photo) price. Default true."),
  },
  Methods.SetRidePrice,
  { map: (a) => ({ ride_id: a.ride_id, price: a.price, is_primary: a.is_primary ?? true }) });

passthrough("set_shop_price",
  "Set a shop/stall item price in dollars.",
  {
    shop_id: z.number().int(),
    price: z.number().min(0),
    is_primary: z.boolean().optional().describe("Primary item vs secondary item price. Default true."),
  },
  Methods.SetShopPrice,
  { map: (a) => ({ shop_id: a.shop_id, price: a.price, is_primary: a.is_primary ?? true }) });

passthrough("set_park_entry_fee",
  "Set the park entrance fee in dollars.",
  { amount: z.number().min(0) },
  Methods.SetParkEntryFee);

passthrough("set_park_open",
  "Open or close the park itself to the public. This is separate from individual ride open/closed status — guests never spawn while the park is closed, regardless of how many rides are open.",
  { open: z.boolean() },
  Methods.SetParkOpen);

passthrough("open_ride", "Open a ride.",
  { ride_id: z.number().int() }, Methods.OpenRide);
passthrough("close_ride", "Close a ride.",
  { ride_id: z.number().int() }, Methods.CloseRide);

passthrough("set_inspection_interval",
  "Set how often a ride is inspected, in minutes (10/20/30/45/60/120; 0 or >120 = never). Fewer breakdowns.",
  { ride_id: z.number().int(), minutes: z.number().int() },
  Methods.SetInspectionInterval);

passthrough("start_marketing_campaign",
  "Start a marketing campaign for N weeks. Types: free_park_entry, free_ride, half_price_park_entry, free_food_drink, advertise_park, advertise_ride. Ride/food campaigns need 'item' (a ride id).",
  {
    type: z.enum(["free_park_entry", "free_ride", "half_price_park_entry", "free_food_drink", "advertise_park", "advertise_ride"]),
    weeks: z.number().int().min(1),
    item: z.number().int().optional().describe("Ride id (or shop item), for ride/food campaigns"),
  },
  Methods.StartMarketingCampaign,
  { map: (a) => ({ type: a.type, weeks: a.weeks, item: a.item ?? 0 }) });

passthrough("set_research_funding",
  "Set research funding level: 0 none, 1 minimum, 2 normal, 3 maximum.",
  { level: z.number().int().min(0).max(3) },
  Methods.SetResearchFunding);

passthrough("hire_staff",
  "Hire one staff member: handyman, mechanic, security, or entertainer. Returns the new staff id.",
  { type: z.enum(["handyman", "mechanic", "security", "entertainer"]) },
  Methods.HireStaff);

passthrough("fire_staff", "Fire a staff member by id.",
  { staff_id: z.number().int() }, Methods.FireStaff);

passthrough("set_staff_patrol",
  "Set a staff member's patrol area as a tile rectangle (x1,y1)-(x2,y2). mode 0 = set, 1 = clear.",
  {
    staff_id: z.number().int(),
    x1: z.number().int(), y1: z.number().int(),
    x2: z.number().int(), y2: z.number().int(),
    mode: z.number().int().optional().describe("0 set (default), 1 clear"),
  },
  Methods.SetStaffPatrol,
  { map: (a) => ({ staff_id: a.staff_id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, mode: a.mode ?? 0 }) });

passthrough("set_loan",
  "Set the outstanding bank loan in dollars (borrow more or repay). Capped by the scenario's max loan.",
  { amount: z.number().min(0) },
  Methods.SetLoan);

// ===========================================================================
// 2b. BUILD — footpaths, one tile per call
// ===========================================================================

passthrough("inspect_area",
  "Get a cheap ASCII overview of the map around a tile, plus counts of what's out there (paths, queues, entrances, track, scenery, walls, water, unowned land). This is how you see terrain at a glance and decide where to look closer — a screenshot cannot tell you z, and this tool doesn't give you z either. It carries no per-tile height or element detail on purpose, so a wide radius stays cheap: call get_tile_detail on the specific tiles you're about to inspect or build on for exact ground height/slope/water and the full detail of anything placed there.",
  {
    x: z.number().int().describe("Center tile X"),
    y: z.number().int().describe("Center tile Y"),
    radius: z.number().int().min(0).max(24).optional().describe("Tiles out from center (default 6, max 24)"),
  },
  Methods.InspectArea,
  { map: (a) => ({ x: a.x, y: a.y, radius: a.radius ?? 6 }) });

passthrough("get_tile_detail",
  "Get exact per-tile detail for a small, explicit list of tiles: ground height (low corner `z` and high corner `topZ`), slope, water level, ownership, and full detail of every element placed there — footpaths (with `edgeZ`, the world z each of the tile's four sides presents; two neighbouring paths are walkable between ONLY if the edges they turn to each other are both non-null and exactly equal), ride entrances/exits (with `connectAt`, the tile a path has to sit on to reach them — `direction` points INTO the ride, not out toward guests), track, small/large scenery, walls, and banners, each with its object name. Call this on the handful of tiles you're actually about to act on (found via inspect_area, get_ride, or check_ride_access) rather than sweeping a whole area — cost scales with tiles requested, not map size.",
  {
    tiles: z.array(z.object({ x: z.number().int(), y: z.number().int() })).min(1).max(40)
      .describe("Tiles to inspect, up to 40 per call."),
  },
  Methods.GetTileDetail,
  { map: (a) => ({ tiles: a.tiles }) });

passthrough("list_path_styles",
  "List the footpath objects loaded in this park (surface + railings, or legacy paths) with the indices place_path accepts. Call once; place_path picks a sensible default without it.",
  {}, Methods.ListPathStyles);

passthrough("place_path",
  "Place ONE footpath tile, following the terrain by default: z defaults to the tile's high corner for a flat path and its low corner for a sloped one, so on flat ground you need only x and y. Pass height_offset to raise it in whole land levels, or z for an exact world z. Omit slope_direction for a flat tile; set it (0-3) to slope the tile upward toward that direction, with z as the LOW end. On sloping ground a flat tile is often rejected with 'Raise or lower land first' — slope the tile to match the terrain instead, checking the tile's slope via get_tile_detail. Errors carry the game's own reason; read it and adjust. Works while the game is paused. Call repeatedly to build a route — and after each call READ THE CONNECTION REPORT before placing the next tile: `connectedTo` lists what this tile actually joined, `neighborsNotConnected` names every neighbouring path or entrance it missed and why, with `connectAtZ` giving the z that would have worked, and `edgeZ` gives the heights this tile now presents on its four sides for the next one to meet. A tile that comes back with an empty `connectedTo` and a `warning` has broken the route: fix it before continuing, because a path one land level off its neighbour looks like a finished route from above and is not walkable. To reach a ride entrance or exit, build on the connectAt tile that get_ride / check_ride_access report — do NOT derive it from the entrance's `direction`, which points into the ride, not out toward the guests.",
  {
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int().optional().describe("Exact world z. Omit to sit on the ground at this tile."),
    height_offset: z.number().int().optional().describe("Land levels above the resolved z (default 0). Use for elevated path."),
    slope_direction: z.number().int().min(0).max(3).optional().describe("Omit for flat. 0-3 = path rises toward this direction; z is the low end."),
    queue: z.boolean().optional().describe("Build a queue line instead of a normal path (default false)."),
    object: z.number().int().optional().describe("Path surface object index from list_path_styles."),
    railings_object: z.number().int().optional().describe("Railings object index from list_path_styles."),
  },
  Methods.PlacePath,
  { map: (a) => {
    const o: Record<string, unknown> = { x: a.x, y: a.y };
    if (a.z !== undefined) o.z = a.z;
    if (a.height_offset !== undefined) o.height_offset = a.height_offset;
    if (a.slope_direction !== undefined) o.slope_direction = a.slope_direction;
    if (a.queue !== undefined) o.queue = a.queue;
    if (a.object !== undefined) o.object = a.object;
    if (a.railings_object !== undefined) o.railings_object = a.railings_object;
    return o;
  } });

passthrough("check_ride_access",
  "Check whether guests can actually reach a ride: per station it reports the entrance and exit, the exact tile a footpath must occupy to connect to each (connectAt), and whether a path is there at the right height — plus a flat `problems` list naming what to fix. Use this instead of reading a footpath's `edges`, which only records path-to-path links and never shows a connection to a ride entrance. A ride needs BOTH entrance and exit connected. Stalls have no entrance element and are checked for an adjacent path instead.",
  { ride_id: z.number().int().describe("Ride or shop id from list_rides / list_shops") },
  Methods.CheckRideAccess);

passthrough("remove_path",
  "Remove one footpath tile, for backtracking a bad placement. z is optional when the tile has exactly one path.",
  {
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int().optional().describe("World z of the path to remove. Required only if paths are stacked on this tile."),
  },
  Methods.RemovePath,
  { map: (a) => (a.z === undefined ? { x: a.x, y: a.y } : { x: a.x, y: a.y, z: a.z }) });

// ===========================================================================
// 3. SEE — vision
// ===========================================================================

server.registerTool("capture_view",
  { description: "Screenshot the park. Optionally center on tile (x,y). zoom 0=1:1,1=2:1,2=4:1; rotation 0-3.",
    inputSchema: {
      x: z.number().optional().describe("Center tile X (optional)"),
      y: z.number().optional().describe("Center tile Y (optional)"),
      zoom: z.number().int().min(0).max(3).optional(),
      rotation: z.number().int().min(0).max(3).optional(),
    } },
  async (a: any) => {
    const params: Record<string, unknown> = { zoom: a.zoom ?? 1, rotation: a.rotation ?? 0 };
    if (a.x !== undefined) params.x = a.x;
    if (a.y !== undefined) params.y = a.y;
    return captureTool(Methods.CaptureView, params);
  });

server.registerTool("capture_ride",
  { description: "Screenshot centered on one ride.",
    inputSchema: {
      ride_id: z.number().int(),
      zoom: z.number().int().min(0).max(3).optional(),
      rotation: z.number().int().min(0).max(3).optional(),
    } },
  async (a: any) => captureTool(Methods.CaptureRide, { ride_id: a.ride_id, zoom: a.zoom ?? 0, rotation: a.rotation ?? 0 }));

passthrough("find_location",
  "Find tile coordinates for a named ride (substring match). Use the result with capture_view.",
  { name: z.string() },
  Methods.FindLocation);

passthrough("find_park_entrance",
  "Locate the park entrance by scanning the map. Returns each of its three tiles (sequence "
  + "0-2), with connectAt (the tile a footpath must occupy to reach the walkable centre tile) "
  + "and whether a path is already connected there.",
  {},
  Methods.FindParkEntrance);

// ===========================================================================
// 4. CONTROL TIME
// ===========================================================================

passthrough("get_clock", "Current in-game date, game speed, and paused state.",
  {}, Methods.GetClock);

passthrough("set_game_speed", "Set game speed 0-4 (0 normal ... 4 hyper).",
  { speed: z.number().int().min(0).max(4) }, Methods.SetGameSpeed);

passthrough("pause", "Pause the game.", {}, Methods.Pause);
passthrough("resume", "Resume the game.", {}, Methods.Resume);

passthrough("advance_days",
  "Run the game forward N in-game days at high speed, then auto-pause and return the new clock. The core measure→act→wait→measure tool. Blocks until done.",
  {
    days: z.number().int().min(1).max(365),
    max_speed: z.number().int().min(1).max(4).optional().describe("Speed to run at while advancing (default 4)"),
  },
  Methods.AdvanceDays,
  { timeoutMs: 240000, map: (a) => ({ days: a.days, max_speed: a.max_speed ?? 4 }) });

// ===========================================================================
// 5. SAVE / LOAD (snapshots; restore is a manual Load in-game)
// ===========================================================================

/**
 * Snapshot names are flat files in the save root: `agent__<play>__<label>.park`.
 * context.saveGame refuses any filename containing a path separator (it fails
 * silently — the plugin gets no error back), so subfolders are not an option
 * and the play name is folded into the filename instead. "_" is not allowed in
 * either part, which keeps "__" an unambiguous separator when parsing back.
 */
const snapPart = (s: string) => String(s).replace(/[^A-Za-z0-9.-]/g, "-");
const snapName = (play: string, label: string) => `${SNAPSHOT_ROOT}__${play}__${label}`;

server.registerTool("snapshot",
  { description: "Save a snapshot as save/agent__<play>__<label>.park, which shows up in the in-game Load Game menu. Restoring is a manual Load in the game — this only writes the save.",
    inputSchema: {
      play: z.string().optional().describe("Playthrough name (default 'play')"),
      label: z.string().describe("Snapshot name, e.g. 'week-12-pricing'"),
    } },
  async (a: any) => {
    const play = snapPart(a.play ?? "play");
    const label = snapPart(a.label);
    const filename = snapName(play, label);
    const file = path.join(SAVE_DIR, `${filename}.park`);
    try {
      const result: any = await client.call(Methods.Snapshot, { filename }, 20000);
      // saveGame returns void and swallows its own write errors, so confirm the
      // file actually landed rather than reporting a save that never happened.
      if (!fs.existsSync(file)) {
        return errText(`the game reported no error but nothing was written to ${file} — check the OpenRCT2 console for a save error`);
      }
      return jsonText({ ...result, play, label, file, note: "To roll back, load this file from the in-game Load Game menu." });
    } catch (e: any) {
      return errText(e?.message ?? String(e));
    }
  });

server.registerTool("list_snapshots",
  { description: "List saved snapshots (reads save/agent__*.park).",
    inputSchema: { play: z.string().optional().describe("Playthrough to filter by; omit to list all") } },
  async (a: any) => {
    try {
      const wanted = a.play ? snapPart(a.play) : null;
      const prefix = `${SNAPSHOT_ROOT}__`;
      const out: Array<{ play: string; label: string; savedAt: string; file: string }> = [];
      for (const entry of fs.readdirSync(SAVE_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".park")) continue;
        const [play, ...rest] = entry.name.slice(prefix.length, -".park".length).split("__");
        if (!rest.length || (wanted && play !== wanted)) continue;
        const p = path.join(SAVE_DIR, entry.name);
        out.push({ play, label: rest.join("__"), savedAt: fs.statSync(p).mtime.toISOString(), file: p });
      }
      out.sort((x, y) => y.savedAt.localeCompare(x.savedAt));
      if (!out.length) return jsonText({ snapshots: [], note: `no snapshots yet in ${SAVE_DIR}` });
      return jsonText({ count: out.length, snapshots: out });
    } catch (e: any) {
      return errText(e?.message ?? String(e));
    }
  });

// ===========================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[rct2-agent] MCP server ready (plugin port ${PORT}, user dir ${USER_DIR})\n`);
}

main().catch((e) => {
  process.stderr.write(`[rct2-agent] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
