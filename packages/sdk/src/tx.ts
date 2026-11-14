import { Buffer } from "buffer";
import { StrKey } from "@stellar/stellar-sdk";
import type {
  AssembledTransaction,
  MethodOptions,
  Result,
} from "@stellar/stellar-sdk/contract";
import type { Client } from "./generated/index.js";
import { hashSerial, serialHashToBuffer } from "./qr.js";

const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MAX = 170_141_183_460_469_231_687_303_715_884_105_727n;
const MAX_SERIAL_LENGTH = 256;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const CONTRACT_ERROR_CODE_RE = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/i;

export interface ContractErrorDescriptor {
  readonly code: number;
  readonly name: string;
  readonly message: string;
}

/**
 * Complete catalog of LOOPTAG Soroban contract error codes (`#[contracterror]`),
 * mapping numeric codes (`1..22`) to symbolic names and human-readable explanations.
 */
export const LOOPTAG_CONTRACT_ERRORS = {
  1: {
    code: 1,
    name: "AlreadyInitialized",
    message: "Contract has already been initialized",
  },
  2: {
    code: 2,
    name: "NotInitialized",
    message: "Contract has not been initialized yet",
  },
  3: {
    code: 3,
    name: "MerchantExists",
    message: "Merchant is already registered",
  },
  4: {
    code: 4,
    name: "MerchantNotFound",
    message: "Issuer is not a registered merchant",
  },
  5: {
    code: 5,
    name: "MerchantInactive",
    message: "Merchant account is currently suspended",
  },
  6: {
    code: 6,
    name: "StationNotAuthorized",
    message: "Return station is not authorized for this claim's issuer",
  },
  7: {
    code: 7,
    name: "ClaimNotFound",
    message: "Claim does not exist",
  },
  8: {
    code: 8,
    name: "ClaimNotActive",
    message: "Claim is not in the Active state",
  },
  9: {
    code: 9,
    name: "ClaimNotReturnAuthorized",
    message: "Claim return has not been authorized by a station",
  },
  10: {
    code: 10,
    name: "NotClaimOwner",
    message: "Caller is not the current owner of the claim",
  },
  11: {
    code: 11,
    name: "SerialMismatch",
    message: "Scanned item serial does not match the claim's serial hash",
  },
  12: {
    code: 12,
    name: "InvalidDeposit",
    message: "Deposit amount must be greater than zero",
  },
  13: {
    code: 13,
    name: "InvalidExpiry",
    message: "Claim expiry timestamp must be zero or in the future",
  },
  14: {
    code: 14,
    name: "SameOwner",
    message: "Recipient address must differ from the current claim owner",
  },
  15: {
    code: 15,
    name: "Overflow",
    message: "Arithmetic overflow in contract accounting",
  },
  16: {
    code: 16,
    name: "NotAdmin",
    message: "Caller is not the contract administrator",
  },
  17: {
    code: 17,
    name: "SerialAlreadyActive",
    message:
      "An active or return-authorized claim already exists for this issuer and serial",
  },
  18: {
    code: 18,
    name: "ContractPaused",
    message: "Contract operations are currently paused",
  },
  19: {
    code: 19,
    name: "UnexpectedTransferAmount",
    message: "Deposit token transferred an unexpected amount",
  },
  20: {
    code: 20,
    name: "BatchTooLarge",
    message: "Requested claim batch exceeds the maximum batch size",
  },
  21: {
    code: 21,
    name: "NoPendingAdmin",
    message: "No pending administrator handover exists",
  },
  22: {
    code: 22,
    name: "SameAdmin",
    message: "Proposed administrator is already the current administrator",
  },
} as const satisfies Record<number, ContractErrorDescriptor>;

export type LooptagContractErrorCode = keyof typeof LOOPTAG_CONTRACT_ERRORS;
export type LooptagContractErrorName =
  (typeof LOOPTAG_CONTRACT_ERRORS)[LooptagContractErrorCode]["name"];

const ERRORS_BY_NAME: ReadonlyMap<string, ContractErrorDescriptor> = new Map(
  Object.values(LOOPTAG_CONTRACT_ERRORS).map((entry) => [entry.name, entry]),
);

export interface LooptagErrorOptions {
  errorName?: LooptagContractErrorName | "UnknownContractError";
  detail?: string;
  cause?: unknown;
}

