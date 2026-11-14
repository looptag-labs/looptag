import { rpc, xdr } from "@stellar/stellar-sdk";
import { TESTNET_CONTRACT_ID } from "./client.js";
import {
  decodeLooptagEvent,
  type DecodedLooptagEvent,
  type FetchLooptagEventsOptions,
  type LooptagEventPage,
} from "./events.js";
import { isValidContractId } from "./qr.js";

/** Default page size requested from Soroban RPC `getEvents`. */
export const DEFAULT_EVENT_PAGE_LIMIT = 100;

/** Maximum `pagination.limit` accepted by Soroban RPC `getEvents`. */
export const MAX_EVENT_PAGE_LIMIT = 10_000;

export interface PollLooptagEventsOptions {
  /** HTTP(S) URL of the Soroban JSON-RPC endpoint. */
  rpcUrl: string;
  /** LOOPTAG contract id (`C...`). Defaults to `TESTNET_CONTRACT_ID`. */
  contractId?: string;
  /**
   * Inclusive starting ledger for the first page when no `cursor` has been
   * persisted yet. Mutually exclusive with `cursor`.
   */
  startLedger?: number;
  /**
   * Optional upper ledger bound when scanning a fixed ledger window. Mutually
   * exclusive with `cursor`.
   */
  endLedger?: number;
  /**
   * Opaque cursor returned by a previous `fetchLooptagEvents` / `pollLooptagEvents`
   * call. Soroban RPC resumes strictly after this event id. Mutually exclusive
   * with `startLedger` and `endLedger`.
   */
  cursor?: string;
  /** Maximum raw RPC events to fetch in one call (`1..10000`, default `100`). */
  limit?: number;
  /** Optional `fetch` implementation for custom runtimes or offline tests. */
  fetchFn?: typeof fetch;
}

export type PolledLooptagEvent = DecodedLooptagEvent;

export interface SkippedEventWarning {
  /** Zero-based position in the raw RPC `events` array. */
  index: number;
  /** Raw event `id` if present on the malformed payload. */
  eventId?: string;
  /** Ledger number if present on the malformed payload. */
  ledger?: number;
  /** Human-readable explanation of why decoding failed. */
  reason: string;
}

export interface PolledLooptagEventPage extends LooptagEventPage {
  /** Oldest ledger still retained by the Soroban RPC node, when reported. */
  oldestLedger?: number;
  /**
   * `true` when the RPC page returned `limit` raw events, indicating another
   * page should be fetched immediately before waiting for the next poll tick.
   */
  hasMore: boolean;
  /** Count of malformed raw events skipped on this page. */
  skipped: number;
  /** Diagnostic details for each malformed event skipped on this page. */
  warnings: SkippedEventWarning[];
}

export interface LooptagRpcErrorOptions {
  httpStatus?: number;
  rpcCode?: number;
  rpcData?: unknown;
  cause?: unknown;
}

/** Error raised when the Soroban RPC transport or JSON-RPC envelope fails. */
export class LooptagRpcError extends Error {
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  readonly rpcData?: unknown;

  constructor(message: string, options: LooptagRpcErrorOptions = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LooptagRpcError";
    this.httpStatus = options.httpStatus;
    this.rpcCode = options.rpcCode;
    this.rpcData = options.rpcData;
  }
}

interface RawSorobanEvent {
  id?: unknown;
  pagingToken?: unknown;
  type?: unknown;
  ledger?: unknown;
  ledgerClosedAt?: unknown;
  contractId?: unknown;
  topic?: unknown;
  value?: unknown;
  txHash?: unknown;
  inSuccessfulContractCall?: unknown;
}

interface RawGetEventsResult {
  events?: unknown;
  cursor?: unknown;
  latestLedger?: unknown;
  oldestLedger?: unknown;
}

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: RawGetEventsResult;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}

