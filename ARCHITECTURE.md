# Architecture

LOOPTAG is split into four small pieces:

```text
┌──────────────────────┐      simulate / sign / submit      ┌────────────────────┐
│  SDK + wallet / app  │ ─────────────────────────────────> │  Stellar testnet   │
│  QR scanner, events  │ <───────────────────────────────── │  Soroban RPC       │
└──────────────────────┘          contract events           └─────────┬──────────┘
                                                                       │
                                                             ┌─────────▼──────────┐
                                                             │  LOOPTAG contract  │
                                                             │  claims, deposits, │
                                                             │  station allowlist │
                                                             └─────────┬──────────┘
                                                                       │ SEP-41 transfer
                                                             ┌─────────▼──────────┐
                                                             │  XLM SAC / asset   │
                                                             └────────────────────┘
```

There is no backend in v0. The contract is the source of truth, the SDK is a
thin typed client, and the dashboard reads a committed deployment snapshot. This
keeps the moving parts small enough to test and review.

## Components

### 1. Soroban contract (`contracts/looptag`)

The contract owns three pieces of state:

| Key | Storage | Purpose |
| --- | --- | --- |
| `Admin` | instance | account that manages the merchant allowlist |
| `DepositToken` | instance | SEP-41 asset used for every deposit in this deployment |
| `ClaimCount` | instance | monotonically increasing claim id |
| `Claim(id)` | persistent | owner, deposit, serial hash, status, return station |
| `Merchant(address)` | persistent | name, active flag, issued/redeemed counters, outstanding liability |
| `Station(issuer, station)` | persistent | issuer-scoped return-station allowlist |

The deposit token is a constructor-style parameter (`initialize`) rather than a
hard-coded XLM dependency. That makes the same contract usable with a stablecoin
or a tokenised fiat balance later. The current testnet deployment uses the
native XLM Stellar Asset Contract.

State transitions are intentionally narrow:

```text
                 issue_claim
                     │
                     ▼
                 ┌────────┐   transfer_claim   ┌────────┐
                 │ Active │ ─────────────────> │ Active │
                 └───┬────┘   (owner changes)  └────────┘
                     │ authorize_return
                     ▼
             ┌──────────────────┐
             │ ReturnAuthorized │  transfers frozen
             └────────┬─────────┘
                      │ redeem (permissionless)
                      ▼
                 ┌──────────┐
                 │ Redeemed │  terminal state
                 └──────────┘
```

`Active` is the only state in which ownership can change. `ReturnAuthorized` is
the only state in which money can leave the contract. `Redeemed` is terminal.
This ordering is what prevents a station from attesting a return and then having
a relayer redirect the refund to another wallet.

### 2. SEP-41 deposit token

The contract calls `transfer` on the configured token:

- `issue_claim`: `issuer → contract`, amount = deposit.
- `redeem`: `contract → current claim owner`, amount = deposit.

The contract never mints a token and never takes custody of anything except the
deposit. The accounting invariant is:

```text
for every merchant: outstanding == Σ deposit of claims in {Active, ReturnAuthorized}
```

`Merchant.outstanding` is updated in the same call as every balance movement.
`redeem` uses checks-effects-interactions: the claim is marked `Redeemed` before
the token transfer, so a re-entrant token cannot redeem twice.

### 3. TypeScript SDK (`packages/sdk`)

| Module | Responsibility |
| --- | --- |
| `amount.ts` | exact decimal ↔ stroop conversion without floating point drift |
| `qr.ts` | versioned QR payload, local validation, FNV-1a checksum, serial hashing |
| `claim.ts` | status labels, transfer/redeem/overdue predicates, dashboard summary |
| `client.ts` | typed client factory and Stellar Expert URL helpers |
| `events.ts` | decode contract events into discriminated TypeScript unions |
| `events-poller.ts` | cursor & ledger-window Soroban RPC `getEvents` poller with fault isolation |
| `generated/index.ts` | bindings generated from the contract spec |

The generated bindings are checked in so the SDK builds without a running
Stellar CLI. Regenerate them after changing the contract interface (see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

#### Event polling, cursor persistence, and idempotency

`fetchLooptagEvents` / `pollLooptagEvents` fetch a single bounded page from
Soroban RPC `getEvents` rather than hiding a background timer inside the SDK:

1. **Initial scan (`startLedger` / optional `endLedger`)**: On first boot with
   no saved checkpoint, pass `startLedger` (and optionally `endLedger` for
   bounded backfill). Note that Soroban RPC nodes only retain a rolling window
   of recent ledgers (`oldestLedger` .. `latestLedger`, typically ~24h–7d
   depending on the provider); historical gaps older than `oldestLedger` must be
   backfilled from a ledger archive before switching to live RPC polling.
2. **Steady-state polling (`cursor`)**: Persist `page.cursor` durably *after*
   committing `page.events` in the same database transaction (or after an
   idempotent upsert). Pass `{ cursor: savedCursor }` on the next call (`cursor`
   cannot be combined with `startLedger` or `endLedger` per Soroban RPC rules).
   When `page.hasMore` is `true`, immediately fetch the next page with
   `page.cursor` before sleeping until the next poll interval.
3. **Consumer idempotency**: Crash recovery between processing events and
   persisting `page.cursor` can replay the last page. Consumers should key
   deduplication on `event.id` (the globally unique Soroban event paging token)
   — or `(txHash, event.id)` — so re-delivering an already-indexed event is a
   safe no-op. Malformed XDR payloads on a page are isolated into
   `page.warnings` (`page.skipped`) so a single corrupt entry never stalls
   cursor advancement.

### 4. Demo dashboard (`demo`)

A dependency-free HTML/CSS/JS page that renders the committed deployment
manifest and links each lifecycle step to Stellar Expert. It is deliberately
read-only, so it can be hosted on GitHub Pages without a wallet connection or a
secret key. A real wallet demo is a scoped issue, not a hidden half-feature.

## Why Soroban and Stellar

- **SEP-41 assets** give the deposit a standard token interface instead of a
  bespoke balance ledger.
- **Soroban authorisation** lets the contract require the current owner's
  signature for transfers while keeping redemption permissionless.
- **Low, predictable fees** matter for a 2 XLM deposit; a deposit scheme cannot
  cost more to redeem than the deposit itself.
- **Stellar Expert** gives reviewers a public, independent audit trail for every
  transaction in the testnet evidence.

## Failure modes considered in the design

| Failure | Behaviour |
| --- | --- |
| Merchant suspended | `issue_claim` fails; existing claims remain transferable/redeemable |
| Station revoked | Already-attested returns remain valid; new attestations fail |
| Wrong serial scanned | `authorize_return` rejects with `SerialMismatch` |
| Double redemption | Second call fails with `ClaimNotReturnAuthorized` |
| Transfer after return | `transfer_claim` fails with `ClaimNotActive` |
| Re-entrant token | Claim is marked `Redeemed` before the transfer |
| Lost claim key | The deposit remains locked; expiry/forfeiture policy is future work |
| Storage expiry | Persistent entries are bumped on every read/write; a keeper is future work |

## Deliberate non-goals for v0

- Physical verification. The contract trusts a named station.
- Privacy. Claim ownership is public on-chain.
- Fiat off-ramping. The deposit is whatever SEP-41 asset the deployer chooses.
- Upgradability. There is no admin upgrade path in v0; a migration design must
  be reviewed before mainnet.
- Expiry forfeiture. `expires_at` is informational; the contract never seizes a
  deposit.

See [ROADMAP.md](ROADMAP.md) for the order in which these are planned.
