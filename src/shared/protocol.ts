/**
 * Wire protocol shared by the MCP server and the in-game plugin.
 *
 * Transport: newline-delimited JSON over a single TCP connection on
 * 127.0.0.1. The plugin LISTENS (it is intransient and long-lived); the
 * server DIALS IN and reconnects as needed. Every message is one JSON object
 * terminated by "\n". No embedded newlines are produced by JSON.stringify.
 */

export const DEFAULT_PORT = 7860;

/** A request from server -> plugin. */
export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A response from plugin -> server. */
export interface RpcResponse {
  id: number;
  ok: boolean;
  /** Present when ok === true. */
  result?: unknown;
  /** Present when ok === false. */
  error?: string;
}

/**
 * OpenRCT2 stores currency in tenths of the park's unit ("dimes"): an internal
 * value of 200 renders as $20.00. Tools speak plain currency (dollars); the
 * boundary converts. Centralised here so it is trivial to correct if a given
 * build differs.
 */
export const MONEY_FACTOR = 10;

export function toGameMoney(dollars: number): number {
  return Math.round(dollars * MONEY_FACTOR);
}

export function fromGameMoney(internal: number): number {
  return internal / MONEY_FACTOR;
}

/**
 * Vertical units, matching OpenRCT2's kCoordsZStep / kLandHeightStep. Game
 * actions take z in world units; tile elements expose that directly as
 * `baseZ` (their `baseHeight` is the raw height unit, baseZ / COORDS_Z_STEP).
 * One visible land level is LAND_STEP_Z world units -- also how far a sloped
 * footpath rises across one tile.
 */
export const COORDS_Z_STEP = 8;
export const LAND_STEP_Z = 16;

/** Method names understood by the plugin dispatcher. Keep in sync with the server tools. */
export const Methods = {
  // meta / handshake
  Ping: "ping",
  // read: state
  GetParkSummary: "get_park_summary",
  GetFinanceReport: "get_finance_report",
  ListRides: "list_rides",
  GetRide: "get_ride",
  ListShops: "list_shops",
  GetGuestOverview: "get_guest_overview",
  SampleGuestThoughts: "sample_guest_thoughts",
  ListStaff: "list_staff",
  GetScenario: "get_scenario",
  // act: business
  SetRidePrice: "set_ride_price",
  SetShopPrice: "set_shop_price",
  SetParkEntryFee: "set_park_entry_fee",
  SetParkOpen: "set_park_open",
  OpenRide: "open_ride",
  CloseRide: "close_ride",
  SetInspectionInterval: "set_inspection_interval",
  StartMarketingCampaign: "start_marketing_campaign",
  SetResearchFunding: "set_research_funding",
  HireStaff: "hire_staff",
  FireStaff: "fire_staff",
  SetStaffPatrol: "set_staff_patrol",
  SetLoan: "set_loan",
  // build: paths
  InspectArea: "inspect_area",
  GetTileDetail: "get_tile_detail",
  ListPathStyles: "list_path_styles",
  PlacePath: "place_path",
  RemovePath: "remove_path",
  CheckRideAccess: "check_ride_access",
  // build: shops & facilities
  ListShopTypes: "list_shop_types",
  BuildShop: "build_shop",
  RemoveShop: "remove_shop",
  // vision
  CaptureView: "capture_view",
  CaptureRide: "capture_ride",
  FindLocation: "find_location",
  FindParkEntrance: "find_park_entrance",
  // time
  GetClock: "get_clock",
  SetGameSpeed: "set_game_speed",
  Pause: "pause",
  Resume: "resume",
  AdvanceDays: "advance_days",
  // save
  Snapshot: "snapshot",
  ListSnapshots: "list_snapshots",
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];
