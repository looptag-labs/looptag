import { Buffer } from "buffer";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  fetchEventsViaServer,
  pollLooptagEvents,
  type PollLooptagEventsOptions,
  type PolledLooptagEventPage,
} from "./events-poller.js";

export {
  DEFAULT_EVENT_PAGE_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  LooptagRpcError,
  decodeRawEventBatch,
  pollLooptagEvents,
  type LooptagRpcErrorOptions,
  type PollLooptagEventsOptions,
  type PolledLooptagEvent,
  type PolledLooptagEventPage,
  type SkippedEventWarning,
} from "./events-poller.js";

export type LooptagEvent =
  | { type: "init"; admin: string; depositToken: string }
  | {
      type: "merchant_registered";
      merchant: string;
      name: string;
      active: boolean;
    }
  | {
      type: "merchant_status_changed";
      merchant: string;
      name: string;
      active: boolean;
    }
  | {
      type: "station_changed";
      issuer: string;
      station: string;
      authorized: boolean;
    }
  | {
      type: "claim_issued";
      claimId: string;
      issuer: string;
      owner: string;
      deposit: bigint;
      serialHash: string;
      expiresAt: number;
    }
  | { type: "claim_transferred"; claimId: string; from: string; to: string }
  | {
      type: "return_authorized";
      claimId: string;
      station: string;
      returnedAt: number;
    }
  | { type: "claim_redeemed"; claimId: string; owner: string; deposit: bigint }
  | { type: "pause_changed"; admin: string; paused: boolean }
  | { type: "admin_transfer_proposed"; admin: string; newAdmin: string }
  | { type: "admin_transfer_cancelled"; admin: string }
  | { type: "admin_changed"; oldAdmin: string; newAdmin: string };

/**
 * Decode a raw Soroban event emitted by LOOPTAG.
 *
 * `topics` is the event's topic array and `value` is its data value. Unknown
 * events return `null` so an indexer can safely ignore other contracts or
 * future event versions.
 */
export function decodeLooptagEvent(
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): LooptagEvent | null {
  const name = topics[0] ? String(scValToNative(topics[0])) : "";
  const rawData = scValToNative(value);

  switch (name) {
    case "init": {
      const data = requireDataTuple(name, rawData, 1);
      return {
        type: "init",
        admin: topicString(name, topics[1]),
        depositToken: String(data[0]),
      };
    }
    case "merchant_registered": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "merchant_registered",
        merchant: topicString(name, topics[1]),
        name: String(data[0]),
        active: Boolean(data[1]),
      };
    }
    case "merchant_status_changed": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "merchant_status_changed",
        merchant: topicString(name, topics[1]),
        name: String(data[0]),
        active: Boolean(data[1]),
      };
    }
    case "station_changed": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "station_changed",
        issuer: topicString(name, topics[1]),
        station: String(data[0]),
        authorized: Boolean(data[1]),
      };
    }
    case "claim_issued": {
      const data = requireDataTuple(name, rawData, 5);
      return {
        type: "claim_issued",
        claimId: claimIdFromTopic(topics[1]),
        issuer: String(data[0]),
        owner: String(data[1]),
        deposit: BigInt(data[2] as bigint),
        serialHash: toHex(data[3]),
        expiresAt: Number(data[4]),
      };
    }
    case "claim_transferred": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "claim_transferred",
        claimId: claimIdFromTopic(topics[1]),
        from: String(data[0]),
        to: String(data[1]),
      };
    }
    case "return_authorized": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "return_authorized",
        claimId: claimIdFromTopic(topics[1]),
        station: String(data[0]),
        returnedAt: Number(data[1]),
      };
    }
    case "claim_redeemed": {
      const data = requireDataTuple(name, rawData, 2);
      return {
        type: "claim_redeemed",
        claimId: claimIdFromTopic(topics[1]),
        owner: String(data[0]),
        deposit: BigInt(data[1] as bigint),
      };
    }
    case "pause_changed": {
      const data = requireDataTuple(name, rawData, 1);
      return {
        type: "pause_changed",
        admin: topicString(name, topics[1]),
        paused: Boolean(data[0]),
      };
    }
    case "admin_transfer_proposed": {
      const data = requireDataTuple(name, rawData, 1);
      return {
        type: "admin_transfer_proposed",
        admin: topicString(name, topics[1]),
        newAdmin: String(data[0]),
      };
    }
    case "admin_transfer_cancelled": {
      requireDataTuple(name, rawData, 0);
      return {
        type: "admin_transfer_cancelled",
        admin: topicString(name, topics[1]),
      };
    }
    case "admin_changed": {
      const data = requireDataTuple(name, rawData, 1);
      return {
        type: "admin_changed",
        oldAdmin: topicString(name, topics[1]),
        newAdmin: String(data[0]),
      };
    }
    default:
      return null;
  }
}

