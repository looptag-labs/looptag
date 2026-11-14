#![no_std]

//! LOOPTAG — deposit-backed, transferable claims for reusable physical assets.
//!
//! A merchant locks a refundable deposit in this contract and receives a claim
//! identifier. The claim is owned by the customer and can be transferred like a
//! token. When the physical item is returned, an issuer-authorised return
//! station attests to the return; the contract then pays the deposit to the
//! *current* claim owner.
//!
//! The contract deliberately does not pretend to know whether a physical item
//! was returned. That fact is attested by an authorised station. See
//! `docs/TRUST_MODEL.md` for the full trust model.

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, String, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_LIFETIME: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_LIFETIME - DAY_IN_LEDGERS;
const CLAIM_LIFETIME: u32 = 180 * DAY_IN_LEDGERS;
const CLAIM_THRESHOLD: u32 = CLAIM_LIFETIME - DAY_IN_LEDGERS;

/// Upper bound on `get_claims` so a dashboard cannot ask for an unbounded
/// response and run into Soroban's read-entry or CPU limits.
pub const MAX_BATCH_SIZE: u32 = 50;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimStatus {
    /// Deposit is locked and the claim can still be transferred.
    Active = 0,
    /// A return station has attested the physical return. Transfers are frozen
    /// so the refund cannot be redirected after the item is back.
    ReturnAuthorized = 1,
    /// The deposit has been paid to the owner. The claim is a permanent audit
    /// record and can no longer be transferred or redeemed.
    Redeemed = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claim {
    pub id: u64,
    pub issuer: Address,
    pub owner: Address,
    /// SHA-256 of the physical item's serial number or tag identifier.
    pub serial_hash: BytesN<32>,
    /// Deposit amount in the smallest unit of the deposit token (stroops for
    /// XLM, 7 decimal places for Stellar assets).
    pub deposit: i128,
    pub issued_at: u64,
    /// Unix timestamp after which the item is considered overdue. `0` means no
    /// expiry. Expiry is informational in v0; see ROADMAP.md for forfeiture.
    pub expires_at: u64,
    pub status: ClaimStatus,
    pub return_station: Option<Address>,
    pub returned_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Merchant {
    pub address: Address,
    pub name: String,
    pub active: bool,
    pub issued: u64,
    pub redeemed: u64,
    /// Sum of deposits still locked for this issuer. This is the on-chain
    /// deposit liability and should always equal the sum of active claims.
    pub outstanding: i128,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Init {
    #[topic]
    pub admin: Address,
    pub deposit_token: Address,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantRegistered {
    #[topic]
    pub merchant: Address,
    pub name: String,
    pub active: bool,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantStatusChanged {
    #[topic]
    pub merchant: Address,
    pub name: String,
    pub active: bool,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StationChanged {
    #[topic]
    pub issuer: Address,
    pub station: Address,
    pub authorized: bool,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimIssued {
    #[topic]
    pub claim_id: u64,
    pub issuer: Address,
    pub owner: Address,
    pub deposit: i128,
    pub serial_hash: BytesN<32>,
    pub expires_at: u64,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimTransferred {
    #[topic]
    pub claim_id: u64,
    pub from: Address,
    pub to: Address,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReturnAuthorized {
    #[topic]
    pub claim_id: u64,
    pub station: Address,
    pub returned_at: u64,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRedeemed {
    #[topic]
    pub claim_id: u64,
    pub owner: Address,
    pub deposit: i128,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChanged {
    #[topic]
    pub admin: Address,
    pub paused: bool,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposed {
    #[topic]
    pub admin: Address,
    pub new_admin: Address,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferCancelled {
    #[topic]
    pub admin: Address,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    #[topic]
    pub old_admin: Address,
    pub new_admin: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Paused,
    DepositToken,
    ClaimCount,
    Claim(u64),
    /// `(issuer, serial_hash) -> claim_id` while a claim for the physical item
    /// is still active or awaiting redemption. Removed on redemption so the
    /// same tag can be reused after the deposit has gone back to the customer.
    Serial(Address, BytesN<32>),
    Merchant(Address),
    Station(Address, Address),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    MerchantExists = 3,
    MerchantNotFound = 4,
    MerchantInactive = 5,
    StationNotAuthorized = 6,
    ClaimNotFound = 7,
    ClaimNotActive = 8,
    ClaimNotReturnAuthorized = 9,
    NotClaimOwner = 10,
    SerialMismatch = 11,
    InvalidDeposit = 12,
    InvalidExpiry = 13,
    SameOwner = 14,
    Overflow = 15,
    NotAdmin = 16,
    SerialAlreadyActive = 17,
    ContractPaused = 18,
    UnexpectedTransferAmount = 19,
    BatchTooLarge = 20,
    NoPendingAdmin = 21,
    SameAdmin = 22,
}

#[contract]
pub struct Looptag;

#[contractimpl]
impl Looptag {
    /// One-time setup. `admin` manages the merchant allowlist; `deposit_token`
    /// is the SEP-41 asset used for every deposit in this deployment.
    pub fn initialize(env: Env, admin: Address, deposit_token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DepositToken, &deposit_token);
        env.storage().instance().set(&DataKey::ClaimCount, &0u64);
        bump_instance(&env);

        Init {
            admin,
            deposit_token,
        }
        .publish(&env);
        Ok(())
    }

    /// Pause or unpause the parts of the protocol that create or redirect
    /// exposure. Redemption deliberately stays available while paused so an
    /// emergency stop can never strand a returned item's deposit.
    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::Paused, &paused);
        bump_instance(&env);

        PauseChanged { admin, paused }.publish(&env);
        Ok(())
    }

    /// Start a two-step admin handover. The nominated address must call
    /// `accept_admin`, which prevents a typo from permanently losing control.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if admin == new_admin {
            return Err(Error::SameAdmin);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        bump_instance(&env);

        AdminTransferProposed { admin, new_admin }.publish(&env);
        Ok(())
    }

    /// Complete a pending admin handover. Only the nominated address can accept.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;
        if pending != new_admin {
            return Err(Error::NotAdmin);
        }
        new_admin.require_auth();

        let old_admin = load_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        bump_instance(&env);

        AdminChanged {
            old_admin,
            new_admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Cancel a pending handover. Useful when the nominated key is lost before
    /// it accepts or when the operator changes their mind.
    pub fn cancel_admin_transfer(env: Env, admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if !env.storage().instance().has(&DataKey::PendingAdmin) {
            return Err(Error::NoPendingAdmin);
        }

        env.storage().instance().remove(&DataKey::PendingAdmin);
        bump_instance(&env);

        AdminTransferCancelled { admin }.publish(&env);
        Ok(())
    }

    /// Register a merchant that is allowed to issue deposit claims.
    pub fn register_merchant(env: Env, merchant: Address, name: String) -> Result<(), Error> {
        let admin = load_admin(&env)?;
        admin.require_auth();
        require_not_paused(&env)?;

        let key = DataKey::Merchant(merchant.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::MerchantExists);
        }

        let record = Merchant {
            address: merchant.clone(),
            name: name.clone(),
            active: true,
            issued: 0,
            redeemed: 0,
            outstanding: 0,
        };
        env.storage().persistent().set(&key, &record);
        bump_persistent(&env, &key);

        MerchantRegistered {
            merchant,
            name,
            active: true,
        }
        .publish(&env);
        Ok(())
    }

    /// Suspend or re-enable a merchant. Existing claims stay redeemable:
    /// suspending an issuer must never strand a customer's deposit.
    pub fn set_merchant_active(env: Env, merchant: Address, active: bool) -> Result<(), Error> {
        let admin = load_admin(&env)?;
        admin.require_auth();

        let key = DataKey::Merchant(merchant.clone());
        let mut record = load_merchant(&env, &merchant)?;
        record.active = active;
        env.storage().persistent().set(&key, &record);
        bump_persistent(&env, &key);

        MerchantStatusChanged {
            merchant,
            name: record.name,
            active,
        }
        .publish(&env);
        Ok(())
    }

    /// Authorise a return station for a specific issuer. Stations are scoped to
    /// the issuer because the issuer is the party accepting the returned item.
    pub fn register_station(env: Env, issuer: Address, station: Address) -> Result<(), Error> {
        issuer.require_auth();
        require_not_paused(&env)?;
        let record = load_merchant(&env, &issuer)?;
        if !record.active {
            return Err(Error::MerchantInactive);
        }

        let key = DataKey::Station(issuer.clone(), station.clone());
        env.storage().persistent().set(&key, &true);
        bump_persistent(&env, &key);

        StationChanged {
            issuer,
            station,
            authorized: true,
        }
        .publish(&env);
        Ok(())
    }

    /// Revoke a return station. Already-attested returns remain valid.
    pub fn remove_station(env: Env, issuer: Address, station: Address) -> Result<(), Error> {
        issuer.require_auth();
        require_not_paused(&env)?;
        let key = DataKey::Station(issuer.clone(), station.clone());
        env.storage().persistent().remove(&key);

        StationChanged {
            issuer,
            station,
            authorized: false,
        }
        .publish(&env);
        Ok(())
    }

    /// Lock a deposit and mint a transferable claim to `owner`.
    pub fn issue_claim(
        env: Env,
        issuer: Address,
        owner: Address,
        serial_hash: BytesN<32>,
        deposit: i128,
        expires_at: u64,
    ) -> Result<u64, Error> {
        issuer.require_auth();
        require_not_paused(&env)?;

        if deposit <= 0 {
            return Err(Error::InvalidDeposit);
        }

        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            return Err(Error::InvalidExpiry);
        }

        let mut merchant = load_merchant(&env, &issuer)?;
        if !merchant.active {
            return Err(Error::MerchantInactive);
        }

        // A physical tag can only back one live claim per issuer. Check before
        // moving funds so a duplicate call cannot consume a claim id or deposit.
        let serial_key = DataKey::Serial(issuer.clone(), serial_hash.clone());
        if env.storage().persistent().has(&serial_key) {
            return Err(Error::SerialAlreadyActive);
        }

        let token = load_deposit_token(&env)?;
        transfer_exact(
            &env,
            &token,
            &issuer,
            &env.current_contract_address(),
            deposit,
        )?;

        let id = next_claim_id(&env)?;
        let claim = Claim {
            id,
            issuer: issuer.clone(),
            owner: owner.clone(),
            serial_hash: serial_hash.clone(),
            deposit,
            issued_at: now,
            expires_at,
            status: ClaimStatus::Active,
            return_station: None,
            returned_at: 0,
        };

        let claim_key = DataKey::Claim(id);
        env.storage().persistent().set(&claim_key, &claim);
        bump_persistent(&env, &claim_key);

        env.storage().persistent().set(&serial_key, &id);
        bump_persistent(&env, &serial_key);

        merchant.issued = merchant.issued.checked_add(1).ok_or(Error::Overflow)?;
        merchant.outstanding = merchant
            .outstanding
            .checked_add(deposit)
            .ok_or(Error::Overflow)?;
        let merchant_key = DataKey::Merchant(issuer.clone());
        env.storage().persistent().set(&merchant_key, &merchant);
        bump_persistent(&env, &merchant_key);

        ClaimIssued {
            claim_id: id,
            issuer,
            owner,
            deposit,
            serial_hash,
            expires_at,
        }
        .publish(&env);
        Ok(id)
    }

    /// Transfer the deposit entitlement to another wallet. Only the current
    /// owner can transfer, and only while the claim is active.
    pub fn transfer_claim(
        env: Env,
        claim_id: u64,
        from: Address,
        to: Address,
    ) -> Result<(), Error> {
        from.require_auth();
        require_not_paused(&env)?;

        let key = DataKey::Claim(claim_id);
        let mut claim = load_claim(&env, claim_id)?;
        if !matches!(claim.status, ClaimStatus::Active) {
            return Err(Error::ClaimNotActive);
        }
        if claim.owner != from {
            return Err(Error::NotClaimOwner);
        }
        if from == to {
            return Err(Error::SameOwner);
        }

        claim.owner = to.clone();
        env.storage().persistent().set(&key, &claim);
        bump_persistent(&env, &key);

        ClaimTransferred { claim_id, from, to }.publish(&env);
        Ok(())
    }

    /// Attest that the physical item was returned. The station must be
    /// authorised by the issuer, and the serial hash must match the claim so a
    /// QR code from a different item cannot close this claim.
    pub fn authorize_return(
        env: Env,
        claim_id: u64,
        station: Address,
        serial_hash: BytesN<32>,
    ) -> Result<(), Error> {
        station.require_auth();
        require_not_paused(&env)?;

        let key = DataKey::Claim(claim_id);
        let mut claim = load_claim(&env, claim_id)?;
        if !matches!(claim.status, ClaimStatus::Active) {
            return Err(Error::ClaimNotActive);
        }
        if claim.serial_hash != serial_hash {
            return Err(Error::SerialMismatch);
        }
        if !is_station(&env, &claim.issuer, &station) {
            return Err(Error::StationNotAuthorized);
        }

        claim.status = ClaimStatus::ReturnAuthorized;
        claim.return_station = Some(station.clone());
        claim.returned_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &claim);
        bump_persistent(&env, &key);

        ReturnAuthorized {
            claim_id,
            station,
            returned_at: claim.returned_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Pay the deposit to the current owner. Permissionless: once a return has
    /// been attested, anyone may trigger the refund, but the funds can only go
    /// to the wallet that owns the claim at that moment.
    pub fn redeem(env: Env, claim_id: u64) -> Result<(), Error> {
        let key = DataKey::Claim(claim_id);
        let mut claim = load_claim(&env, claim_id)?;
        if !matches!(claim.status, ClaimStatus::ReturnAuthorized) {
            return Err(Error::ClaimNotReturnAuthorized);
        }

        // Checks-effects-interactions: freeze the claim and release the serial
        // index before moving funds so a re-entrant call cannot redeem twice.
        // Soroban rolls the whole invocation back if the transfer check fails.
        claim.status = ClaimStatus::Redeemed;
        env.storage().persistent().set(&key, &claim);
        bump_persistent(&env, &key);

        let serial_key = DataKey::Serial(claim.issuer.clone(), claim.serial_hash.clone());
        env.storage().persistent().remove(&serial_key);

        let token = load_deposit_token(&env)?;
        transfer_exact(
            &env,
            &token,
            &env.current_contract_address(),
            &claim.owner,
            claim.deposit,
        )?;

        let mut merchant = load_merchant(&env, &claim.issuer)?;
        merchant.outstanding = merchant
            .outstanding
            .checked_sub(claim.deposit)
            .ok_or(Error::Overflow)?;
        merchant.redeemed = merchant.redeemed.checked_add(1).ok_or(Error::Overflow)?;
        let merchant_key = DataKey::Merchant(claim.issuer.clone());
        env.storage().persistent().set(&merchant_key, &merchant);
        bump_persistent(&env, &merchant_key);

        ClaimRedeemed {
            claim_id,
            owner: claim.owner,
            deposit: claim.deposit,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------------------------
    // Read-only views
    // ---------------------------------------------------------------------

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        load_admin(&env)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn get_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn get_deposit_token(env: Env) -> Result<Address, Error> {
        load_deposit_token(&env)
    }

    pub fn get_claim_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ClaimCount)
            .unwrap_or(0)
    }

    pub fn get_claim(env: Env, claim_id: u64) -> Result<Claim, Error> {
        let key = DataKey::Claim(claim_id);
        let claim = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ClaimNotFound)?;
        bump_persistent(&env, &key);
        Ok(claim)
    }

    /// Read a bounded list of claims in one call. The limit protects the
    /// contract from unbounded return values and makes dashboard pagination
    /// predictable.
    pub fn get_claims(env: Env, claim_ids: Vec<u64>) -> Result<Vec<Claim>, Error> {
        if claim_ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        let mut claims = Vec::new(&env);
        for claim_id in claim_ids.iter() {
            claims.push_back(load_claim(&env, claim_id)?);
        }
        Ok(claims)
    }

    /// Return the live claim id for an `(issuer, serial_hash)` pair, if any.
    /// This is the same index used to reject duplicate active tags.
    pub fn get_serial_claim(env: Env, issuer: Address, serial_hash: BytesN<32>) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::Serial(issuer, serial_hash))
    }

    pub fn get_merchant(env: Env, merchant: Address) -> Result<Merchant, Error> {
        load_merchant(&env, &merchant)
    }

    pub fn get_outstanding_liability(env: Env, issuer: Address) -> Result<i128, Error> {
        Ok(load_merchant(&env, &issuer)?.outstanding)
    }

    pub fn is_station(env: Env, issuer: Address, station: Address) -> bool {
        is_station(&env, &issuer, &station)
    }
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
    let stored = load_admin(env)?;
    if &stored != admin {
        return Err(Error::NotAdmin);
    }
    admin.require_auth();
    Ok(())
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if is_paused(env) {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

/// Transfer exactly `amount` and reject tokens that burn, withhold, or mint a
/// fee on the way. Soroban reverts the whole invocation if this returns an
/// error, so a non-standard token cannot leave a partially funded claim.
fn transfer_exact(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<(), Error> {
    if from == to {
        return Err(Error::UnexpectedTransferAmount);
    }

    let client = token::Client::new(env, token);
    let from_before = client.balance(from);
    let to_before = client.balance(to);

    client.transfer(from, to, &amount);

    let from_after = client.balance(from);
    let to_after = client.balance(to);

    let from_delta = from_before.checked_sub(from_after).ok_or(Error::Overflow)?;
    let to_delta = to_after.checked_sub(to_before).ok_or(Error::Overflow)?;

    if from_delta != amount || to_delta != amount {
        return Err(Error::UnexpectedTransferAmount);
    }
    Ok(())
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_LIFETIME);
}

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, CLAIM_THRESHOLD, CLAIM_LIFETIME);
}

fn load_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn load_deposit_token(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::DepositToken)
        .ok_or(Error::NotInitialized)
}

fn load_claim(env: &Env, claim_id: u64) -> Result<Claim, Error> {
    let key = DataKey::Claim(claim_id);
    let claim = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::ClaimNotFound)?;
    bump_persistent(env, &key);
    Ok(claim)
}

fn load_merchant(env: &Env, merchant: &Address) -> Result<Merchant, Error> {
    let key = DataKey::Merchant(merchant.clone());
    let record = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::MerchantNotFound)?;
    bump_persistent(env, &key);
    Ok(record)
}

fn is_station(env: &Env, issuer: &Address, station: &Address) -> bool {
    let key = DataKey::Station(issuer.clone(), station.clone());
    env.storage().persistent().has(&key)
}

fn next_claim_id(env: &Env) -> Result<u64, Error> {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ClaimCount)
        .unwrap_or(0);
    let next = current.checked_add(1).ok_or(Error::Overflow)?;
    env.storage().instance().set(&DataKey::ClaimCount, &next);
    bump_instance(env);
    Ok(next)
}

#[cfg(test)]
mod test;
