# rct2-agent

An MCP server + OpenRCT2 plugin that lets an agent **sidecar-manage** your park
while you play: read the state, act on the business (prices, staff, marketing,
loans), lay footpaths and put up shops, see the park (screenshots), and control
time.

Building is deliberately narrow. The agent can place **footpaths** and **stalls
and facilities** — the things a park needs a lot of and that fit on one tile.
Rides are still hands-off: it can recommend one, but not build it.

## How it fits together

```
Claude Code (WSL)
      │ stdio (MCP)
      ▼
MCP server  ── dist/server.mjs, run by Windows node.exe
      │ TCP 127.0.0.1:7860  (newline-delimited JSON)
      ▼
Plugin (intransient) ── loaded inside OpenRCT2, LISTENS on the port
      │
      ▼
   OpenRCT2 game
```

The server runs under **Windows** `node.exe` (there is no node in WSL), so both
the server and the plugin sit on the same Windows `localhost` — no WSL↔Windows
networking involved. The plugin listens (it's intransient, so it stays alive
across park loads); the server dials in and reconnects as needed.

## Requirements

- OpenRCT2 **0.5.4+** (QuickJS engine — needed for Promises/ES2023).
- Windows Node.js (found here at `C:\Program Files\nodejs\node.exe`).

## Build & install

From WSL, using the Windows toolchain:

```bash
# helper wrappers (or just call node.exe / npm-cli.js directly)
NODE="/mnt/c/Program Files/nodejs/node.exe"
NPM=("$NODE" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js")

"${NPM[@]}" install
"${NPM[@]}" run build          # builds dist/rct2-agent.plugin.js + dist/server.mjs
"${NPM[@]}" run install:plugin # copies the plugin into your OpenRCT2 plugin folder
```

`install:plugin` copies to
`C:\Users\casey\OneDrive\Documents\OpenRCT2\plugin\rct2-agent.plugin.js`
(override with `RCT2_PLUGIN_DIR`).

## Wire up the MCP server

A ready-to-use project config is in `.mcp.json`. In Claude Code, from the project
directory, it will be picked up automatically (approve it when prompted), or add
it explicitly:

```bash
claude mcp add rct2-agent --scope project \
  -- "/mnt/c/Program Files/nodejs/node.exe" \
     "C:\\Users\\casey\\OneDrive\\Desktop\\dead code projects\\rct2-agent\\dist\\server.mjs"
```

## Run

1. Launch OpenRCT2 and load a scenario. Confirm the plugin loaded — the in-game
   console shows `[rct2-agent] listening on 127.0.0.1:7860`.
2. Start Claude Code in this folder. The MCP server connects on first tool call.
3. Ask the agent to manage the park. The core loop is **measure → act → wait →
   measure**: read baselines, make changes, `advance_days(7)`, re-measure.

## Tools

**Read (eyes):** `get_park_summary`, `get_finance_report`, `list_rides`,
`get_ride`, `list_shops`, `get_guest_overview`, `sample_guest_thoughts`,
`list_staff`, `get_scenario`

**Act (hands):** `set_ride_price`, `set_shop_price`, `set_park_entry_fee`,
`set_park_open`, `open_ride`, `close_ride`, `set_inspection_interval`,
`start_marketing_campaign`, `set_research_funding`, `hire_staff`, `fire_staff`,
`set_staff_patrol`, `set_loan`

**Build — survey:** `inspect_area`, `get_tile_detail`, `check_ride_access`

**Build — footpaths:** `list_path_styles`, `place_path`, `remove_path`

**Build — shops & facilities:** `list_shop_types`, `build_shop`, `remove_shop`

**See (vision):** `capture_view`, `capture_ride`, `find_location`,
`find_park_entrance`

**Time:** `get_clock`, `set_game_speed`, `pause`, `resume`, `advance_days`

**Save:** `snapshot`, `list_snapshots`

### Notes on behavior

- **Money** is in plain dollars at the tool boundary; internally OpenRCT2 stores
  tenths, converted in `src/shared/protocol.ts` (`MONEY_FACTOR`). If a value looks
  off by 10×, that's the one knob to check.
- **Coordinates** in `capture_view` / `set_staff_patrol` / `find_location` are in
  **tiles** (converted to map units internally).
- **`advance_days`** unpauses, runs at max speed, and auto-pauses when the target
  date is reached — then returns the new clock. It blocks until done.
- **Snapshots** save to `save/agent__<play>__<label>.park`, flat in the save root
  so they appear in the in-game Load Game menu — `context.saveGame` silently
  refuses any filename with a path separator, so subfolders are not possible.
  Restoring is a **manual Load** in-game — the plugin API can save but not load
  a park.
- **Writes go through game actions**, so the game's own limits apply (e.g. the
  ride price cap). A rejected action comes back as a tool error.
- **Paths are one tile per call.** `place_path` reports what the new tile
  actually connected to and, more usefully, which neighbours it *missed* and by
  how much — a path one land level off its neighbour looks like a finished route
  from above and is not walkable.
- **Shops are entered from one side.** A stall or facility has no entrance
  element; guests use it from the single neighbouring tile it faces. `build_shop`
  turns the shop toward an adjacent path automatically, so building the path
  first is the easy order. Build it the other way round and you must pass
  `direction` yourself — there is no rotate action, so a shop facing the wrong
  way has to be removed and rebuilt. `check_ride_access` reports the facing side
  for shops and all four neighbours, so a mistake is visible.
- **Facilities are shops here.** Toilets, first aid, the cash machine and the
  information kiosk build exactly like a food stall and go through the same
  `list_shop_types` / `build_shop` / `remove_shop` tools.
- **A new shop opens closed and priced at 0** — `build_shop` says so in its
  result. Follow up with `set_shop_price` and `open_ride`.

## Dev

- `npm run typecheck` — tsc, no emit.
- `node scripts/smoke.mjs` — loads the built plugin into a stubbed game and
  exercises the handlers over a real socket.
- `node scripts/mcp-smoke.mjs` — spawns the built MCP server and drives it with
  real MCP JSON-RPC against a fake plugin.

## Layout

```
src/shared/protocol.ts   wire protocol + money conversion + method names
src/plugin/main.ts       the intransient in-game plugin (TCP listener + handlers)
src/server/rct-client.ts reconnecting TCP client to the plugin
src/server/index.ts      MCP server: tool definitions -> plugin methods
esbuild.mjs              builds both bundles
scripts/                 install + smoke tests
```