function requireDataTuple(
  eventName: string,
  rawData: unknown,
  minLength: number,
): unknown[] {
  if (!Array.isArray(rawData) || rawData.length < minLength) {
    throw new TypeError(
      `${eventName} event value must be an ScVec of length >= ${minLength}`,
    );
  }
  return rawData;
}

function topicString(eventName: string, topic: xdr.ScVal | undefined): string {
  if (!topic) {
    throw new TypeError(`${eventName} event is missing its address topic`);
  }
  return String(scValToNative(topic));
}

function claimIdFromTopic(topic: xdr.ScVal | undefined): string {
  if (!topic) {
    throw new TypeError("claim event is missing its claim id topic");
  }
  return BigInt(scValToNative(topic)).toString();
}

function toHex(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  return String(value);
}

export interface DecodedLooptagEvent {
  event: LooptagEvent;
  /** RPC event id, usable as the next cursor. */
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId?: string;
}

export interface LooptagEventPage {
  events: DecodedLooptagEvent[];
  /** Cursor to pass into the next page. */
  cursor: string;
  latestLedger: number;
}

export interface FetchLooptagEventsOptions {
  /** Contract id whose events should be read. */
  contractId: string;
  /** First ledger to scan when `cursor` is not set. */
  startLedger?: number;
  /** Continue after a previous page's cursor. */
  cursor?: string;
  /** Page size, 1-1000. Defaults to 100. */
  limit?: number;
}

/**
 * Fetch and decode one page of LOOPTAG events from Soroban RPC.
 *
 * Accepts either a direct `{ rpcUrl, contractId?, startLedger?, endLedger?, cursor?, limit?, fetchFn? }`
 * configuration object or an existing `rpc.Server` instance plus `{ contractId, startLedger?, cursor?, limit? }`.
 *
 * The function deliberately does not run a polling loop: callers can persist
 * `page.cursor`, schedule the next poll, or reconcile a gap after downtime.
 * Unknown events from future versions are ignored, and malformed XDR payloads
 * are isolated per event into `page.warnings` (`page.skipped`).
 */
export async function fetchLooptagEvents(
  options: PollLooptagEventsOptions,
): Promise<PolledLooptagEventPage>;
export async function fetchLooptagEvents(
  server: rpc.Server,
  options: FetchLooptagEventsOptions,
): Promise<PolledLooptagEventPage>;
export async function fetchLooptagEvents(
  serverOrOptions: rpc.Server | PollLooptagEventsOptions,
  maybeOptions?: FetchLooptagEventsOptions,
): Promise<PolledLooptagEventPage> {
  if (isPollOptions(serverOrOptions, maybeOptions)) {
    return pollLooptagEvents(serverOrOptions);
  }
  return fetchEventsViaServer(
    serverOrOptions as rpc.Server,
    maybeOptions as FetchLooptagEventsOptions,
  );
}

function isPollOptions(
  serverOrOptions: rpc.Server | PollLooptagEventsOptions,
  maybeOptions?: FetchLooptagEventsOptions,
): serverOrOptions is PollLooptagEventsOptions {
  if (maybeOptions !== undefined) {
    return false;
  }
  return (
    typeof serverOrOptions === "object" &&
    serverOrOptions !== null &&
    !(
      "getEvents" in serverOrOptions &&
      typeof serverOrOptions.getEvents === "function"
    )
  );
}
