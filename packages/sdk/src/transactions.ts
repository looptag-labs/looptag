import { Buffer } from "buffer";
import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { isValidContractId, serialHashToBuffer } from "./qr.js";
import type { LooptagNetwork } from "./qr.js";

/** Canonical passphrases used by the networks LOOPTAG targets. */
export const NETWORK_PASSPHRASES: Record<LooptagNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  local: "Standalone Network ; February 2017",
};

const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n;
const DEFAULT_FEE = "100";
const DEFAULT_TIMEOUT_SECONDS = 30;

export interface BaseTxParams {
  /** Deployed LOOPTAG contract id (`C...`). */
  contractId: string;
  /** Transaction source account and default authorising address. */
  source: string;
  /** Current account sequence number as a decimal string. */
  sequence: string;
  /** Explicit network passphrase. Takes precedence over `network`. */
  networkPassphrase?: string;
  /** Named network used when `networkPassphrase` is absent. */
  network?: LooptagNetwork;
  /** Inclusion fee in stroops. Defaults to 100 (the Stellar base fee). */
  fee?: string;
  /** Transaction time bound in seconds. Defaults to 30. */
  timeoutSeconds?: number;
}

export interface IssueClaimTxParams extends BaseTxParams {
  /** Address that receives the transferable claim. Defaults to `source`. */
  owner?: string;
  /** Merchant address that locks the deposit. Defaults to `source`. */
  issuer?: string;
  /** 32-byte SHA-256 of the physical serial, as hex or bytes. */
  serialHash: string | Uint8Array | Buffer;
  /** Deposit in the token's smallest unit, e.g. stroops for XLM. */
  deposit: bigint | string;
  /** Unix expiry timestamp, 0 for none. */
  expiresAt?: number | bigint | string;
}

export interface TransferClaimTxParams extends BaseTxParams {
  claimId: number | bigint | string;
  /** Current owner. Defaults to `source`. */
  from?: string;
  to: string;
}

export interface AuthorizeReturnTxParams extends BaseTxParams {
  claimId: number | bigint | string;
  /** Authorised station. Defaults to `source`. */
  station?: string;
  serialHash: string | Uint8Array | Buffer;
}

export interface RedeemTxParams extends BaseTxParams {
  claimId: number | bigint | string;
}

/**
 * Build an unsigned `issue_claim` transaction. The caller signs and submits it
 * with the normal Stellar SDK, or hands it to a wallet such as Freighter.
 */
export function buildIssueClaimTx(params: IssueClaimTxParams): Transaction {
  const issuer = params.issuer ?? params.source;
  const owner = params.owner ?? params.source;

  return buildTransaction(params, [
    "issue_claim",
    addressToScVal(issuer),
    addressToScVal(owner),
    bytes32ToScVal(params.serialHash),
    amountToScVal(params.deposit),
    u64ToScVal(params.expiresAt ?? 0),
  ]);
}

/** Build an unsigned `transfer_claim` transaction. */
export function buildTransferClaimTx(
  params: TransferClaimTxParams,
): Transaction {
  return buildTransaction(params, [
    "transfer_claim",
    u64ToScVal(params.claimId),
    addressToScVal(params.from ?? params.source),
    addressToScVal(params.to),
  ]);
}

/** Build an unsigned `authorize_return` transaction for a return station. */
export function buildAuthorizeReturnTx(
  params: AuthorizeReturnTxParams,
): Transaction {
  return buildTransaction(params, [
    "authorize_return",
    u64ToScVal(params.claimId),
    addressToScVal(params.station ?? params.source),
    bytes32ToScVal(params.serialHash),
  ]);
}

/** Build an unsigned, permissionless `redeem` transaction. */
export function buildRedeemTx(params: RedeemTxParams): Transaction {
  return buildTransaction(params, ["redeem", u64ToScVal(params.claimId)]);
}

/** Resolve a network name to its canonical passphrase. */
export function networkPassphrase(network: LooptagNetwork): string {
  return NETWORK_PASSPHRASES[network];
}

export function addressToScVal(value: string): xdr.ScVal {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("address must be a non-empty Stellar address");
  }
  return Address.fromString(value).toScVal();
}

export function bytes32ToScVal(value: string | Uint8Array | Buffer): xdr.ScVal {
  const bytes =
    typeof value === "string"
      ? serialHashToBuffer(value)
      : (() => {
          const buffer = Buffer.from(value);
          if (buffer.length !== 32) {
            throw new TypeError(
              `serial hash must be 32 bytes, got ${buffer.length}`,
            );
          }
          return buffer;
        })();
  return xdr.ScVal.scvBytes(bytes);
}

export function u64ToScVal(value: number | bigint | string): xdr.ScVal {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > U64_MAX) {
    throw new RangeError("value must fit in an unsigned 64-bit integer");
  }
  return nativeToScVal(parsed, { type: "u64" });
}

export function amountToScVal(value: bigint | string): xdr.ScVal {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed <= 0n || parsed > I128_MAX) {
    throw new RangeError("deposit must be a positive i128 amount");
  }
  return nativeToScVal(parsed, { type: "i128" });
}

function buildTransaction(
  params: BaseTxParams,
  [method, ...args]: [string, ...xdr.ScVal[]],
): Transaction {
  if (!isValidContractId(params.contractId)) {
    throw new TypeError(`invalid Stellar contract id "${params.contractId}"`);
  }
  if (!/^\d+$/.test(params.sequence)) {
    throw new TypeError("sequence must be a decimal account sequence number");
  }
  if (
    params.timeoutSeconds !== undefined &&
    (!Number.isInteger(params.timeoutSeconds) || params.timeoutSeconds <= 0)
  ) {
    throw new RangeError("timeoutSeconds must be a positive integer");
  }

  const passphrase =
    params.networkPassphrase ?? networkPassphrase(params.network ?? "testnet");
  const fee = params.fee ?? DEFAULT_FEE;
  if (!/^\d+$/.test(fee)) {
    throw new TypeError("fee must be a decimal stroop amount");
  }

  const contract = new Contract(params.contractId);
  return new TransactionBuilder(new Account(params.source, params.sequence), {
    fee,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}
