import { Buffer } from "buffer";
import { Err, Ok } from "@stellar/stellar-sdk/contract";
import type {
  AssembledTransaction,
  Result,
} from "@stellar/stellar-sdk/contract";
import { describe, expect, it, vi } from "vitest";
import {
  LOOPTAG_CONTRACT_ERRORS,
  LooptagError,
  authorizeReturn,
  decodeLooptagError,
  getContractErrorDescriptor,
  hashSerial,
  issueClaim,
  redeem,
  toStroops,
  transferClaim,
  type LooptagTxClient,
} from "../src/index.js";
import { Errors as GeneratedErrors } from "../src/generated/index.js";

const ISSUER = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const OWNER = "GANINHD7GYIUIYH7WTGQ25TZ3BMEJG5JIW6JIJNVOB7PQPWABVW5LQJP";
const RECIPIENT = "GDSROSZJFCNGBLFFY3NKMKKC5CMCOXTCAYTL7DFZMRT2P5NF4J4RVBWH";
const STATION_CONTRACT =
  "CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT";

function okTx<T>(
  value: T,
  extra: Record<string, unknown> = {},
): AssembledTransaction<Result<T>> {
  return {
    result: new Ok(value),
    signAndSend: vi.fn(),
    ...extra,
  } as unknown as AssembledTransaction<Result<T>>;
}

function errTx<T>(
  errorName: string,
  simulationError?: string,
): AssembledTransaction<Result<T>> {
  return {
    result: new Err({ message: errorName }),
    ...(simulationError ? { simulation: { error: simulationError } } : {}),
    signAndSend: vi.fn(),
  } as unknown as AssembledTransaction<Result<T>>;
}

function createMockClient(
  overrides: Partial<LooptagTxClient> = {},
): LooptagTxClient {
  return {
    issue_claim: vi.fn().mockResolvedValue(okTx(1n)),
    transfer_claim: vi.fn().mockResolvedValue(okTx(undefined)),
    authorize_return: vi.fn().mockResolvedValue(okTx(undefined)),
    redeem: vi.fn().mockResolvedValue(okTx(undefined)),
    ...overrides,
  };
}

