import { Buffer } from "buffer";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

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
  const data = scValToNative(value) as unknown[];

  switch (name) {
    case "init":
      return {
        type: "init",
        admin: String(scValToNative(topics[1])),
        depositToken: String(data[0]),
      };
    case "merchant_registered":
      return {
        type: "merchant_registered",
        merchant: String(scValToNative(topics[1])),
        name: String(data[0]),
        active: Boolean(data[1]),
      };
    case "merchant_status_changed":
      return {
        type: "merchant_status_changed",
        merchant: String(scValToNative(topics[1])),
        name: String(data[0]),
        active: Boolean(data[1]),
      };
    case "station_changed":
      return {
        type: "station_changed",
        issuer: String(scValToNative(topics[1])),
        station: String(data[0]),
        authorized: Boolean(data[1]),
      };
    case "claim_issued":
      return {
        type: "claim_issued",
        claimId: claimIdFromTopic(topics[1]),
        issuer: String(data[0]),
        owner: String(data[1]),
        deposit: BigInt(data[2] as bigint),
        serialHash: toHex(data[3]),
        expiresAt: Number(data[4]),
      };
    case "claim_transferred":
      return {
        type: "claim_transferred",
        claimId: claimIdFromTopic(topics[1]),
        from: String(data[0]),
        to: String(data[1]),
      };
    case "return_authorized":
      return {
        type: "return_authorized",
        claimId: claimIdFromTopic(topics[1]),
        station: String(data[0]),
        returnedAt: Number(data[1]),
      };
    case "claim_redeemed":
      return {
        type: "claim_redeemed",
        claimId: claimIdFromTopic(topics[1]),
        owner: String(data[0]),
        deposit: BigInt(data[1] as bigint),
      };
    case "pause_changed":
      return {
        type: "pause_changed",
        admin: String(scValToNative(topics[1])),
        paused: Boolean(data[0]),
      };
    case "admin_transfer_proposed":
      return {
        type: "admin_transfer_proposed",
        admin: String(scValToNative(topics[1])),
        newAdmin: String(data[0]),
      };
    case "admin_transfer_cancelled":
      return {
        type: "admin_transfer_cancelled",
        admin: String(scValToNative(topics[1])),
      };
    case "admin_changed":
      return {
        type: "admin_changed",
        oldAdmin: String(scValToNative(topics[1])),
        newAdmin: String(data[0]),
      };
    default:
      return null;
  }
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
 * The function deliberately does not run a polling loop: callers can persist
 * `page.cursor`, schedule the next poll, or reconcile a gap after downtime.
 * Unknown events from future versions are ignored, not treated as errors.
 */
export async function fetchLooptagEvents(
  server: rpc.Server,
  options: FetchLooptagEventsOptions,
): Promise<LooptagEventPage> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  if (options.cursor && options.startLedger !== undefined) {
    throw new TypeError("pass either cursor or startLedger, not both");
  }
  if (!options.cursor && options.startLedger === undefined) {
    throw new TypeError("fetchLooptagEvents needs a cursor or startLedger");
  }
  if (
    options.startLedger !== undefined &&
    (!Number.isInteger(options.startLedger) || options.startLedger < 1)
  ) {
    throw new RangeError("startLedger must be a positive integer");
  }

  const filters = [
    {
      type: "contract" as const,
      contractIds: [options.contractId],
    },
  ];
  const request = options.cursor
    ? { cursor: options.cursor, filters, limit }
    : { startLedger: options.startLedger as number, filters, limit };

  const response = await server.getEvents(request);
  const events: DecodedLooptagEvent[] = [];

  for (const rpcEvent of response.events) {
    const eventContract = rpcEvent.contractId
      ? String(rpcEvent.contractId)
      : undefined;
    if (eventContract && eventContract !== options.contractId) {
      continue;
    }
    const decoded = decodeLooptagEvent(rpcEvent.topic, rpcEvent.value);
    if (!decoded) {
      continue;
    }
    events.push({
      event: decoded,
      id: rpcEvent.id,
      ledger: rpcEvent.ledger,
      ledgerClosedAt: rpcEvent.ledgerClosedAt,
      txHash: rpcEvent.txHash,
      contractId: eventContract,
    });
  }

  return {
    events,
    cursor: response.cursor,
    latestLedger: response.latestLedger,
  };
}