/**
 * Fetch and decode one page of LOOPTAG contract events directly from a Soroban
 * JSON-RPC endpoint with per-event XDR fault isolation, `hasMore`, and
 * structured `skipped` warnings.
 */
export async function pollLooptagEvents(
  options: PollLooptagEventsOptions,
): Promise<PolledLooptagEventPage> {
  const normalized = validatePollOptions(options);

  // LOOPTAG's `#[contractevent]` definitions emit the event name itself as
  // `topics[0]` (`init`, `claim_issued`, `claim_redeemed`, ...), without a
  // shared `"looptag"` prefix topic. Filtering by contract id captures every
  // protocol event while `decodeLooptagEvent` ignores unknown event names.
  const params: Record<string, unknown> = {
    filters: [
      {
        type: "contract",
        contractIds: [normalized.contractId],
      },
    ],
    pagination: {
      ...(normalized.cursor !== undefined ? { cursor: normalized.cursor } : {}),
      limit: normalized.limit,
    },
    ...(normalized.startLedger !== undefined
      ? { startLedger: normalized.startLedger }
      : {}),
    ...(normalized.endLedger !== undefined
      ? { endLedger: normalized.endLedger }
      : {}),
  };

  let response: Response;
  try {
    response = await normalized.fetchFn(normalized.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getEvents",
        params,
      }),
    });
  } catch (error) {
    throw new LooptagRpcError(
      `failed to reach Soroban RPC at ${normalized.rpcUrl}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new LooptagRpcError(
      `Soroban RPC HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      { httpStatus: response.status },
    );
  }

  let payload: JsonRpcEnvelope;
  try {
    payload = (await response.json()) as JsonRpcEnvelope;
  } catch (error) {
    throw new LooptagRpcError(
      `Soroban RPC returned invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new LooptagRpcError(
      "Soroban RPC returned an empty JSON-RPC envelope",
    );
  }

  if (payload.error) {
    const rpcCode =
      typeof payload.error.code === "number" ? payload.error.code : undefined;
    const rpcMessage =
      typeof payload.error.message === "string" && payload.error.message.trim()
        ? payload.error.message
        : "unknown Soroban RPC error";
    throw new LooptagRpcError(
      `Soroban RPC getEvents error${rpcCode !== undefined ? ` (${rpcCode})` : ""}: ${rpcMessage}`,
      {
        rpcCode,
        rpcData: payload.error.data,
      },
    );
  }

  const result = payload.result;
  if (!result || typeof result !== "object") {
    throw new LooptagRpcError(
      "Soroban RPC response is missing a result object",
    );
  }

  const latestLedger = Number(result.latestLedger);
  if (!Number.isSafeInteger(latestLedger) || latestLedger < 0) {
    throw new LooptagRpcError(
      `Soroban RPC response has an invalid latestLedger: ${String(result.latestLedger)}`,
    );
  }

  const oldestLedger =
    result.oldestLedger !== undefined &&
    Number.isSafeInteger(Number(result.oldestLedger))
      ? Number(result.oldestLedger)
      : undefined;

  if (result.events !== undefined && !Array.isArray(result.events)) {
    throw new LooptagRpcError("Soroban RPC result.events must be an array");
  }
  const rawEvents = (result.events ?? []) as RawSorobanEvent[];

  const decodedPage = decodeRawEventBatch(rawEvents, normalized.contractId);

  const nextCursor =
    typeof result.cursor === "string" && result.cursor.trim().length > 0
      ? result.cursor.trim()
      : (decodedPage.lastRawCursor ?? normalized.cursor ?? "");

  return {
    events: decodedPage.events,
    cursor: nextCursor,
    latestLedger,
    ...(oldestLedger !== undefined ? { oldestLedger } : {}),
    hasMore: rawEvents.length >= normalized.limit,
    skipped: decodedPage.warnings.length,
    warnings: decodedPage.warnings,
  };
}

/**
 * Decode a batch of raw or `rpc.Server`-parsed Soroban events with per-event
 * fault isolation so a single malformed payload never discards the rest of the
 * page.
 */
export function decodeRawEventBatch(
  rawEvents: readonly RawSorobanEvent[],
  expectedContractId: string,
): {
  events: DecodedLooptagEvent[];
  warnings: SkippedEventWarning[];
  lastRawCursor?: string;
} {
  const events: DecodedLooptagEvent[] = [];
  const warnings: SkippedEventWarning[] = [];
  let lastRawCursor: string | undefined;

  for (let index = 0; index < rawEvents.length; index += 1) {
    const raw = rawEvents[index];
    const rawId = extractEventCursor(raw);
    if (rawId) {
      lastRawCursor = rawId;
    }
    const rawLedger =
      typeof raw?.ledger === "number" && Number.isSafeInteger(raw.ledger)
        ? raw.ledger
        : undefined;

    if (!raw || typeof raw !== "object") {
      warnings.push({
        index,
        reason: "event entry is not an object",
      });
      continue;
    }

    if (raw.inSuccessfulContractCall === false) {
      continue;
    }

    const eventContract =
      raw.contractId !== undefined && raw.contractId !== null
        ? String(raw.contractId)
        : undefined;
    if (
      eventContract &&
      expectedContractId &&
      eventContract !== expectedContractId
    ) {
      continue;
    }

    try {
      if (!rawId) {
        throw new TypeError("event is missing a string id or pagingToken");
      }
      if (rawLedger === undefined || rawLedger < 0) {
        throw new TypeError("event is missing a valid ledger number");
      }

      const topics = parseTopicScVals(raw.topic);
      const value = parseValueScVal(raw.value);
      const decoded = decodeLooptagEvent(topics, value);
      if (decoded === null) {
        continue;
      }

      events.push({
        event: decoded,
        id: rawId,
        ledger: rawLedger,
        ledgerClosedAt:
          typeof raw.ledgerClosedAt === "string" ? raw.ledgerClosedAt : "",
        txHash: typeof raw.txHash === "string" ? raw.txHash : "",
        contractId: eventContract ?? expectedContractId,
      });
    } catch (error) {
      warnings.push({
        index,
        ...(rawId ? { eventId: rawId } : {}),
        ...(rawLedger !== undefined ? { ledger: rawLedger } : {}),
        reason: errorMessage(error),
      });
    }
  }

  return { events, warnings, lastRawCursor };
}

/** Internal adapter used by the `(server, options)` overload of `fetchLooptagEvents`. */
export async function fetchEventsViaServer(
  server: rpc.Server,
  options: FetchLooptagEventsOptions,
): Promise<PolledLooptagEventPage> {
  const limit = options.limit ?? DEFAULT_EVENT_PAGE_LIMIT;
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

  let response: rpc.Api.GetEventsResponse;
  try {
    response = await server.getEvents(request);
  } catch (error) {
    throw new LooptagRpcError(
      `Soroban RPC getEvents failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const rawEvents = (response.events ?? []) as unknown as RawSorobanEvent[];
  const decodedPage = decodeRawEventBatch(rawEvents, options.contractId);

  return {
    events: decodedPage.events,
    cursor:
      response.cursor ?? decodedPage.lastRawCursor ?? options.cursor ?? "",
    latestLedger: response.latestLedger,
    ...(response.oldestLedger !== undefined
      ? { oldestLedger: response.oldestLedger }
      : {}),
    hasMore: rawEvents.length >= limit,
    skipped: decodedPage.warnings.length,
    warnings: decodedPage.warnings,
  };
}

interface NormalizedPollOptions {
  rpcUrl: string;
  contractId: string;
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit: number;
  fetchFn: typeof fetch;
}

function validatePollOptions(
  options: PollLooptagEventsOptions,
): NormalizedPollOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("fetchLooptagEvents options object is required");
  }

  const rpcUrl =
    typeof options.rpcUrl === "string" ? options.rpcUrl.trim() : "";
  if (!rpcUrl) {
    throw new TypeError("rpcUrl must be a non-empty HTTP(S) URL");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new TypeError(`invalid rpcUrl "${options.rpcUrl}"`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError(
      `rpcUrl protocol must be http: or https:, got "${parsedUrl.protocol}"`,
    );
  }

  const contractId = (options.contractId ?? TESTNET_CONTRACT_ID).trim();
  if (!isValidContractId(contractId)) {
    throw new TypeError(`invalid Stellar contract id "${contractId}"`);
  }

  const cursor =
    options.cursor !== undefined ? options.cursor.trim() : undefined;
  if (cursor !== undefined && cursor.length === 0) {
    throw new TypeError("cursor must not be an empty string");
  }

  if (
    cursor !== undefined &&
    (options.startLedger !== undefined || options.endLedger !== undefined)
  ) {
    throw new TypeError(
      "cursor cannot be combined with startLedger or endLedger",
    );
  }

  if (cursor === undefined && options.startLedger === undefined) {
    throw new TypeError("either startLedger or cursor must be provided");
  }

  if (options.startLedger !== undefined) {
    if (!Number.isSafeInteger(options.startLedger) || options.startLedger < 1) {
      throw new RangeError(
        `startLedger must be a positive safe integer, got ${String(options.startLedger)}`,
      );
    }
  }

  if (options.endLedger !== undefined) {
    if (!Number.isSafeInteger(options.endLedger) || options.endLedger < 1) {
      throw new RangeError(
        `endLedger must be a positive safe integer, got ${String(options.endLedger)}`,
      );
    }
    if (
      options.startLedger !== undefined &&
      options.endLedger < options.startLedger
    ) {
      throw new RangeError(
        `endLedger (${options.endLedger}) must be greater than or equal to startLedger (${options.startLedger})`,
      );
    }
  }

  const limit = options.limit ?? DEFAULT_EVENT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_EVENT_PAGE_LIMIT
  ) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_EVENT_PAGE_LIMIT}, got ${String(options.limit)}`,
    );
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new TypeError("fetch is not available in this runtime");
  }

  return {
    rpcUrl,
    contractId,
    startLedger: options.startLedger,
    endLedger: options.endLedger,
    cursor,
    limit,
    fetchFn,
  };
}

function extractEventCursor(
  raw: RawSorobanEvent | undefined,
): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  if (
    typeof raw.pagingToken === "string" &&
    raw.pagingToken.trim().length > 0
  ) {
    return raw.pagingToken.trim();
  }
  if (typeof raw.id === "string" && raw.id.trim().length > 0) {
    return raw.id.trim();
  }
  return undefined;
}

function parseTopicScVals(rawTopic: unknown): xdr.ScVal[] {
  if (!Array.isArray(rawTopic) || rawTopic.length === 0) {
    throw new TypeError("event topic must be a non-empty array");
  }
  return rawTopic.map((entry, idx) => {
    if (entry instanceof xdr.ScVal) {
      return entry;
    }
    if (typeof entry === "string" && entry.length > 0) {
      return xdr.ScVal.fromXDR(entry, "base64");
    }
    throw new TypeError(`event topic[${idx}] must be a base64 XDR string`);
  });
}

function parseValueScVal(rawValue: unknown): xdr.ScVal {
  if (rawValue instanceof xdr.ScVal) {
    return rawValue;
  }
  if (typeof rawValue === "string" && rawValue.length > 0) {
    return xdr.ScVal.fromXDR(rawValue, "base64");
  }
  if (
    rawValue &&
    typeof rawValue === "object" &&
    "xdr" in rawValue &&
    typeof (rawValue as { xdr: unknown }).xdr === "string" &&
    (rawValue as { xdr: string }).xdr.length > 0
  ) {
    return xdr.ScVal.fromXDR((rawValue as { xdr: string }).xdr, "base64");
  }
  throw new TypeError("event value must be a base64 XDR string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
