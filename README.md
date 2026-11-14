# LOOPTAG

**Deposit-backed, transferable claims for reusable physical assets on Stellar.**

[![CI](https://github.com/looptag-labs/looptag/actions/workflows/ci.yml/badge.svg)](https://github.com/looptag-labs/looptag/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0b1220.svg)](LICENSE)
[![Stellar testnet](https://img.shields.io/badge/Stellar-testnet-7b61ff.svg)](https://stellar.expert/explorer/testnet/contract/CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT)

LOOPTAG turns a reusable-cup or container deposit into a small, transferable
on-chain claim. A merchant locks the deposit in a Soroban contract and hands the
customer a claim. The claim can be gifted or resold. When the item comes back,
an issuer-authorised return station attests to the return, and the contract pays
the deposit to whoever owns the claim **at that moment** — not necessarily the
wallet that originally paid.

The result is a deposit that behaves like money while the item is out in the
world, instead of a paper token that is easy to lose and hard to redeem.

> **Status:** v0.1 is deployed on Stellar testnet and has completed a full
> issue → transfer → return → redeem lifecycle with native XLM. The v0.2
> contract adds pause controls, two-step admin rotation, per-issuer serial
> uniqueness, exact-transfer token checks, and bounded batch reads; it is
> implemented and covered by 26 contract tests, pending a fresh testnet
> deployment. See [testnet evidence](docs/TESTNET_EVIDENCE.md). The demo
> dashboard is a read-only snapshot; it does not sign transactions.

## Why this exists

Reusable packaging schemes fail for three practical reasons:

1. **The deposit is trapped in a receipt.** Lose the paper token and the money is
   gone, so customers rationally treat the deposit as a fee.
2. **Deposits cannot circulate.** A friend cannot take your cup back for you, and
   a second-hand cup has no refund value.
3. **Merchants cannot prove their liability.** Finance and operations teams have
   no clean view of how much deposit money is still outstanding.

LOOPTAG makes the claim a first-class, transferable asset while keeping the
refund conditional on a physical return attestation. The contract never pretends
to verify the physical world. It makes the *financial* rules explicit and
auditable, and leaves the physical attestation to a named, revocable station.

## What is live on testnet

| Item | Value |
| --- | --- |
| Network | Stellar testnet |
| Contract | [`CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT`](https://stellar.expert/explorer/testnet/contract/CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT) |
| Deposit asset | Native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Demo claim | `#1`, serial `CUP-042`, **2 XLM** |
| Lifecycle | Issued → transferred → return attested → redeemed |
| Final state | Claim `Redeemed`; merchant outstanding `0`; owner paid 2 XLM |
| WASM hash | `dd4eeb3d6f27857e7ac2be2f99c1c94600c6718b6e521fdc4ee833b6de871a0f` |

The complete list of transaction hashes and the reproducible command sequence is
in [docs/TESTNET_EVIDENCE.md](docs/TESTNET_EVIDENCE.md).

## How it works

```text
 customer                     LOOPTAG contract                  merchant
    │                               │                              │
    │                               │  1. issue_claim(deposit)     │
    │                               │ <──── locks 2 XLM ───────────│
    │ <──── claim #1 (owner) ───────│                              │
    │                               │                              │
    │  2. transfer_claim(#1 → bob)  │                              │
    │ ─────────────────────────────>│                              │
    │                               │                              │
 return station                    │                              │
    │  3. authorize_return(#1)      │                              │
    │ ─────────────────────────────>│  checks station allowlist    │
    │                               │  checks serial hash          │
    │                               │                              │
 anyone                           │                              │
    │  4. redeem(#1)                │                              │
    │ ─────────────────────────────>│ ─── 2 XLM → current owner ──>│
    │                               │     outstanding -= 2 XLM     │
```

The important separation:

- **Ownership** is transferable at any time while the claim is `Active`.
- **Return attestation** freezes transfers and proves the item is back.
- **Redemption** is permissionless, but can only pay the current owner, so a
  station or relayer cannot redirect the refund.
- **Suspending a merchant** blocks new issuance but never strands existing
  claims.

Read the full state machine in [docs/LIFECYCLE.md](docs/LIFECYCLE.md), the
contract entry points and event catalog in [docs/API.md](docs/API.md), and the
trust boundaries in [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md).

## Repository layout

```text
looptag/
├── contracts/looptag/       Soroban contract (Rust) + 26 unit/property tests
├── packages/sdk/            TypeScript SDK, QR format, tx builders, event paging + tests
├── demo/                    Static read-only lifecycle dashboard + QR asset
├── deployments/testnet.json Machine-readable deployment manifest
├── docs/                    Architecture, trust model, threat model, evidence
├── scripts/                 Reproducible deploy/demo/check scripts
└── .github/                 CI, issue templates, PR template, CODEOWNERS
```

## Quick start

Prerequisites: Node.js 22+, pnpm 10+, Rust stable with the `wasm32v1-none`
target, and (for deploying) Stellar CLI 27+.

```bash
# TypeScript SDK
pnpm install
pnpm --filter @looptag/sdk build
pnpm --filter @looptag/sdk test

# Soroban contract
cd contracts
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Run the repository checks:

```bash
pnpm check:all
```

Build the contract WASM:

```bash
cd contracts
stellar contract build
# contracts/target/wasm32v1-none/release/looptag.wasm
```

### Reproduce the lifecycle on testnet

The scripts assume funded testnet identities in your Stellar CLI config. Secret
keys never belong in this repository.

```bash
export STELLAR_CONFIG_DIR="$HOME/.config/stellar"
export ADMIN=admin ALICE=alice BOB=bob STATION=station
./scripts/demo-testnet.sh
```

To deploy a fresh instance and run first-time setup:

```bash
export ADMIN=admin STATION=station
./scripts/deploy-testnet.sh
```

After deploying, update `deployments/testnet.json` and run
`pnpm check:deployments`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Demo dashboard

Serve the repository root and open `demo/index.html`:

```bash
python3 -m http.server 8080
# http://localhost:8080/demo/
```

The dashboard loads `deployments/testnet.json`, renders the real claim snapshot,
and links every step to Stellar Expert. It is intentionally read-only; wallet
signing is tracked in the issue backlog.

## SDK

```ts
import {
  LooptagError,
  authorizeReturn,
  buildIssueClaimTx,
  createClient,
  decodeClaimQr,
  decodeLooptagEvent,
  encodeClaimQr,
  fromStroops,
  issueClaim,
  redeem,
  toStroops,
  transferClaim,
} from "@looptag/sdk";

const client = createClient({
  contractId: "CCTM224EKYEXNSULQBEW2HRG5CICUWWE46MLSRSASJZUQKXI5E5LK5GT",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  publicKey: "G...issuer...",
});

const payload = encodeClaimQr({
  network: "testnet",
  contractId: client.options.contractId,
  claimId: "1",
  serialHash: "fa6ceb8d7a5cd1b8bc7c5959830c30704aad79dbe1ba90a794f04de6868712b1",
});

const scanned = decodeClaimQr(payload); // verifies the checksum
const deposit = toStroops("2");         // 20000000n (always pass money as a plain decimal string)
console.log(fromStroops(deposit));      // "2"

// 1. Simulate -> sign -> send with the generated client helpers.
// Inputs are validated locally, `serial` is hashed via SHA-256 into a 32-byte
// Buffer, and failed simulations throw a typed `LooptagError` with `err.code`.
try {
  const assembled = await issueClaim(client, {
    issuer: "G...issuer...",
    owner: "G...customer...",
    serial: "CUP-042",
    deposit,
  });

  // Key custody stays outside the SDK: sign with Freighter / wallet / signer
  // and submit the simulated `AssembledTransaction`.
  const sent = await assembled.signAndSend({
    signTransaction: async (xdr) => wallet.signTransaction(xdr),
  });
  const claimId = sent.result.unwrap();

  // Subsequent lifecycle steps follow the same simulate -> signAndSend flow:
  const transferAssembled = await transferClaim(client, {
    claimId,
    from: "G...customer...",
    to: "G...friend...",
  });
  await transferAssembled.signAndSend({ signTransaction: customerSign });

  const returnAssembled = await authorizeReturn(client, {
    claimId,
    station: "G...station...",
    serial: "CUP-042",
  });
  await returnAssembled.signAndSend({ signTransaction: stationSign });

  const redeemAssembled = await redeem(client, { claimId });
  await redeemAssembled.signAndSend({ signTransaction: relayerSign });
} catch (err) {
  if (err instanceof LooptagError) {
    console.error(`Contract error #${err.code} (${err.errorName}): ${err.message}`);
  }
}

// 2. Low-level unsigned XDR builders are also available when managing sequence
// numbers and Soroban simulation manually:
const issueTx = buildIssueClaimTx({
  contractId: client.options.contractId,
  source: "G...issuer...",
  sequence: "123",
  owner: "G...customer...",
  serialHash: scanned.serialHash,
  deposit,
});
```

The SDK is deliberately small. It contains exact amount handling (pass money as
a plain decimal string to avoid floating-point rounding), QR
encoding/decoding, claim state helpers, a typed contract client, simulated
lifecycle helpers (`issueClaim`, `transferClaim`, `authorizeReturn`, `redeem`)
with contract error decoding, unsigned transaction builders, and a typed event
decoder plus one-page RPC event fetch. A persisted indexer/read API is tracked
as a scoped issue.

## Security

This is testnet software and has not been audited. The contract is
non-upgradeable in v0. Read [SECURITY.md](SECURITY.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before using it with real value.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Please do not open a public issue for an exploitable finding.

## Contributing

Good first issues are labelled `good first issue` and `Stellar Wave`. Every
issue includes acceptance criteria and the files it touches. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), and use the PR checklist so reviewers can
verify your work quickly.

The Wave 11 maintainer/contributor checklist is in
[docs/WAVE_11.md](docs/WAVE_11.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md). The short version: v0 proves the lifecycle and
accounting invariant; v1 adds a real indexer, transaction helpers, and a wallet
demo; v2 explores multi-asset deposits, station staking, and expiry policy.

## License

MIT. See [LICENSE](LICENSE).