describe("transaction simulation helpers (tx.ts)", () => {
  it("normalizes inputs, hashes serial to a 32-byte Buffer, and returns the AssembledTransaction unchanged", async () => {
    const expectedTx = okTx(7n, { marker: "untouched-tx-instance" });
    const issueMock = vi.fn().mockResolvedValue(expectedTx);
    const client = createMockClient({ issue_claim: issueMock });

    const returned = await issueClaim(
      client,
      {
        issuer: `  ${ISSUER}  `,
        owner: ` ${OWNER} `,
        serial: "  CUP-042  ",
        deposit: toStroops("2"),
        expiresAt: 1_800_000_000,
      },
      { fee: "500" },
    );

    expect(returned).toBe(expectedTx);
    expect(expectedTx.signAndSend).not.toHaveBeenCalled();

    const expectedHashHex = await hashSerial("CUP-042");
    expect(issueMock).toHaveBeenCalledTimes(1);
    const [callArgs, callOptions] = issueMock.mock.calls[0];
    expect(callArgs.issuer).toBe(ISSUER);
    expect(callArgs.owner).toBe(OWNER);
    expect(Buffer.isBuffer(callArgs.serial_hash)).toBe(true);
    expect(callArgs.serial_hash.length).toBe(32);
    expect(callArgs.serial_hash.toString("hex")).toBe(expectedHashHex);
    expect(callArgs.deposit).toBe(20_000_000n);
    expect(callArgs.expires_at).toBe(1_800_000_000n);
    expect(callOptions).toEqual({ fee: "500" });
  });

  it("supports transferClaim, authorizeReturn (including contract station addresses), and redeem", async () => {
    const transferTx = okTx<void>(undefined);
    const returnTx = okTx<void>(undefined);
    const redeemTx = okTx<void>(undefined);

    const client: LooptagTxClient = {
      issue_claim: vi.fn(),
      transfer_claim: vi.fn().mockResolvedValue(transferTx),
      authorize_return: vi.fn().mockResolvedValue(returnTx),
      redeem: vi.fn().mockResolvedValue(redeemTx),
    };

    expect(
      await transferClaim(client, {
        claimId: "42",
        from: OWNER,
        to: RECIPIENT,
      }),
    ).toBe(transferTx);
    expect(client.transfer_claim).toHaveBeenCalledWith(
      { claim_id: 42n, from: OWNER, to: RECIPIENT },
      undefined,
    );

    expect(
      await authorizeReturn(client, {
        claimId: 42,
        station: STATION_CONTRACT,
        serial: "CUP-042",
      }),
    ).toBe(returnTx);
    const [returnArgs] = (client.authorize_return as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(returnArgs.claim_id).toBe(42n);
    expect(returnArgs.station).toBe(STATION_CONTRACT);
    expect(Buffer.isBuffer(returnArgs.serial_hash)).toBe(true);
    expect(returnArgs.serial_hash.toString("hex")).toBe(
      await hashSerial("CUP-042"),
    );

    expect(await redeem(client, { claimId: 42n })).toBe(redeemTx);
    expect(client.redeem).toHaveBeenCalledWith({ claim_id: 42n }, undefined);
  });

  it("skips result inspection when MethodOptions.simulate is false", async () => {
    const unsimulatedTx = {
      get result(): Result<void> {
        throw new Error("Transaction has not yet been simulated");
      },
      signAndSend: vi.fn(),
    } as unknown as AssembledTransaction<Result<void>>;

    const client = createMockClient({
      redeem: vi.fn().mockResolvedValue(unsimulatedTx),
    });

    const returned = await redeem(client, { claimId: 1n }, { simulate: false });
    expect(returned).toBe(unsimulatedTx);
  });

  it("rejects invalid addresses, zero/negative deposits, malformed serials, and unknown claim ids before any network call", async () => {
    const client = createMockClient();

    // Invalid addresses
    await expect(
      issueClaim(client, {
        issuer: "NOT_AN_ADDRESS",
        owner: OWNER,
        serial: "CUP-042",
        deposit: 100n,
      }),
    ).rejects.toThrow(/invalid Stellar address for issuer/);

    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: "",
        serial: "CUP-042",
        deposit: 100n,
      }),
    ).rejects.toThrow(/invalid Stellar address for owner/);

    await expect(
      transferClaim(client, {
        claimId: 1n,
        from: OWNER,
        to: OWNER,
      }),
    ).rejects.toThrow(/from and to addresses must differ/);

    // Zero, negative, or non-integer deposits
    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: OWNER,
        serial: "CUP-042",
        deposit: 0n,
      }),
    ).rejects.toThrow(/positive i128/);

    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: OWNER,
        serial: "CUP-042",
        deposit: -500n,
      }),
    ).rejects.toThrow(/positive i128/);

    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: OWNER,
        serial: "CUP-042",
        deposit: "2.5",
      }),
    ).rejects.toThrow(/integer base-unit amount/);

    // Malformed serials
    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: OWNER,
        serial: "   ",
        deposit: 100n,
      }),
    ).rejects.toThrow(/non-empty string/);

    await expect(
      authorizeReturn(client, {
        claimId: 1n,
        station: RECIPIENT,
        serial: "CUP\u0000BAD",
      }),
    ).rejects.toThrow(/control characters/);

    await expect(
      authorizeReturn(client, {
        claimId: 1n,
        station: RECIPIENT,
        serial: "X".repeat(257),
      }),
    ).rejects.toThrow(/at most 256 characters/);

    // Unknown / out-of-range claim IDs
    await expect(redeem(client, { claimId: 0 })).rejects.toThrow(
      /unknown or out-of-range claimId/,
    );
    await expect(redeem(client, { claimId: -1n })).rejects.toThrow(
      /unknown or out-of-range claimId/,
    );
    await expect(redeem(client, { claimId: "not-a-number" })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      redeem(client, { claimId: 18_446_744_073_709_551_616n }),
    ).rejects.toThrow(/unknown or out-of-range claimId/);

    // Negative expiry
    await expect(
      issueClaim(client, {
        issuer: ISSUER,
        owner: OWNER,
        serial: "CUP-042",
        deposit: 100n,
        expiresAt: -1,
      }),
    ).rejects.toThrow(/unsigned 64-bit integer/);

    expect(client.issue_claim).not.toHaveBeenCalled();
    expect(client.transfer_claim).not.toHaveBeenCalled();
    expect(client.authorize_return).not.toHaveBeenCalled();
    expect(client.redeem).not.toHaveBeenCalled();
  });

  it("maps every contract error code (1..15 and v0.2 codes 16..22) to a readable name and message", () => {
    const generatedCodes = Object.keys(GeneratedErrors).map(Number);
    expect(generatedCodes.length).toBeGreaterThanOrEqual(15);

    for (const code of generatedCodes) {
      const expectedName =
        GeneratedErrors[code as keyof typeof GeneratedErrors].message;
      const descriptor = getContractErrorDescriptor(code);
      expect(descriptor).toBeDefined();
      expect(descriptor?.code).toBe(code);
      expect(descriptor?.name).toBe(expectedName);
      expect(descriptor?.message.length).toBeGreaterThan(10);
    }

    for (let code = 1; code <= 15; code += 1) {
      const entry =
        LOOPTAG_CONTRACT_ERRORS[code as keyof typeof LOOPTAG_CONTRACT_ERRORS];
      expect(entry.code).toBe(code);
      expect(entry.name).toBeTruthy();
      expect(entry.message).toBeTruthy();
    }
  });

  it("decodes failed Result<T> simulations and HostError strings into typed LooptagError instances", async () => {
    for (const [codeKey, descriptor] of Object.entries(
      LOOPTAG_CONTRACT_ERRORS,
    )) {
      const numericCode = Number(codeKey);
      const client = createMockClient({
        redeem: vi.fn().mockResolvedValue(errTx<void>(descriptor.name)),
      });

      await expect(redeem(client, { claimId: 1n })).rejects.toMatchObject({
        name: "LooptagError",
        code: numericCode,
        errorName: descriptor.name,
      });
    }

    // Also decodes raw Soroban RPC simulation failure errors (`Error(Contract, #11)`)
    const hostErrorClient = createMockClient({
      authorize_return: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Transaction simulation failed: "HostError: Error(Contract, #11)"',
          ),
        ),
    });

    let caught: unknown;
    try {
      await authorizeReturn(hostErrorClient, {
        claimId: 5n,
        station: RECIPIENT,
        serial: "WRONG-CUP",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LooptagError);
    expect((caught as LooptagError).code).toBe(11);
    expect((caught as LooptagError).errorName).toBe("SerialMismatch");
    expect((caught as LooptagError).message).toContain("SerialMismatch");

    // Forward-compatible with unknown future numeric contract error codes
    const futureErr = decodeLooptagError("HostError: Error(Contract, #99)");
    expect(futureErr).toBeInstanceOf(LooptagError);
    expect(futureErr?.code).toBe(99);
    expect(futureErr?.errorName).toBe("UnknownContractError");
  });
});
