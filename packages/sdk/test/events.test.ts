import { Buffer } from "buffer";
import { nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { decodeLooptagEvent, fetchLooptagEvents } from "../src/events.js";

const SERIAL_HASH =
  "fa6ceb8d7a5cd1b8bc7c5959830c30704aad79dbe1ba90a794f04de6868712b1";
const ADMIN = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const ISSUER = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const OWNER = "GANINHD7GYIUIYH7WTGQ25TZ3BMEJG5JIW6JIJNVOB7PQPWABVW5LQJP";
const STATION = "GDSROSZJFCNGBLFFY3NKMKKC5CMCOXTCAYTL7DFZMRT2P5NF4J4RVBWH";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function topic(name: string): xdr.ScVal {
  return nativeToScVal(name, { type: "symbol" });
}

function vec(...values: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(values);
}

describe("event decoding", () => {
  it("decodes claim_issued", () => {
    const decoded = decodeLooptagEvent(
      [topic("claim_issued"), nativeToScVal(1n, { type: "u64" })],
      vec(
        nativeToScVal(ISSUER, { type: "address" }),
        nativeToScVal(OWNER, { type: "address" }),
        nativeToScVal(20_000_000n, { type: "i128" }),
        nativeToScVal(Buffer.from(SERIAL_HASH, "hex"), { type: "bytes" }),
        nativeToScVal(0n, { type: "u64" }),
      ),
    );

    expect(decoded).toEqual({
      type: "claim_issued",
      claimId: "1",
      issuer: ISSUER,
      owner: OWNER,
      deposit: 20_000_000n,
      serialHash: SERIAL_HASH,
      expiresAt: 0,
    });
  });

  it("decodes init without treating the admin address as a claim id", () => {
    const decoded = decodeLooptagEvent(
      [topic("init"), nativeToScVal(ADMIN, { type: "address" })],
      vec(nativeToScVal(XLM, { type: "address" })),
    );

    expect(decoded).toEqual({ type: "init", admin: ADMIN, depositToken: XLM });
  });

  it("decodes merchant and station events", () => {
    expect(
      decodeLooptagEvent(
        [
          topic("merchant_registered"),
          nativeToScVal(ISSUER, { type: "address" }),
        ],
        vec(
          nativeToScVal("Circular Cafe", { type: "string" }),
          nativeToScVal(true),
        ),
      ),
    ).toEqual({
      type: "merchant_registered",
      merchant: ISSUER,
      name: "Circular Cafe",
      active: true,
    });

    expect(
      decodeLooptagEvent(
        [
          topic("merchant_status_changed"),
          nativeToScVal(ISSUER, { type: "address" }),
        ],
        vec(
          nativeToScVal("Circular Cafe", { type: "string" }),
          nativeToScVal(false),
        ),
      ),
    ).toEqual({
      type: "merchant_status_changed",
      merchant: ISSUER,
      name: "Circular Cafe",
      active: false,
    });

    expect(
      decodeLooptagEvent(
        [topic("station_changed"), nativeToScVal(ISSUER, { type: "address" })],
        vec(nativeToScVal(STATION, { type: "address" }), nativeToScVal(false)),
      ),
    ).toEqual({
      type: "station_changed",
      issuer: ISSUER,
      station: STATION,
      authorized: false,
    });
  });

  it("decodes claim_transferred", () => {
    expect(
      decodeLooptagEvent(
        [topic("claim_transferred"), nativeToScVal(42n, { type: "u64" })],
        vec(
          nativeToScVal(OWNER, { type: "address" }),
          nativeToScVal(STATION, { type: "address" }),
        ),
      ),
    ).toEqual({
      type: "claim_transferred",
      claimId: "42",
      from: OWNER,
      to: STATION,
    });
  });

  it("decodes the return and redemption events", () => {
    expect(
      decodeLooptagEvent(
        [topic("return_authorized"), nativeToScVal(1n, { type: "u64" })],
        vec(
          nativeToScVal(STATION, { type: "address" }),
          nativeToScVal(1_794_093_252n, { type: "u64" }),
        ),
      ),
    ).toEqual({
      type: "return_authorized",
      claimId: "1",
      station: STATION,
      returnedAt: 1_794_093_252,
    });

    expect(
      decodeLooptagEvent(
        [topic("claim_redeemed"), nativeToScVal(1n, { type: "u64" })],
        vec(
          nativeToScVal(OWNER, { type: "address" }),
          nativeToScVal(20_000_000n, { type: "i128" }),
        ),
      ),
    ).toEqual({
      type: "claim_redeemed",
      claimId: "1",
      owner: OWNER,
      deposit: 20_000_000n,
    });
  });

  it("decodes pause and admin handover events", () => {
    expect(
      decodeLooptagEvent(
        [topic("pause_changed"), nativeToScVal(ADMIN, { type: "address" })],
        vec(nativeToScVal(true)),
      ),
    ).toEqual({ type: "pause_changed", admin: ADMIN, paused: true });

    expect(
      decodeLooptagEvent(
        [
          topic("admin_transfer_proposed"),
          nativeToScVal(ADMIN, { type: "address" }),
        ],
        vec(nativeToScVal(STATION, { type: "address" })),
      ),
    ).toEqual({
      type: "admin_transfer_proposed",
      admin: ADMIN,
      newAdmin: STATION,
    });

    expect(
      decodeLooptagEvent(
        [
          topic("admin_transfer_cancelled"),
          nativeToScVal(ADMIN, { type: "address" }),
        ],
        vec(),
      ),
    ).toEqual({ type: "admin_transfer_cancelled", admin: ADMIN });

    expect(
      decodeLooptagEvent(
        [topic("admin_changed"), nativeToScVal(ADMIN, { type: "address" })],
        vec(nativeToScVal(STATION, { type: "address" })),
      ),
    ).toEqual({ type: "admin_changed", oldAdmin: ADMIN, newAdmin: STATION });
  });

  it("ignores unknown events", () => {
    expect(
      decodeLooptagEvent([topic("other")], vec(nativeToScVal(1n))),
    ).toBeNull();
  });

  it("fetches, filters, and decodes one RPC event page", async () => {
    const page = {
      events: [
        {
          id: "0000000001",
          type: "contract",
          ledger: 42,
          ledgerClosedAt: "2026-11-14T00:00:00Z",
          transactionIndex: 0,
          operationIndex: 0,
          inSuccessfulContractCall: true,
          txHash: "abc",
          contractId: XLM,
          topic: [topic("claim_redeemed"), nativeToScVal(1n, { type: "u64" })],
          value: vec(
            nativeToScVal(OWNER, { type: "address" }),
            nativeToScVal(20_000_000n, { type: "i128" }),
          ),
        },
        {
          id: "0000000002",
          type: "contract",
          ledger: 42,
          ledgerClosedAt: "2026-11-14T00:00:00Z",
          transactionIndex: 0,
          operationIndex: 0,
          inSuccessfulContractCall: true,
          txHash: "def",
          contractId: XLM,
          topic: [topic("other")],
          value: vec(nativeToScVal(1n)),
        },
        {
          id: "0000000003",
          type: "contract",
          ledger: 42,
          ledgerClosedAt: "2026-11-14T00:00:00Z",
          transactionIndex: 0,
          operationIndex: 0,
          inSuccessfulContractCall: true,
          txHash: "ghi",
          contractId:
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
          topic: [topic("claim_redeemed"), nativeToScVal(2n, { type: "u64" })],
          value: vec(
            nativeToScVal(OWNER, { type: "address" }),
            nativeToScVal(1n, { type: "i128" }),
          ),
        },
      ],
      cursor: "next-cursor",
      latestLedger: 43,
    };
    const getEvents = vi.fn().mockResolvedValue(page);
    const server = { getEvents } as unknown as rpc.Server;

    const result = await fetchLooptagEvents(server, {
      contractId: XLM,
      startLedger: 10,
    });

    expect(getEvents).toHaveBeenCalledWith({
      startLedger: 10,
      filters: [{ type: "contract", contractIds: [XLM] }],
      limit: 100,
    });
    expect(result.cursor).toBe("next-cursor");
    expect(result.latestLedger).toBe(43);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toEqual({
      type: "claim_redeemed",
      claimId: "1",
      owner: OWNER,
      deposit: 20_000_000n,
    });
    expect(result.events[0].ledger).toBe(42);
  });

  it("uses a cursor for subsequent pages and rejects ambiguous options", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      events: [],
      cursor: "next-cursor",
      latestLedger: 44,
    });
    const server = { getEvents } as unknown as rpc.Server;

    await fetchLooptagEvents(server, {
      contractId: XLM,
      cursor: "previous-cursor",
      limit: 25,
    });
    expect(getEvents).toHaveBeenCalledWith({
      cursor: "previous-cursor",
      filters: [{ type: "contract", contractIds: [XLM] }],
      limit: 25,
    });

    await expect(
      fetchLooptagEvents(server, {
        contractId: XLM,
        cursor: "previous-cursor",
        startLedger: 10,
      }),
    ).rejects.toThrow(/either cursor or startLedger/);
    await expect(
      fetchLooptagEvents(server, { contractId: XLM }),
    ).rejects.toThrow(/needs a cursor or startLedger/);
    await expect(
      fetchLooptagEvents(server, {
        contractId: XLM,
        startLedger: 10,
        limit: 0,
      }),
    ).rejects.toThrow(/limit/);
  });
});
