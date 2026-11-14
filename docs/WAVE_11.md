# Wave 11 maintainer checklist

**Deadline: Monday, 9 November 2026 at 23:59 UTC.** New repository submissions
and suspension appeals must be in by then. Do not wait until the last hour: the
Drips app sync and GitHub App installation are manual steps.

This page is the practical handoff for publishing LOOPTAG and applying as a
maintainer. It is not a substitute for the official Drips terms.

Official references:

- [Drips Wave terms and rules](https://docs.drips.network/wave/terms-and-rules#31-maintainers)
- [Drips maintainer onboarding](https://docs.drips.network/wave/maintainers)

## Current state

- [x] Public-ready repository content (contract, SDK, docs, demo, CI).
- [x] Soroban contract deployed on testnet with a full lifecycle.
- [x] 26 Rust tests (including a proptest model) and 33 TypeScript tests passing.
- [x] 22 scoped issues drafted in [`scripts/issues.json`](../scripts/issues.json).
- [x] Labels and idempotent issue-creation script prepared.
- [ ] GitHub repository created and pushed.
- [ ] Drips Wave GitHub App installed and repo synced.
- [ ] Application submitted to the Stellar Wave Program.
- [ ] Maintainer access / approval confirmed.

## 1. Rotate the exposed GitHub token first

A GitHub token was pasted into chat during setup. Treat it as compromised even
if it appears to work. Revoke it at
<https://github.com/settings/tokens>, then authenticate locally:

```bash
gh auth login
gh auth status
```

Never commit a token, a `.env` file, or Stellar secret keys. The repository's
hygiene check is a safety net, not permission to be careless.

## 2. Create and push the repository

Fast path under the personal account:

```bash
cd /home/obx/looptag
git init -b main
git add .
git status                 # confirm no .env, target/, node_modules/, dist/
git commit -m "feat: LOOPTAG v0 — deposit-backed claims on Stellar"
gh repo create looptag-labs/looptag \
  --public \
  --source . \
  --remote origin \
  --push \
  --description "Deposit-backed, transferable claims for reusable physical assets on Stellar (Soroban)."
gh repo edit looptag-labs/looptag \
  --add-topic stellar,soroban,blockchain,circular-economy,defi,typescript,rust
```

Then open `https://github.com/looptag-labs/looptag` and confirm:

- The README renders and the CI badge appears.
- Actions → CI runs green.
- Settings → General → Features: Issues enabled.
- Settings → Security: private vulnerability reporting enabled if available.
- The license is detected as MIT.

You can transfer the repository to a new organization later
(Settings → General → Danger Zone → Transfer). Creating an organization cannot
be done through the REST API; use the GitHub UI first if you want an org name.

## 3. Create labels and issues

The repository must be public before the Drips app can see it. Issues can be
created before or after approval, but they need the `Stellar Wave` label and a
complexity for the dashboard.

With `gh` authenticated:

```bash
cd /home/obx/looptag
GITHUB_REPOSITORY=looptag-labs/looptag \
GH_TOKEN="$(gh auth token)" \
node scripts/seed-github.mjs
```

The script is idempotent:

- Creates the labels if they do not exist.
- Skips issues whose title already exists.
- Adds `Stellar Wave` and `help wanted` to every issue.
- Does not update existing issue bodies; edit those on GitHub if needed.

Expected result: **22 open issues**, including **4 `good first issue`** tasks.

## 4. Install the Drips Wave GitHub App

In the Drips app/dashboard:

1. Install the **Drips Wave GitHub App** on the `looptag-labs` organization (or the
   organization that owns the repo.
2. Grant access to `looptag` only (least privilege).
3. Sync the repository from the Drips dashboard.
4. Confirm the repo appears as public and eligible.

If the app cannot see the repo, check GitHub → Settings → Applications →
Installed GitHub Apps → Drips Wave → Repository access. Organization owners may
need to approve the installation.

## 5. Apply to the Stellar Wave Program

1. Open the Wave Program application in the Drips dashboard.
2. Select the Stellar Wave program and the `looptag-labs/looptag` repository.
3. Use the README and the testnet evidence as the project description.
4. Submit before **9 November 2026, 23:59 UTC**.
5. Wait for approval. Do not add fake issues or duplicate repos to increase the
   chance of approval; the terms prohibit low-effort and bad-faith submissions.

After approval, add the issues to the Wave board if the dashboard does not do it
automatically:

- Filter by `Stellar Wave`.
- Set complexity per issue: **Trivial 100**, **Medium 150**, **High 200**.
- Keep the issue descriptions and acceptance criteria as written.

## 6. Apply as a maintainer

The maintainer application uses the same repository. Before submitting, make
sure:

- The repo is public, has a license, and is synced by the Drips app.
- The README explains what is live, what is simulated, and how to verify it.
- Issues are real, scoped, and independently reviewable.
- You can review PRs and respond to contributors during the Wave.
- There is at least one `good first issue` and a spread of complexity.

Submit the maintainer application from the Drips dashboard and complete any
GitHub verification it asks for. Approval is at Drips' discretion; this checklist
only removes avoidable blockers.

## Issue backlog at a glance

| # | Issue | Area | Complexity |
| --- | --- | --- | --- |
| 1 | Reject duplicate active serial hashes per issuer | contract / security | medium |
| 2 | Guard against fee-on-transfer SEP-41 tokens | contract / security | high |
| 3 | Add an admin pause that never blocks redemption | contract / security | high |
| 4 | Add two-step admin rotation | contract | medium |
| 5 | Multi-merchant and station-revocation integration tests | contract / test | medium |
| 6 | Property-test the deposit accounting invariant | contract / test | high |
| 7 | Transaction helpers for issue/transfer/return/redeem | sdk | high |
| 8 | Event poller with cursor and ledger ranges | sdk | high |
| 9 | Account and network validation helpers | sdk / good first | trivial |
| 10 | Reject ambiguous numeric amounts | sdk / good first | trivial |
| 11 | QR payload builder from an on-chain claim | sdk | medium |
| 12 | Minimal read-only indexer and REST API | indexer | high |
| 13 | Wallet-connected transfer and redeem flow | demo | high |
| 14 | Station return scanner | demo | high |
| 15 | Merchant liability dashboard and CSV export | demo | medium |
| 16 | Live RPC state with staleness indicator | demo | medium |
| 17 | WASM size budget and manifest hash check | ci | medium |
| 18 | Glossary and first-hour walkthrough | docs / good first | trivial |
| 19 | Pilot merchant runbook and incident checklist | docs | medium |
| 20 | Contract API reference and event catalog | docs | medium |
| 21 | Tests for explorer helpers and merchant events | sdk / good first | trivial |
| 22 | Bounded batch claim view | contract | medium |

Counts: 22 issues, 4 good first, 8 high priority, 8 high complexity, 4 trivial.

## What to say in the application

Short version:

> LOOPTAG is a Stellar/Soroban protocol for reusable packaging deposits. A
> merchant locks a SEP-41 deposit and issues a transferable claim; a return
> station attests the physical return with a serial-hash check; anyone can then
> trigger redemption to the current owner. v0 is live on testnet with a full
> issue → transfer → return → redeem trail, 26 Rust tests (including a
> proptest model), 33 SDK tests, CI, and 22 scoped issues across the contract,
> SDK, indexer, demo, and docs.

Do not claim an audit, mainnet readiness, or a trustless physical-return proof.
The honest scope is stronger than an inflated one.

## Final pre-submit check

- [ ] Token revoked/rotated; no secret in git history.
- [ ] `pnpm check:all` passes locally.
- [ ] `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` pass.
- [ ] CI is green on `main`.
- [ ] 22 issues exist with `Stellar Wave`, complexity, and acceptance criteria.
- [ ] Drips Wave GitHub App can see the repo.
- [ ] Application submitted before the deadline.
- [ ] Maintainer application submitted.
