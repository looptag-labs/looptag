import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}

export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT",
  },
} as const;

export interface Claim {
  /**
   * Deposit amount in the smallest unit of the deposit token (stroops for
   * XLM, 7 decimal places for Stellar assets).
   */
  deposit: i128;
  /**
   * Unix timestamp after which the item is considered overdue. `0` means no
   * expiry. Expiry is informational in v0; see ROADMAP.md for forfeiture.
   */
  expires_at: u64;
  id: u64;
  issued_at: u64;
  issuer: string;
  owner: string;
  return_station: Option<string>;
  returned_at: u64;
  /**
   * SHA-256 of the physical item's serial number or tag identifier.
   */
  serial_hash: Buffer;
  status: ClaimStatus;
}

export const Errors = {
  1: { message: "AlreadyInitialized" },
  2: { message: "NotInitialized" },
  3: { message: "MerchantExists" },
  4: { message: "MerchantNotFound" },
  5: { message: "MerchantInactive" },
  6: { message: "StationNotAuthorized" },
  7: { message: "ClaimNotFound" },
  8: { message: "ClaimNotActive" },
  9: { message: "ClaimNotReturnAuthorized" },
  10: { message: "NotClaimOwner" },
  11: { message: "SerialMismatch" },
  12: { message: "InvalidDeposit" },
  13: { message: "InvalidExpiry" },
  14: { message: "SameOwner" },
  15: { message: "Overflow" },
  16: { message: "NotAdmin" },
  17: { message: "SerialAlreadyActive" },
  18: { message: "ContractPaused" },
  19: { message: "UnexpectedTransferAmount" },
  20: { message: "BatchTooLarge" },
  21: { message: "NoPendingAdmin" },
  22: { message: "SameAdmin" },
};

export type DataKey =
  | { tag: "Admin"; values: void }
  | { tag: "PendingAdmin"; values: void }
  | { tag: "Paused"; values: void }
  | { tag: "DepositToken"; values: void }
  | { tag: "ClaimCount"; values: void }
  | { tag: "Claim"; values: readonly [u64] }
  | { tag: "Serial"; values: readonly [string, Buffer] }
  | { tag: "Merchant"; values: readonly [string] }
  | { tag: "Station"; values: readonly [string, string] };

export interface Merchant {
  active: boolean;
  address: string;
  issued: u64;
  name: string;
  /**
   * Sum of deposits still locked for this issuer. This is the on-chain
   * deposit liability and should always equal the sum of active claims.
   */
  outstanding: i128;
  redeemed: u64;
}

export enum ClaimStatus {
  Active = 0,
  ReturnAuthorized = 1,
  Redeemed = 2,
}

