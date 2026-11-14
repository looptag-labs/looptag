import { Buffer } from "buffer";
import { nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  LooptagRpcError,
  TESTNET_CONTRACT_ID,
  fetchLooptagEvents,
  pollLooptagEvents,
} from "../src/index.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const ADMIN = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const ISSUER = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const OWNER = "GANINHD7GYIUIYH7WTGQ25TZ3BMEJG5JIW6JIJNVOB7PQPWABVW5LQJP";
const STATION = "GDSROSZJFCNGBLFFY3NKMKKC5CMCOXTCAYTL7DFZMRT2P5NF4J4RVBWH";
const OTHER_CONTRACT =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SERIAL_HASH =
  "fa6ceb8d7a5cd1b8bc7c5959830c30704aad79dbe1ba90a794f04de6868712b1";

function topicXdr(name: string): string {
  return nativeToScVal(name, { type: "symbol" }).toXDR("base64");
}

function u64Xdr(value: bigint): string {
  return nativeToScVal(value, { type: "u64" }).toXDR("base64");
}

function vecXdr(...values: xdr.ScVal[]): string {
  return xdr.ScVal.scvVec(values).toXDR("base64");
}

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchLooptagEvents / pollLooptagEvents (Soroban RPC poller)", () => {
  it("polls an empty page with startLedger + endLedger and returns latestLedger + cursor", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          events: [],
          cursor: "0000100000-0000000000",
          latestLedger: 100_250,
          oldestLedger: 90_000,
        },
      }),
    );

    const page = await fetchLooptagEvents({
      rpcUrl: RPC_URL,
      startLedger: 100_000,
      endLedger: 100_200,
      limit: 50,
      fetchFn: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(RPC_URL);
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        filters: [{ type: "contract", contractIds: [TESTNET_CONTRACT_ID] }],
        pagination: { limit: 50 },
        startLedger: 100_000,
        endLedger: 100_200,
      },
    });

    expect(page).toEqual({
      events: [],
      cursor: "0000100000-0000000000",
      latestLedger: 100_250,
      oldestLedger: 90_000,
      hasMore: false,
      skipped: 0,
      warnings: [],
    });
  });

  it("paginates across two pages via cursor without duplicating events", async () => {
    const page1Events = [
      {
        id: "0000100001-0000000001",
        pagingToken: "0000100001-0000000001",
        type: "contract",
        ledger: 100_001,
        ledgerClosedAt: "2026-11-14T12:00:00Z",
        contractId: TESTNET_CONTRACT_ID,
        txHash: "tx-issue-1",
        inSuccessfulContractCall: true,
        topic: [topicXdr("claim_issued"), u64Xdr(1n)],
        value: vecXdr(
          nativeToScVal(ISSUER, { type: "address" }),
          nativeToScVal(OWNER, { type: "address" }),
          nativeToScVal(20_000_000n, { type: "i128" }),
          nativeToScVal(Buffer.from(SERIAL_HASH, "hex"), { type: "bytes" }),
          nativeToScVal(1_800_000_000n, { type: "u64" }),
        ),
      },
      {
        id: "0000100002-0000000001",
        pagingToken: "0000100002-0000000001",
        type: "contract",
        ledger: 100_002,
        ledgerClosedAt: "2026-11-14T12:00:05Z",
        contractId: TESTNET_CONTRACT_ID,
        txHash: "tx-transfer-1",
        inSuccessfulContractCall: true,
        topic: [topicXdr("claim_transferred"), u64Xdr(1n)],
        value: vecXdr(
          nativeToScVal(OWNER, { type: "address" }),
          nativeToScVal(STATION, { type: "address" }),
        ),
      },
    ];

    const page2Events = [
      {
        id: "0000100003-0000000001",
        pagingToken: "0000100003-0000000001",
        type: "contract",
        ledger: 100_003,
        ledgerClosedAt: "2026-11-14T12:00:10Z",
        contractId: TESTNET_CONTRACT_ID,
        txHash: "tx-redeem-1",
        inSuccessfulContractCall: true,
        topic: [topicXdr("claim_redeemed"), u64Xdr(1n)],
        value: {
          xdr: vecXdr(
            nativeToScVal(STATION, { type: "address" }),
            nativeToScVal(20_000_000n, { type: "i128" }),
          ),
        },
      },
    ];

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            events: page1Events,
            cursor: "0000100002-0000000001",
            latestLedger: 100_005,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            events: page2Events,
            cursor: "0000100003-0000000001",
            latestLedger: 100_006,
          },
        }),
      );

    const first = await pollLooptagEvents({
      rpcUrl: RPC_URL,
      startLedger: 100_000,
      limit: 2,
      fetchFn: fetchMock,
    });

    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe("0000100002-0000000001");
    expect(first.events.map((e) => e.id)).toEqual([
      "0000100001-0000000001",
      "0000100002-0000000001",
    ]);

    const second = await pollLooptagEvents({
      rpcUrl: RPC_URL,
      cursor: first.cursor,
      limit: 2,
      fetchFn: fetchMock,
    });

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.params).toEqual({
      filters: [{ type: "contract", contractIds: [TESTNET_CONTRACT_ID] }],
      pagination: { cursor: "0000100002-0000000001", limit: 2 },
    });
    expect(second.hasMore).toBe(false);
    expect(second.events.map((e) => e.id)).toEqual(["0000100003-0000000001"]);

    const combinedIds = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(combinedIds).size).toBe(3);
  });

  it("isolates malformed XDR events into warnings without dropping valid siblings", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          events: [
            {
              id: "evt-corrupt-xdr",
              ledger: 500,
              ledgerClosedAt: "2026-11-14T12:00:00Z",
              contractId: TESTNET_CONTRACT_ID,
              txHash: "tx-bad-1",
              topic: ["!!!not-valid-base64-xdr!!!"],
              value: "AAAA",
            },
            {
              id: "evt-truncated-tuple",
              ledger: 501,
              ledgerClosedAt: "2026-11-14T12:00:05Z",
              contractId: TESTNET_CONTRACT_ID,
              txHash: "tx-bad-2",
              topic: [topicXdr("claim_transferred"), u64Xdr(9n)],
              value: vecXdr(nativeToScVal(OWNER, { type: "address" })),
            },
            {
              id: "evt-failed-call",
              ledger: 501,
              ledgerClosedAt: "2026-11-14T12:00:05Z",
              contractId: TESTNET_CONTRACT_ID,
              inSuccessfulContractCall: false,
              topic: ["!!!ignored-because-failed-call!!!"],
              value: "!!!ignored!!!",
            },
            {
              id: "evt-other-contract",
              ledger: 502,
              ledgerClosedAt: "2026-11-14T12:00:10Z",
              contractId: OTHER_CONTRACT,
              topic: [topicXdr("pause_changed")],
              value: vecXdr(),
            },
            {
              id: "evt-future-unknown",
              ledger: 502,
              ledgerClosedAt: "2026-11-14T12:00:10Z",
              contractId: TESTNET_CONTRACT_ID,
              topic: [topicXdr("future_v3_event")],
              value: vecXdr(nativeToScVal(1n)),
            },
            {
              id: "evt-valid-pause",
              ledger: 503,
              ledgerClosedAt: "2026-11-14T12:00:15Z",
              contractId: TESTNET_CONTRACT_ID,
              txHash: "tx-ok",
              topic: [
                topicXdr("pause_changed"),
                nativeToScVal(ADMIN, { type: "address" }).toXDR("base64"),
              ],
              value: vecXdr(nativeToScVal(true)),
            },
          ],
          latestLedger: 510,
        },
      }),
    );

    const page = await fetchLooptagEvents({
      rpcUrl: RPC_URL,
      startLedger: 500,
      fetchFn: fetchMock,
    });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toEqual({
      event: { type: "pause_changed", admin: ADMIN, paused: true },
      id: "evt-valid-pause",
      ledger: 503,
      ledgerClosedAt: "2026-11-14T12:00:15Z",
      txHash: "tx-ok",
      contractId: TESTNET_CONTRACT_ID,
    });
    // Falls back to the last raw event cursor when result.cursor is omitted
    expect(page.cursor).toBe("evt-valid-pause");
    expect(page.skipped).toBe(2);
    expect(page.warnings).toHaveLength(2);
    expect(page.warnings[0]).toMatchObject({
      index: 0,
      eventId: "evt-corrupt-xdr",
      ledger: 500,
    });
    expect(page.warnings[1]).toMatchObject({
      index: 1,
      eventId: "evt-truncated-tuple",
      ledger: 501,
    });
  });

  it("also isolates malformed events when called via the rpc.Server overload", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      events: [
        {
          id: "bad-server-evt",
          ledger: 77,
          ledgerClosedAt: "2026-11-14T00:00:00Z",
          contractId: TESTNET_CONTRACT_ID,
          txHash: "bad",
          topic: [nativeToScVal("claim_issued", { type: "symbol" })],
          value: xdr.ScVal.scvVec([]),
        },
        {
          id: "good-server-evt",
          ledger: 78,
          ledgerClosedAt: "2026-11-14T00:00:05Z",
          contractId: TESTNET_CONTRACT_ID,
          txHash: "good",
          topic: [
            nativeToScVal("admin_transfer_cancelled", { type: "symbol" }),
            nativeToScVal(ADMIN, { type: "address" }),
          ],
          value: xdr.ScVal.scvVec([]),
        },
      ],
      cursor: "good-server-evt",
      latestLedger: 80,
    });
    const server = { getEvents } as unknown as rpc.Server;

    const page = await fetchLooptagEvents(server, {
      contractId: TESTNET_CONTRACT_ID,
      startLedger: 70,
    });

    expect(page.events).toHaveLength(1);
    expect(page.events[0].event).toEqual({
      type: "admin_transfer_cancelled",
      admin: ADMIN,
    });
    expect(page.skipped).toBe(1);
    expect(page.warnings[0].eventId).toBe("bad-server-evt");
  });

  it("validates mutually exclusive cursor/ledger options and parameter bounds", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        cursor: "0001-0001",
        startLedger: 100,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/cursor cannot be combined/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        cursor: "0001-0001",
        endLedger: 200,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/cursor cannot be combined/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/either startLedger or cursor/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        startLedger: 200,
        endLedger: 199,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/endLedger .* greater than or equal to startLedger/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: "ftp://invalid-scheme.example",
        startLedger: 1,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/protocol/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        contractId: "NOT_A_CONTRACT",
        startLedger: 1,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/invalid Stellar contract id/);

    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        startLedger: 1,
        limit: 10_001,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow(/limit/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps HTTP, network, and JSON-RPC errors into LooptagRpcError", async () => {
    const networkFail = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        startLedger: 1,
        fetchFn: networkFail,
      }),
    ).rejects.toThrowError(LooptagRpcError);

    const httpFail = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      );
    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        startLedger: 1,
        fetchFn: httpFail,
      }),
    ).rejects.toMatchObject({
      name: "LooptagRpcError",
      httpStatus: 502,
    });

    const rpcError = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "startLedger is before oldest ledger (95000)",
          data: { oldestLedger: 95_000 },
        },
      }),
    );
    await expect(
      fetchLooptagEvents({
        rpcUrl: RPC_URL,
        startLedger: 10,
        fetchFn: rpcError,
      }),
    ).rejects.toMatchObject({
      name: "LooptagRpcError",
      rpcCode: -32600,
      rpcData: { oldestLedger: 95_000 },
    });
  });
});
