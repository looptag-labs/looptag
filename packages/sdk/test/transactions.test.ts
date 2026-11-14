import { Address, Transaction, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  NETWORK_PASSPHRASES,
  amountToScVal,
  buildAuthorizeReturnTx,
  buildIssueClaimTx,
  buildRedeemTx,
  buildTransferClaimTx,
  bytes32ToScVal,
  networkPassphrase,
  u64ToScVal,
} from "../src/transactions.js";

const SOURCE = "GDI6UIHJGRSHN4FF6FWXUWSVQYYAV2BBH734S3LCYCQQCWYWLLEQ2UXJ";
const OWNER = "GANINHD7GYIUIYH7WTGQ25TZ3BMEJG5JIW6JIJNVOB7PQPWABVW5LQJP";
const STATION = "GDSROSZJFCNGBLFFY3NKMKKC5CMCOXTCAYTL7DFZMRT2P5NF4J4RVBWH";
const CONTRACT = "CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT";
const SERIAL_HASH =
  "fa6ceb8d7a5cd1b8bc7c5959830c30704aad79dbe1ba90a794f04de6868712b1";

const base = {
  contractId: CONTRACT,
  source: SOURCE,
  sequence: "123",
};

describe("transaction builders", () => {
  it("builds an issue_claim transaction with the expected source and network", () => {
    const tx = buildIssueClaimTx({
      ...base,
      owner: OWNER,
      serialHash: SERIAL_HASH,
      deposit: 20_000_000n,
    });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.networkPassphrase).toBe(NETWORK_PASSPHRASES.testnet);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");

    const operation = tx.toEnvelope().v1().tx().operations()[0];
    const invoke = operation.body().invokeHostFunctionOp();
    const args = invoke.hostFunction().invokeContract().args();
    expect(args).toHaveLength(5);
    expect(args[0].address().toXDR("hex")).toBe(
      Address.fromString(SOURCE).toScVal().address().toXDR("hex"),
    );
    expect(Buffer.from(args[2].bytes()).toString("hex")).toBe(SERIAL_HASH);
    expect(args[3].i128().lo().toString()).toBe("20000000");
    expect(args[3].i128().hi().toString()).toBe("0");
  });

  it("builds transfer, return, and redeem transactions", () => {
    const transfer = buildTransferClaimTx({
      ...base,
      claimId: 9n,
      to: OWNER,
    });
    const returned = buildAuthorizeReturnTx({
      ...base,
      claimId: 9,
      serialHash: SERIAL_HASH,
    });
    const redeem = buildRedeemTx({ ...base, claimId: "9" });

    for (const tx of [transfer, returned, redeem]) {
      expect(tx.operations[0].type).toBe("invokeHostFunction");
    }

    const redeemArgs = redeem
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    expect(redeemArgs[0].u64().toString()).toBe("9");
  });

  it("honours an explicit mainnet passphrase", () => {
    const tx = buildRedeemTx({
      ...base,
      claimId: 1,
      network: "mainnet",
    });
    expect(tx.networkPassphrase).toBe(NETWORK_PASSPHRASES.mainnet);
    expect(networkPassphrase("futurenet")).toContain("Future Network");
  });

  it("accepts raw serial hash bytes and rejects malformed values", () => {
    const bytes = Buffer.from(SERIAL_HASH, "hex");
    expect(bytes32ToScVal(bytes)).toBeInstanceOf(xdr.ScVal);
    expect(() => bytes32ToScVal(Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => bytes32ToScVal("nope")).toThrow(/64 lowercase hex/);
    expect(() => amountToScVal(0n)).toThrow(/positive i128/);
    expect(() => u64ToScVal(2n ** 64n)).toThrow(/unsigned 64-bit/);
  });

  it("rejects invalid transaction parameters before signing", () => {
    expect(() =>
      buildRedeemTx({ ...base, contractId: "not-a-contract", claimId: 1 }),
    ).toThrow(/contract id/);
    expect(() =>
      buildRedeemTx({ ...base, sequence: "1e3", claimId: 1 }),
    ).toThrow(/sequence/);
    expect(() =>
      buildRedeemTx({ ...base, claimId: 1, timeoutSeconds: 0 }),
    ).toThrow(/timeoutSeconds/);
    expect(() => buildRedeemTx({ ...base, claimId: 1, fee: "1.5" })).toThrow(
      /fee/,
    );
  });
});