/**
 * Typed error thrown when simulating a LOOPTAG contract invocation returns an
 * on-chain `#[contracterror]` code.
 */
export class LooptagError extends Error {
  readonly code: number;
  readonly errorName: LooptagContractErrorName | "UnknownContractError";

  constructor(code: number, options: LooptagErrorOptions = {}) {
    const known = getContractErrorDescriptor(code);
    const errorName =
      options.errorName ??
      (known?.name as LooptagContractErrorName | undefined) ??
      "UnknownContractError";
    const description =
      options.detail ?? known?.message ?? "Unrecognized LOOPTAG contract error";
    super(
      `LOOPTAG contract error #${code} (${errorName}): ${description}`,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LooptagError";
    this.code = code;
    this.errorName = errorName;
  }
}

/** Look up the descriptor for a numeric contract error code, if known. */
export function getContractErrorDescriptor(
  code: number,
): ContractErrorDescriptor | undefined {
  return (
    LOOPTAG_CONTRACT_ERRORS as Record<
      number,
      ContractErrorDescriptor | undefined
    >
  )[code];
}

/**
 * Decode a contract error from a generated `Result`, an `Error`, or a Soroban
 * simulation error message (`HostError: Error(Contract, #<code >)`). Returns
 * `null` when the value does not represent a contract error.
 */
export function decodeLooptagError(
  source: unknown,
  simulationError?: string,
): LooptagError | null {
  if (source instanceof LooptagError) {
    return source;
  }

  if (isErrResult(source)) {
    const errPayload = source.unwrapErr();
    const rawMessage =
      typeof errPayload?.message === "string" ? errPayload.message.trim() : "";
    const byName = ERRORS_BY_NAME.get(rawMessage);
    if (byName) {
      return new LooptagError(byName.code, {
        errorName: byName.name as LooptagContractErrorName,
        detail: byName.message,
        cause: errPayload,
      });
    }
    const codeFromSim = simulationError
      ? parseContractErrorCode(simulationError)
      : undefined;
    if (codeFromSim !== undefined) {
      return new LooptagError(codeFromSim, { cause: errPayload });
    }
    const codeFromPayload = parseContractErrorCode(rawMessage);
    if (codeFromPayload !== undefined) {
      return new LooptagError(codeFromPayload, { cause: errPayload });
    }
  }

  const text =
    typeof source === "string"
      ? source
      : source instanceof Error
        ? source.message
        : (simulationError ?? "");
  if (text) {
    const code = parseContractErrorCode(text);
    if (code !== undefined) {
      return new LooptagError(code, { cause: source });
    }
    const byName = ERRORS_BY_NAME.get(text.trim());
    if (byName) {
      return new LooptagError(byName.code, {
        errorName: byName.name as LooptagContractErrorName,
        detail: byName.message,
        cause: source,
      });
    }
  }

  return null;
}

/** Minimal generated client surface required by the lifecycle transaction helpers. */
export type LooptagTxClient = Pick<
  Client,
  "issue_claim" | "transfer_claim" | "authorize_return" | "redeem"
>;

export interface IssueClaimParams {
  /** Registered merchant address (`G...` or `C...`) locking the deposit. */
  issuer: string;
  /** Initial claim owner address (`G...` or `C...`). */
  owner: string;
  /** Raw physical item serial or tag identifier (hashed via `hashSerial` before RPC). */
  serial: string;
  /** Positive deposit in the token's smallest unit (e.g. `toStroops("2")` -> `20_000_000n`). */
  deposit: bigint | number | string;
  /** Optional Unix timestamp in seconds after which the item is overdue (`0` for none). */
  expiresAt?: bigint | number | string;
}

export interface TransferClaimParams {
  /** Positive on-chain claim id (`1 .. 2^64 - 1`). */
  claimId: bigint | number | string;
  /** Current owner address (`G...` or `C...`). */
  from: string;
  /** New owner address (`G...` or `C...`), distinct from `from`. */
  to: string;
}

export interface AuthorizeReturnParams {
  /** Positive on-chain claim id (`1 .. 2^64 - 1`). */
  claimId: bigint | number | string;
  /** Authorized return station address (`G...` or `C...`). */
  station: string;
  /** Raw physical item serial scanned at return (hashed via `hashSerial` before RPC). */
  serial: string;
}

export interface RedeemParams {
  /** Positive on-chain claim id (`1 .. 2^64 - 1`). */
  claimId: bigint | number | string;
}

/**
 * Validate inputs, hash `serial` with SHA-256 into a 32-byte `Buffer`, and
 * simulate `issue_claim` via the generated LOOPTAG client. Returns the
 * simulated `AssembledTransaction` unchanged so the caller can sign and send.
 */
export async function issueClaim(
  client: LooptagTxClient,
  params: IssueClaimParams,
  options?: MethodOptions,
): Promise<AssembledTransaction<Result<bigint>>> {
  assertClientMethod(client, "issue_claim");
  const issuer = normalizeStellarAddress(params.issuer, "issuer");
  const owner = normalizeStellarAddress(params.owner, "owner");
  const serialHash = await normalizeAndHashSerial(params.serial);
  const deposit = normalizePositiveDeposit(params.deposit);
  const expiresAt = normalizeExpiresAt(params.expiresAt);

  return runSimulatedCall(
    () =>
      client.issue_claim(
        {
          issuer,
          owner,
          serial_hash: serialHash,
          deposit,
          expires_at: expiresAt,
        },
        options,
      ),
    options,
  );
}

/**
 * Validate inputs and simulate `transfer_claim` via the generated LOOPTAG
 * client. Returns the simulated `AssembledTransaction` unchanged.
 */
export async function transferClaim(
  client: LooptagTxClient,
  params: TransferClaimParams,
  options?: MethodOptions,
): Promise<AssembledTransaction<Result<void>>> {
  assertClientMethod(client, "transfer_claim");
  const claimId = normalizeClaimId(params.claimId);
  const from = normalizeStellarAddress(params.from, "from");
  const to = normalizeStellarAddress(params.to, "to");
  if (from === to) {
    throw new RangeError("from and to addresses must differ");
  }

  return runSimulatedCall(
    () => client.transfer_claim({ claim_id: claimId, from, to }, options),
    options,
  );
}

/**
 * Validate inputs, hash `serial` with SHA-256 into a 32-byte `Buffer`, and
 * simulate `authorize_return` via the generated LOOPTAG client. Returns the
 * simulated `AssembledTransaction` unchanged.
 */
export async function authorizeReturn(
  client: LooptagTxClient,
  params: AuthorizeReturnParams,
  options?: MethodOptions,
): Promise<AssembledTransaction<Result<void>>> {
  assertClientMethod(client, "authorize_return");
  const claimId = normalizeClaimId(params.claimId);
  const station = normalizeStellarAddress(params.station, "station");
  const serialHash = await normalizeAndHashSerial(params.serial);

  return runSimulatedCall(
    () =>
      client.authorize_return(
        {
          claim_id: claimId,
          station,
          serial_hash: serialHash,
        },
        options,
      ),
    options,
  );
}

/**
 * Validate `claimId` and simulate permissionless `redeem` via the generated
 * LOOPTAG client. Returns the simulated `AssembledTransaction` unchanged.
 */
export async function redeem(
  client: LooptagTxClient,
  params: RedeemParams,
  options?: MethodOptions,
): Promise<AssembledTransaction<Result<void>>> {
  assertClientMethod(client, "redeem");
  const claimId = normalizeClaimId(params.claimId);

  return runSimulatedCall(
    () => client.redeem({ claim_id: claimId }, options),
    options,
  );
}

async function runSimulatedCall<T>(
  invoke: () => Promise<AssembledTransaction<Result<T>>>,
  options?: MethodOptions,
): Promise<AssembledTransaction<Result<T>>> {
  let tx: AssembledTransaction<Result<T>>;
  try {
    tx = await invoke();
  } catch (error) {
    const decoded = decodeLooptagError(error);
    if (decoded) {
      throw decoded;
    }
    throw error;
  }

  if (options?.simulate === false) {
    return tx;
  }

  const simulationError = extractSimulationErrorString(tx);
  let result: Result<T> | undefined;
  try {
    result = tx.result;
  } catch (error) {
    const decoded = decodeLooptagError(error, simulationError);
    if (decoded) {
      throw decoded;
    }
    throw error;
  }

  if (result !== undefined) {
    const decoded = decodeLooptagError(result, simulationError);
    if (decoded) {
      throw decoded;
    }
  }

  if (simulationError) {
    const decoded = decodeLooptagError(simulationError);
    if (decoded) {
      throw decoded;
    }
  }

  return tx;
}

function assertClientMethod(
  client: LooptagTxClient,
  method: keyof LooptagTxClient,
): void {
  if (!client || typeof client[method] !== "function") {
    throw new TypeError(`client.${method} must be a function`);
  }
}

function normalizeStellarAddress(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a Stellar address string`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    (!StrKey.isValidEd25519PublicKey(trimmed) &&
      !StrKey.isValidContract(trimmed))
  ) {
    throw new TypeError(`invalid Stellar address for ${fieldName}: "${value}"`);
  }
  return trimmed;
}

async function normalizeAndHashSerial(serial: string): Promise<Buffer> {
  if (typeof serial !== "string") {
    throw new TypeError("serial must be a string");
  }
  const trimmed = serial.trim();
  if (trimmed.length === 0) {
    throw new TypeError("serial must be a non-empty string");
  }
  if (trimmed.length > MAX_SERIAL_LENGTH) {
    throw new RangeError(
      `serial must be at most ${MAX_SERIAL_LENGTH} characters`,
    );
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new TypeError("serial must not contain control characters");
  }
  const hexHash = await hashSerial(trimmed);
  return serialHashToBuffer(hexHash);
}

function normalizePositiveDeposit(value: bigint | number | string): bigint {
  let amount: bigint;
  if (typeof value === "bigint") {
    amount = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        "deposit number must be a safe integer in base units; pass bigint or string",
      );
    }
    amount = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(
        `deposit must be an integer base-unit amount, got "${value}"`,
      );
    }
    amount = BigInt(trimmed);
  } else {
    throw new TypeError("deposit must be a bigint, integer number, or string");
  }

  if (amount <= 0n || amount > I128_MAX) {
    throw new RangeError("deposit must be a positive i128 base-unit amount");
  }
  return amount;
}

function normalizeClaimId(value: bigint | number | string): bigint {
  let id: bigint;
  if (typeof value === "bigint") {
    id = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("claimId must be a safe integer");
    }
    id = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(`claimId must be a positive integer, got "${value}"`);
    }
    id = BigInt(trimmed);
  } else {
    throw new TypeError("claimId must be a bigint, number, or decimal string");
  }

  if (id <= 0n || id > U64_MAX) {
    throw new RangeError(
      `unknown or out-of-range claimId ${String(value)}: valid claim ids are 1..2^64-1`,
    );
  }
  return id;
}

function normalizeExpiresAt(
  value: bigint | number | string | undefined,
): bigint {
  if (value === undefined) {
    return 0n;
  }
  let timestamp: bigint;
  if (typeof value === "bigint") {
    timestamp = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("expiresAt must be a safe integer Unix timestamp");
    }
    timestamp = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(
        `expiresAt must be an unsigned integer timestamp, got "${value}"`,
      );
    }
    timestamp = BigInt(trimmed);
  } else {
    throw new TypeError("expiresAt must be a bigint, number, or string");
  }

  if (timestamp < 0n || timestamp > U64_MAX) {
    throw new RangeError("expiresAt must fit in an unsigned 64-bit integer");
  }
  return timestamp;
}

function isErrResult(
  value: unknown,
): value is { isErr: () => boolean; unwrapErr: () => { message?: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    typeof (value as { isErr: unknown }).isErr === "function" &&
    "unwrapErr" in value &&
    typeof (value as { unwrapErr: unknown }).unwrapErr === "function" &&
    (value as { isErr: () => boolean }).isErr() === true
  );
}

function parseContractErrorCode(message: string): number | undefined {
  const match = CONTRACT_ERROR_CODE_RE.exec(message);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function extractSimulationErrorString(tx: unknown): string | undefined {
  if (!tx || typeof tx !== "object" || !("simulation" in tx)) {
    return undefined;
  }
  const simulation = (tx as { simulation?: unknown }).simulation;
  if (
    simulation &&
    typeof simulation === "object" &&
    "error" in simulation &&
    typeof (simulation as { error?: unknown }).error === "string"
  ) {
    return (simulation as { error: string }).error;
  }
  return undefined;
}