export interface Client {
  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pay the deposit to the current owner. Permissionless: once a return has
   * been attested, anyone may trigger the refund, but the funds can only go
   * to the wallet that owns the claim at that moment.
   */
  redeem: (
    { claim_id }: { claim_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<string>>>;

  /**
   * Construct and simulate a get_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_claim: (
    { claim_id }: { claim_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<Claim>>>;

  /**
   * Construct and simulate a get_claims transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a bounded list of claims in one call. The limit protects the
   * contract from unbounded return values and makes dashboard pagination
   * predictable.
   */
  get_claims: (
    { claim_ids }: { claim_ids: Array<u64> },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<Array<Claim>>>>;

  /**
   * Construct and simulate a get_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_paused: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time setup. `admin` manages the merchant allowlist; `deposit_token`
   * is the SEP-41 asset used for every deposit in this deployment.
   */
  initialize: (
    { admin, deposit_token }: { admin: string; deposit_token: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a is_station transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_station: (
    { issuer, station }: { issuer: string; station: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pause or unpause the parts of the protocol that create or redirect
   * exposure. Redemption deliberately stays available while paused so an
   * emergency stop can never strand a returned item's deposit.
   */
  set_paused: (
    { admin, paused }: { admin: string; paused: boolean },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a issue_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lock a deposit and mint a transferable claim to `owner`.
   */
  issue_claim: (
    {
      issuer,
      owner,
      serial_hash,
      deposit,
      expires_at,
    }: {
      issuer: string;
      owner: string;
      serial_hash: Buffer;
      deposit: i128;
      expires_at: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<u64>>>;

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Complete a pending admin handover. Only the nominated address can accept.
   */
  accept_admin: (
    { new_admin }: { new_admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_merchant transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_merchant: (
    { merchant }: { merchant: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<Merchant>>>;

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Start a two-step admin handover. The nominated address must call
   * `accept_admin`, which prevents a typo from permanently losing control.
   */
  propose_admin: (
    { admin, new_admin }: { admin: string; new_admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a remove_station transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a return station. Already-attested returns remain valid.
   */
  remove_station: (
    { issuer, station }: { issuer: string; station: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a transfer_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer the deposit entitlement to another wallet. Only the current
   * owner can transfer, and only while the claim is active.
   */
  transfer_claim: (
    { claim_id, from, to }: { claim_id: u64; from: string; to: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_claim_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_claim_count: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;

  /**
   * Construct and simulate a authorize_return transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attest that the physical item was returned. The station must be
   * authorised by the issuer, and the serial hash must match the claim so a
   * QR code from a different item cannot close this claim.
   */
  authorize_return: (
    {
      claim_id,
      station,
      serial_hash,
    }: { claim_id: u64; station: string; serial_hash: Buffer },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_serial_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the live claim id for an `(issuer, serial_hash)` pair, if any.
   * This is the same index used to reject duplicate active tags.
   */
  get_serial_claim: (
    { issuer, serial_hash }: { issuer: string; serial_hash: Buffer },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<u64>>>;

  /**
   * Construct and simulate a register_station transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Authorise a return station for a specific issuer. Stations are scoped to
   * the issuer because the issuer is the party accepting the returned item.
   */
  register_station: (
    { issuer, station }: { issuer: string; station: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_deposit_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_deposit_token: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<string>>>;

  /**
   * Construct and simulate a get_pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_pending_admin: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<string>>>;

  /**
   * Construct and simulate a register_merchant transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a merchant that is allowed to issue deposit claims.
   */
  register_merchant: (
    { merchant, name }: { merchant: string; name: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a set_merchant_active transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Suspend or re-enable a merchant. Existing claims stay redeemable:
   * suspending an issuer must never strand a customer's deposit.
   */
  set_merchant_active: (
    { merchant, active }: { merchant: string; active: boolean },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a pending handover. Useful when the nominated key is lost before
   * it accepts or when the operator changes their mind.
   */
  cancel_admin_transfer: (
    { admin }: { admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;

  /**
   * Construct and simulate a get_outstanding_liability transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_outstanding_liability: (
    { issuer }: { issuer: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<i128>>>;
}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      },
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options);
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAABQAAAAAAAAAAAAAABEluaXQAAAABAAAABGluaXQAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAAAAAAAA1kZXBvc2l0X3Rva2VuAAAAAAAAEwAAAAAAAAAB",
        "AAAAAQAAAAAAAAAAAAAABUNsYWltAAAAAAAACgAAAHBEZXBvc2l0IGFtb3VudCBpbiB0aGUgc21hbGxlc3QgdW5pdCBvZiB0aGUgZGVwb3NpdCB0b2tlbiAoc3Ryb29wcyBmb3IKWExNLCA3IGRlY2ltYWwgcGxhY2VzIGZvciBTdGVsbGFyIGFzc2V0cykuAAAAB2RlcG9zaXQAAAAACwAAAI1Vbml4IHRpbWVzdGFtcCBhZnRlciB3aGljaCB0aGUgaXRlbSBpcyBjb25zaWRlcmVkIG92ZXJkdWUuIGAwYCBtZWFucyBubwpleHBpcnkuIEV4cGlyeSBpcyBpbmZvcm1hdGlvbmFsIGluIHYwOyBzZWUgUk9BRE1BUC5tZCBmb3IgZm9yZmVpdHVyZS4AAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAACaWQAAAAAAAYAAAAAAAAACWlzc3VlZF9hdAAAAAAAAAYAAAAAAAAABmlzc3VlcgAAAAAAEwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAA5yZXR1cm5fc3RhdGlvbgAAAAAD6AAAABMAAAAAAAAAC3JldHVybmVkX2F0AAAAAAYAAAA/U0hBLTI1NiBvZiB0aGUgcGh5c2ljYWwgaXRlbSdzIHNlcmlhbCBudW1iZXIgb3IgdGFnIGlkZW50aWZpZXIuAAAAAAtzZXJpYWxfaGFzaAAAAAPuAAAAIAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAC0NsYWltU3RhdHVzAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFgAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAOTWVyY2hhbnRFeGlzdHMAAAAAAAMAAAAAAAAAEE1lcmNoYW50Tm90Rm91bmQAAAAEAAAAAAAAABBNZXJjaGFudEluYWN0aXZlAAAABQAAAAAAAAAUU3RhdGlvbk5vdEF1dGhvcml6ZWQAAAAGAAAAAAAAAA1DbGFpbU5vdEZvdW5kAAAAAAAABwAAAAAAAAAOQ2xhaW1Ob3RBY3RpdmUAAAAAAAgAAAAAAAAAGENsYWltTm90UmV0dXJuQXV0aG9yaXplZAAAAAkAAAAAAAAADU5vdENsYWltT3duZXIAAAAAAAAKAAAAAAAAAA5TZXJpYWxNaXNtYXRjaAAAAAAACwAAAAAAAAAOSW52YWxpZERlcG9zaXQAAAAAAAwAAAAAAAAADUludmFsaWRFeHBpcnkAAAAAAAANAAAAAAAAAAlTYW1lT3duZXIAAAAAAAAOAAAAAAAAAAhPdmVyZmxvdwAAAA8AAAAAAAAACE5vdEFkbWluAAAAEAAAAAAAAAATU2VyaWFsQWxyZWFkeUFjdGl2ZQAAAAARAAAAAAAAAA5Db250cmFjdFBhdXNlZAAAAAAAEgAAAAAAAAAYVW5leHBlY3RlZFRyYW5zZmVyQW1vdW50AAAAEwAAAAAAAAANQmF0Y2hUb29MYXJnZQAAAAAAABQAAAAAAAAADk5vUGVuZGluZ0FkbWluAAAAAAAVAAAAAAAAAAlTYW1lQWRtaW4AAAAAAAAW",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAGUGF1c2VkAAAAAAAAAAAAAAAAAAxEZXBvc2l0VG9rZW4AAAAAAAAAAAAAAApDbGFpbUNvdW50AAAAAAABAAAAAAAAAAVDbGFpbQAAAAAAAAEAAAAGAAAAAQAAANRgKGlzc3Vlciwgc2VyaWFsX2hhc2gpIC0+IGNsYWltX2lkYCB3aGlsZSBhIGNsYWltIGZvciB0aGUgcGh5c2ljYWwgaXRlbQppcyBzdGlsbCBhY3RpdmUgb3IgYXdhaXRpbmcgcmVkZW1wdGlvbi4gUmVtb3ZlZCBvbiByZWRlbXB0aW9uIHNvIHRoZQpzYW1lIHRhZyBjYW4gYmUgcmV1c2VkIGFmdGVyIHRoZSBkZXBvc2l0IGhhcyBnb25lIGJhY2sgdG8gdGhlIGN1c3RvbWVyLgAAAAZTZXJpYWwAAAAAAAIAAAATAAAD7gAAACAAAAABAAAAAAAAAAhNZXJjaGFudAAAAAEAAAATAAAAAQAAAAAAAAAHU3RhdGlvbgAAAAACAAAAEwAAABM=",
        "AAAAAQAAAAAAAAAAAAAACE1lcmNoYW50AAAABgAAAAAAAAAGYWN0aXZlAAAAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAAAAAAABmlzc3VlZAAAAAAABgAAAAAAAAAEbmFtZQAAABAAAACGU3VtIG9mIGRlcG9zaXRzIHN0aWxsIGxvY2tlZCBmb3IgdGhpcyBpc3N1ZXIuIFRoaXMgaXMgdGhlIG9uLWNoYWluCmRlcG9zaXQgbGlhYmlsaXR5IGFuZCBzaG91bGQgYWx3YXlzIGVxdWFsIHRoZSBzdW0gb2YgYWN0aXZlIGNsYWltcy4AAAAAAAtvdXRzdGFuZGluZwAAAAALAAAAAAAAAAhyZWRlZW1lZAAAAAY=",
        "AAAAAwAAAAAAAAAAAAAAC0NsYWltU3RhdHVzAAAAAAMAAAA5RGVwb3NpdCBpcyBsb2NrZWQgYW5kIHRoZSBjbGFpbSBjYW4gc3RpbGwgYmUgdHJhbnNmZXJyZWQuAAAAAAAABkFjdGl2ZQAAAAAAAAAAAIJBIHJldHVybiBzdGF0aW9uIGhhcyBhdHRlc3RlZCB0aGUgcGh5c2ljYWwgcmV0dXJuLiBUcmFuc2ZlcnMgYXJlIGZyb3plbgpzbyB0aGUgcmVmdW5kIGNhbm5vdCBiZSByZWRpcmVjdGVkIGFmdGVyIHRoZSBpdGVtIGlzIGJhY2suAAAAAAAQUmV0dXJuQXV0aG9yaXplZAAAAAEAAAB7VGhlIGRlcG9zaXQgaGFzIGJlZW4gcGFpZCB0byB0aGUgb3duZXIuIFRoZSBjbGFpbSBpcyBhIHBlcm1hbmVudCBhdWRpdApyZWNvcmQgYW5kIGNhbiBubyBsb25nZXIgYmUgdHJhbnNmZXJyZWQgb3IgcmVkZWVtZWQuAAAAAAhSZWRlZW1lZAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAC0NsYWltSXNzdWVkAAAAAAEAAAAMY2xhaW1faXNzdWVkAAAABgAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAAAAAAAAGaXNzdWVyAAAAAAATAAAAAAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAAAAAAHZGVwb3NpdAAAAAALAAAAAAAAAAAAAAALc2VyaWFsX2hhc2gAAAAD7gAAACAAAAAAAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAADEFkbWluQ2hhbmdlZAAAAAEAAAANYWRtaW5fY2hhbmdlZAAAAAAAAAIAAAAAAAAACW9sZF9hZG1pbgAAAAAAABMAAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAADFBhdXNlQ2hhbmdlZAAAAAEAAAANcGF1c2VfY2hhbmdlZAAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAAAAAAB",
        "AAAABQAAAAAAAAAAAAAADUNsYWltUmVkZWVtZWQAAAAAAAABAAAADmNsYWltX3JlZGVlbWVkAAAAAAADAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAABAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAAAAAAAAdkZXBvc2l0AAAAAAsAAAAAAAAAAQ==",
        "AAAABQAAAAAAAAAAAAAADlN0YXRpb25DaGFuZ2VkAAAAAAABAAAAD3N0YXRpb25fY2hhbmdlZAAAAAADAAAAAAAAAAZpc3N1ZXIAAAAAABMAAAABAAAAAAAAAAdzdGF0aW9uAAAAABMAAAAAAAAAAAAAAAphdXRob3JpemVkAAAAAAABAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAAEENsYWltVHJhbnNmZXJyZWQAAAABAAAAEWNsYWltX3RyYW5zZmVycmVkAAAAAAAAAwAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAB",
        "AAAABQAAAAAAAAAAAAAAEFJldHVybkF1dGhvcml6ZWQAAAABAAAAEXJldHVybl9hdXRob3JpemVkAAAAAAAAAwAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAAAAAAAAHc3RhdGlvbgAAAAATAAAAAAAAAAAAAAALcmV0dXJuZWRfYXQAAAAABgAAAAAAAAAB",
        "AAAABQAAAAAAAAAAAAAAEk1lcmNoYW50UmVnaXN0ZXJlZAAAAAAAAQAAABNtZXJjaGFudF9yZWdpc3RlcmVkAAAAAAMAAAAAAAAACG1lcmNoYW50AAAAEwAAAAEAAAAAAAAABG5hbWUAAAAQAAAAAAAAAAAAAAAGYWN0aXZlAAAAAAABAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAB",
        "AAAABQAAAAAAAAAAAAAAFU1lcmNoYW50U3RhdHVzQ2hhbmdlZAAAAAAAAAEAAAAXbWVyY2hhbnRfc3RhdHVzX2NoYW5nZWQAAAAAAwAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAQAAAAAAAAAEbmFtZQAAABAAAAAAAAAAAAAAAAZhY3RpdmUAAAAAAAEAAAAAAAAAAQ==",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAMFQYXkgdGhlIGRlcG9zaXQgdG8gdGhlIGN1cnJlbnQgb3duZXIuIFBlcm1pc3Npb25sZXNzOiBvbmNlIGEgcmV0dXJuIGhhcwpiZWVuIGF0dGVzdGVkLCBhbnlvbmUgbWF5IHRyaWdnZXIgdGhlIHJlZnVuZCwgYnV0IHRoZSBmdW5kcyBjYW4gb25seSBnbwp0byB0aGUgd2FsbGV0IHRoYXQgb3ducyB0aGUgY2xhaW0gYXQgdGhhdCBtb21lbnQuAAAAAAAABnJlZGVlbQAAAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAPpAAAAEwAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2NsYWltAAAAAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAfQAAAABUNsYWltAAAAAAAAAw==",
        "AAAAAAAAAJNSZWFkIGEgYm91bmRlZCBsaXN0IG9mIGNsYWltcyBpbiBvbmUgY2FsbC4gVGhlIGxpbWl0IHByb3RlY3RzIHRoZQpjb250cmFjdCBmcm9tIHVuYm91bmRlZCByZXR1cm4gdmFsdWVzIGFuZCBtYWtlcyBkYXNoYm9hcmQgcGFnaW5hdGlvbgpwcmVkaWN0YWJsZS4AAAAACmdldF9jbGFpbXMAAAAAAAEAAAAAAAAACWNsYWltX2lkcwAAAAAAA+oAAAAGAAAAAQAAA+kAAAPqAAAH0AAAAAVDbGFpbQAAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X3BhdXNlZAAAAAAAAAAAAAEAAAAB",
        "AAAAAAAAAIZPbmUtdGltZSBzZXR1cC4gYGFkbWluYCBtYW5hZ2VzIHRoZSBtZXJjaGFudCBhbGxvd2xpc3Q7IGBkZXBvc2l0X3Rva2VuYAppcyB0aGUgU0VQLTQxIGFzc2V0IHVzZWQgZm9yIGV2ZXJ5IGRlcG9zaXQgaW4gdGhpcyBkZXBsb3ltZW50LgAAAAAACmluaXRpYWxpemUAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAANZGVwb3NpdF90b2tlbgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAKaXNfc3RhdGlvbgAAAAAAAgAAAAAAAAAGaXNzdWVyAAAAAAATAAAAAAAAAAdzdGF0aW9uAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAAMJQYXVzZSBvciB1bnBhdXNlIHRoZSBwYXJ0cyBvZiB0aGUgcHJvdG9jb2wgdGhhdCBjcmVhdGUgb3IgcmVkaXJlY3QKZXhwb3N1cmUuIFJlZGVtcHRpb24gZGVsaWJlcmF0ZWx5IHN0YXlzIGF2YWlsYWJsZSB3aGlsZSBwYXVzZWQgc28gYW4KZW1lcmdlbmN5IHN0b3AgY2FuIG5ldmVyIHN0cmFuZCBhIHJldHVybmVkIGl0ZW0ncyBkZXBvc2l0LgAAAAAACnNldF9wYXVzZWQAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADhMb2NrIGEgZGVwb3NpdCBhbmQgbWludCBhIHRyYW5zZmVyYWJsZSBjbGFpbSB0byBgb3duZXJgLgAAAAtpc3N1ZV9jbGFpbQAAAAAFAAAAAAAAAAZpc3N1ZXIAAAAAABMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAALc2VyaWFsX2hhc2gAAAAD7gAAACAAAAAAAAAAB2RlcG9zaXQAAAAACwAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAElDb21wbGV0ZSBhIHBlbmRpbmcgYWRtaW4gaGFuZG92ZXIuIE9ubHkgdGhlIG5vbWluYXRlZCBhZGRyZXNzIGNhbiBhY2NlcHQuAAAAAAAADGFjY2VwdF9hZG1pbgAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMZ2V0X21lcmNoYW50AAAAAQAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAQAAA+kAAAfQAAAACE1lcmNoYW50AAAAAw==",
        "AAAAAAAAAIdTdGFydCBhIHR3by1zdGVwIGFkbWluIGhhbmRvdmVyLiBUaGUgbm9taW5hdGVkIGFkZHJlc3MgbXVzdCBjYWxsCmBhY2NlcHRfYWRtaW5gLCB3aGljaCBwcmV2ZW50cyBhIHR5cG8gZnJvbSBwZXJtYW5lbnRseSBsb3NpbmcgY29udHJvbC4AAAAADXByb3Bvc2VfYWRtaW4AAAAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAD9SZXZva2UgYSByZXR1cm4gc3RhdGlvbi4gQWxyZWFkeS1hdHRlc3RlZCByZXR1cm5zIHJlbWFpbiB2YWxpZC4AAAAADnJlbW92ZV9zdGF0aW9uAAAAAAACAAAAAAAAAAZpc3N1ZXIAAAAAABMAAAAAAAAAB3N0YXRpb24AAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHxUcmFuc2ZlciB0aGUgZGVwb3NpdCBlbnRpdGxlbWVudCB0byBhbm90aGVyIHdhbGxldC4gT25seSB0aGUgY3VycmVudApvd25lciBjYW4gdHJhbnNmZXIsIGFuZCBvbmx5IHdoaWxlIHRoZSBjbGFpbSBpcyBhY3RpdmUuAAAADnRyYW5zZmVyX2NsYWltAAAAAAADAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPZ2V0X2NsYWltX2NvdW50AAAAAAAAAAABAAAABg==",
        "AAAAAAAAAL5BdHRlc3QgdGhhdCB0aGUgcGh5c2ljYWwgaXRlbSB3YXMgcmV0dXJuZWQuIFRoZSBzdGF0aW9uIG11c3QgYmUKYXV0aG9yaXNlZCBieSB0aGUgaXNzdWVyLCBhbmQgdGhlIHNlcmlhbCBoYXNoIG11c3QgbWF0Y2ggdGhlIGNsYWltIHNvIGEKUVIgY29kZSBmcm9tIGEgZGlmZmVyZW50IGl0ZW0gY2Fubm90IGNsb3NlIHRoaXMgY2xhaW0uAAAAAAAQYXV0aG9yaXplX3JldHVybgAAAAMAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAAHc3RhdGlvbgAAAAATAAAAAAAAAAtzZXJpYWxfaGFzaAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIJSZXR1cm4gdGhlIGxpdmUgY2xhaW0gaWQgZm9yIGFuIGAoaXNzdWVyLCBzZXJpYWxfaGFzaClgIHBhaXIsIGlmIGFueS4KVGhpcyBpcyB0aGUgc2FtZSBpbmRleCB1c2VkIHRvIHJlamVjdCBkdXBsaWNhdGUgYWN0aXZlIHRhZ3MuAAAAAAAQZ2V0X3NlcmlhbF9jbGFpbQAAAAIAAAAAAAAABmlzc3VlcgAAAAAAEwAAAAAAAAALc2VyaWFsX2hhc2gAAAAD7gAAACAAAAABAAAD6AAAAAY=",
        "AAAAAAAAAJBBdXRob3Jpc2UgYSByZXR1cm4gc3RhdGlvbiBmb3IgYSBzcGVjaWZpYyBpc3N1ZXIuIFN0YXRpb25zIGFyZSBzY29wZWQgdG8KdGhlIGlzc3VlciBiZWNhdXNlIHRoZSBpc3N1ZXIgaXMgdGhlIHBhcnR5IGFjY2VwdGluZyB0aGUgcmV0dXJuZWQgaXRlbS4AAAAQcmVnaXN0ZXJfc3RhdGlvbgAAAAIAAAAAAAAABmlzc3VlcgAAAAAAEwAAAAAAAAAHc3RhdGlvbgAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAARZ2V0X2RlcG9zaXRfdG9rZW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAAAAAAARZ2V0X3BlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAADxSZWdpc3RlciBhIG1lcmNoYW50IHRoYXQgaXMgYWxsb3dlZCB0byBpc3N1ZSBkZXBvc2l0IGNsYWltcy4AAAARcmVnaXN0ZXJfbWVyY2hhbnQAAAAAAAACAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABG5hbWUAAAAQAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAH5TdXNwZW5kIG9yIHJlLWVuYWJsZSBhIG1lcmNoYW50LiBFeGlzdGluZyBjbGFpbXMgc3RheSByZWRlZW1hYmxlOgpzdXNwZW5kaW5nIGFuIGlzc3VlciBtdXN0IG5ldmVyIHN0cmFuZCBhIGN1c3RvbWVyJ3MgZGVwb3NpdC4AAAAAABNzZXRfbWVyY2hhbnRfYWN0aXZlAAAAAAIAAAAAAAAACG1lcmNoYW50AAAAEwAAAAAAAAAGYWN0aXZlAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHtDYW5jZWwgYSBwZW5kaW5nIGhhbmRvdmVyLiBVc2VmdWwgd2hlbiB0aGUgbm9taW5hdGVkIGtleSBpcyBsb3N0IGJlZm9yZQppdCBhY2NlcHRzIG9yIHdoZW4gdGhlIG9wZXJhdG9yIGNoYW5nZXMgdGhlaXIgbWluZC4AAAAAFWNhbmNlbF9hZG1pbl90cmFuc2ZlcgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAZZ2V0X291dHN0YW5kaW5nX2xpYWJpbGl0eQAAAAAAAAEAAAAAAAAABmlzc3VlcgAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    redeem: this.txFromJSON<Result<void>>,
    get_admin: this.txFromJSON<Result<string>>,
    get_claim: this.txFromJSON<Result<Claim>>,
    get_claims: this.txFromJSON<Result<Array<Claim>>>,
    get_paused: this.txFromJSON<boolean>,
    initialize: this.txFromJSON<Result<void>>,
    is_station: this.txFromJSON<boolean>,
    set_paused: this.txFromJSON<Result<void>>,
    issue_claim: this.txFromJSON<Result<u64>>,
    accept_admin: this.txFromJSON<Result<void>>,
    get_merchant: this.txFromJSON<Result<Merchant>>,
    propose_admin: this.txFromJSON<Result<void>>,
    remove_station: this.txFromJSON<Result<void>>,
    transfer_claim: this.txFromJSON<Result<void>>,
    get_claim_count: this.txFromJSON<u64>,
    authorize_return: this.txFromJSON<Result<void>>,
    get_serial_claim: this.txFromJSON<Option<u64>>,
    register_station: this.txFromJSON<Result<void>>,
    get_deposit_token: this.txFromJSON<Result<string>>,
    get_pending_admin: this.txFromJSON<Option<string>>,
    register_merchant: this.txFromJSON<Result<void>>,
    set_merchant_active: this.txFromJSON<Result<void>>,
    cancel_admin_transfer: this.txFromJSON<Result<void>>,
    get_outstanding_liability: this.txFromJSON<Result<i128>>,
  };
}
