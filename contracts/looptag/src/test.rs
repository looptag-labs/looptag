use crate::{ClaimStatus, Error, Looptag, LooptagClient};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String, Vec,
};

/// Minimal SEP-41-shaped token used to prove that fee-on-transfer tokens are
/// rejected atomically instead of creating an under-collateralised claim.
mod fee_token {
    use super::*;

    #[contracttype]
    enum Key {
        Balance(Address),
        FeeBps,
    }

    #[contract]
    pub struct FeeToken;

    #[contractimpl]
    impl FeeToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let key = Key::Balance(to);
            let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(balance + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&Key::Balance(id))
                .unwrap_or(0)
        }

        pub fn set_fee_bps(env: Env, fee_bps: u32) {
            env.storage().persistent().set(&Key::FeeBps, &fee_bps);
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();

            let fee_bps: u32 = env.storage().persistent().get(&Key::FeeBps).unwrap_or(0);
            let fee = amount * i128::from(fee_bps) / 10_000;
            let from_key = Key::Balance(from);
            let to_key = Key::Balance(to);
            let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);

            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            env.storage()
                .persistent()
                .set(&to_key, &(to_balance + amount - fee));
        }
    }
}

struct Fixture {
    env: Env,
    contract_id: Address,
    admin: Address,
    issuer: Address,
    station: Address,
    customer: Address,
    token: Address,
}

impl Fixture {
    fn client(&self) -> LooptagClient<'_> {
        LooptagClient::new(&self.env, &self.contract_id)
    }

    fn serial(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &[7u8; 32])
    }

    fn serial_with(&self, byte: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[byte; 32])
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn issue(&self, owner: &Address, deposit: i128) -> u64 {
        self.issue_with_serial(owner, deposit, &self.serial())
    }

    fn issue_with_serial(&self, owner: &Address, deposit: i128, serial: &BytesN<32>) -> u64 {
        self.client()
            .issue_claim(&self.issuer, owner, serial, &deposit, &0)
    }
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let station = Address::generate(&env);
    let customer = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();

    let contract_id = env.register(Looptag, ());
    let client = LooptagClient::new(&env, &contract_id);

    client.initialize(&admin, &token);
    client.register_merchant(&issuer, &String::from_str(&env, "Circular Cafe"));
    client.register_station(&issuer, &station);

    StellarAssetClient::new(&env, &token).mint(&issuer, &10_000);

    Fixture {
        env,
        contract_id,
        admin,
        issuer,
        station,
        customer,
        token,
    }
}

#[test]
fn issue_transfer_return_and_redeem_pays_current_owner() {
    let f = setup();
    let client = f.client();
    let friend = Address::generate(&f.env);

    let id = f.issue(&f.customer, 200);
    assert_eq!(id, 1);
    assert_eq!(client.get_claim_count(), 1);

    // The deposit moved from the issuer to the contract; the customer holds a
    // claim, not the funds.
    assert_eq!(f.balance(&f.issuer), 9_800);
    assert_eq!(f.balance(&f.customer), 0);
    assert_eq!(f.balance(&f.contract_id), 200);
    assert_eq!(client.get_outstanding_liability(&f.issuer), 200);

    let claim = client.get_claim(&id);
    assert_eq!(claim.owner, f.customer);
    assert_eq!(claim.status, ClaimStatus::Active);
    assert_eq!(claim.deposit, 200);
    assert_eq!(claim.serial_hash, f.serial());

    // The claim, and therefore the refund entitlement, follows the item.
    client.transfer_claim(&id, &f.customer, &friend);
    assert_eq!(client.get_claim(&id).owner, friend);
    assert_eq!(f.balance(&friend), 0);

    // An authorised station attests the physical return.
    client.authorize_return(&id, &f.station, &f.serial());
    let returned = client.get_claim(&id);
    assert_eq!(returned.status, ClaimStatus::ReturnAuthorized);
    assert_eq!(returned.return_station, Some(f.station.clone()));
    assert_eq!(returned.returned_at, 1_700_000_000);

    // Redemption is permissionless, but the refund goes to the current owner.
    client.redeem(&id);
    assert_eq!(f.balance(&friend), 200);
    assert_eq!(f.balance(&f.contract_id), 0);
    assert_eq!(client.get_outstanding_liability(&f.issuer), 0);

    let redeemed = client.get_claim(&id);
    assert_eq!(redeemed.status, ClaimStatus::Redeemed);

    let merchant = client.get_merchant(&f.issuer);
    assert_eq!(merchant.issued, 1);
    assert_eq!(merchant.redeemed, 1);
    assert_eq!(merchant.outstanding, 0);
}

#[test]
fn unauthorised_station_cannot_authorise_return() {
    let f = setup();
    let rogue = Address::generate(&f.env);
    let id = f.issue(&f.customer, 200);

    let result = f.client().try_authorize_return(&id, &rogue, &f.serial());
    assert_eq!(result, Err(Ok(Error::StationNotAuthorized)));
    assert_eq!(f.client().get_claim(&id).status, ClaimStatus::Active);
}

#[test]
fn revoked_station_cannot_authorise_return() {
    let f = setup();
    let id = f.issue(&f.customer, 200);

    f.client().remove_station(&f.issuer, &f.station);
    let result = f
        .client()
        .try_authorize_return(&id, &f.station, &f.serial());
    assert_eq!(result, Err(Ok(Error::StationNotAuthorized)));
}

#[test]
fn serial_mismatch_cannot_close_a_claim() {
    let f = setup();
    let id = f.issue(&f.customer, 200);
    let wrong = BytesN::from_array(&f.env, &[9u8; 32]);

    let result = f.client().try_authorize_return(&id, &f.station, &wrong);
    assert_eq!(result, Err(Ok(Error::SerialMismatch)));
}

#[test]
fn transfer_is_frozen_after_return_attestation() {
    let f = setup();
    let id = f.issue(&f.customer, 200);
    let other = Address::generate(&f.env);

    f.client().authorize_return(&id, &f.station, &f.serial());
    let result = f.client().try_transfer_claim(&id, &f.customer, &other);
    assert_eq!(result, Err(Ok(Error::ClaimNotActive)));
    assert_eq!(f.client().get_claim(&id).owner, f.customer);
}

#[test]
fn double_redeem_is_rejected() {
    let f = setup();
    let id = f.issue(&f.customer, 200);

    f.client().authorize_return(&id, &f.station, &f.serial());
    f.client().redeem(&id);
    let result = f.client().try_redeem(&id);
    assert_eq!(result, Err(Ok(Error::ClaimNotReturnAuthorized)));

    assert_eq!(f.balance(&f.customer), 200);
    assert_eq!(f.balance(&f.contract_id), 0);
}

#[test]
fn redeem_before_return_is_rejected() {
    let f = setup();
    let id = f.issue(&f.customer, 200);

    let result = f.client().try_redeem(&id);
    assert_eq!(result, Err(Ok(Error::ClaimNotReturnAuthorized)));
    assert_eq!(f.balance(&f.contract_id), 200);
}

#[test]
fn only_the_current_owner_can_transfer() {
    let f = setup();
    let id = f.issue(&f.customer, 200);
    let stranger = Address::generate(&f.env);

    let result = f.client().try_transfer_claim(&id, &stranger, &f.customer);
    assert_eq!(result, Err(Ok(Error::NotClaimOwner)));
    assert_eq!(f.client().get_claim(&id).owner, f.customer);
}

#[test]
fn merchant_suspension_blocks_new_claims_but_not_existing_refunds() {
    let f = setup();
    let id = f.issue(&f.customer, 200);

    f.client().set_merchant_active(&f.issuer, &false);
    let blocked = f
        .client()
        .try_issue_claim(&f.issuer, &f.customer, &f.serial(), &100, &0);
    assert_eq!(blocked, Err(Ok(Error::MerchantInactive)));

    // Suspension must not strand an existing deposit.
    f.client().authorize_return(&id, &f.station, &f.serial());
    f.client().redeem(&id);
    assert_eq!(f.balance(&f.customer), 200);
}

#[test]
fn unregistered_merchant_cannot_issue() {
    let f = setup();
    let stranger = Address::generate(&f.env);

    let result = f
        .client()
        .try_issue_claim(&stranger, &f.customer, &f.serial(), &100, &0);
    assert_eq!(result, Err(Ok(Error::MerchantNotFound)));
}

#[test]
fn zero_and_negative_deposits_are_rejected() {
    let f = setup();
    let client = f.client();

    assert_eq!(
        client.try_issue_claim(&f.issuer, &f.customer, &f.serial(), &0, &0),
        Err(Ok(Error::InvalidDeposit))
    );
    assert_eq!(
        client.try_issue_claim(&f.issuer, &f.customer, &f.serial(), &-1, &0),
        Err(Ok(Error::InvalidDeposit))
    );
}

#[test]
fn expiry_in_the_past_is_rejected() {
    let f = setup();
    let past = 1_699_999_999;

    let result = f
        .client()
        .try_issue_claim(&f.issuer, &f.customer, &f.serial(), &100, &past);
    assert_eq!(result, Err(Ok(Error::InvalidExpiry)));
}

#[test]
fn outstanding_liability_tracks_multiple_claims() {
    let f = setup();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);

    let serial_c = f.serial_with(3);
    f.issue_with_serial(&f.customer, 200, &f.serial_with(1));
    f.issue_with_serial(&a, 350, &f.serial_with(2));
    let id_c = f.issue_with_serial(&b, 50, &serial_c);

    assert_eq!(f.client().get_claim_count(), 3);
    assert_eq!(f.client().get_outstanding_liability(&f.issuer), 600);
    assert_eq!(f.balance(&f.contract_id), 600);

    f.client().authorize_return(&id_c, &f.station, &serial_c);
    f.client().redeem(&id_c);

    assert_eq!(f.client().get_outstanding_liability(&f.issuer), 550);
    assert_eq!(f.balance(&f.contract_id), 550);
    assert_eq!(f.balance(&b), 50);
}

#[test]
fn uninitialised_contract_rejects_reads_and_writes() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(Looptag, ());
    let client = LooptagClient::new(&env, &contract_id);
    let who = Address::generate(&env);

    assert_eq!(client.try_get_admin(), Err(Ok(Error::NotInitialized)));
    assert_eq!(
        client.try_register_merchant(&who, &String::from_str(&env, "x")),
        Err(Ok(Error::NotInitialized))
    );
}

#[test]
fn admin_and_token_are_exposed_for_indexers() {
    let f = setup();
    assert_eq!(f.client().get_admin(), f.admin);
    assert_eq!(f.client().get_deposit_token(), f.token);
}

#[test]
fn duplicate_active_serial_is_rejected_without_moving_funds() {
    let f = setup();
    let client = f.client();
    let serial = f.serial();

    let id = f.issue_with_serial(&f.customer, 200, &serial);
    let issuer_balance = f.balance(&f.issuer);
    let contract_balance = f.balance(&f.contract_id);

    let result = client.try_issue_claim(&f.issuer, &f.customer, &serial, &100, &0);
    assert_eq!(result, Err(Ok(Error::SerialAlreadyActive)));
    assert_eq!(f.balance(&f.issuer), issuer_balance);
    assert_eq!(f.balance(&f.contract_id), contract_balance);
    assert_eq!(client.get_claim_count(), 1);
    assert_eq!(client.get_serial_claim(&f.issuer, &serial), Some(id));
}

#[test]
fn different_issuers_can_use_the_same_serial_hash() {
    let f = setup();
    let other_issuer = Address::generate(&f.env);

    f.client()
        .register_merchant(&other_issuer, &String::from_str(&f.env, "Second Cafe"));
    StellarAssetClient::new(&f.env, &f.token).mint(&other_issuer, &1_000);

    let first = f.issue_with_serial(&f.customer, 200, &f.serial());
    let second = f
        .client()
        .issue_claim(&other_issuer, &f.customer, &f.serial(), &100, &0);

    assert_eq!(first, 1);
    assert_eq!(second, 2);
    assert_eq!(
        f.client().get_serial_claim(&f.issuer, &f.serial()),
        Some(first)
    );
    assert_eq!(
        f.client().get_serial_claim(&other_issuer, &f.serial()),
        Some(second)
    );
}

#[test]
fn serial_index_survives_transfer_and_is_released_on_redeem() {
    let f = setup();
    let client = f.client();
    let serial = f.serial();
    let friend = Address::generate(&f.env);

    let id = f.issue_with_serial(&f.customer, 200, &serial);
    client.transfer_claim(&id, &f.customer, &friend);
    assert_eq!(client.get_serial_claim(&f.issuer, &serial), Some(id));

    client.authorize_return(&id, &f.station, &serial);
    client.redeem(&id);
    assert_eq!(client.get_serial_claim(&f.issuer, &serial), None);

    // Once the deposit has been paid out, the tag can back a new claim.
    let reissued = f.issue_with_serial(&f.customer, 100, &serial);
    assert_eq!(reissued, id + 1);
    assert_eq!(client.get_serial_claim(&f.issuer, &serial), Some(reissued));
}

#[test]
fn pause_blocks_new_exposure_but_never_redemption() {
    let f = setup();
    let client = f.client();
    let other = Address::generate(&f.env);
    let id = f.issue(&f.customer, 200);

    // Attest the return while the protocol is still open, then pause.
    client.authorize_return(&id, &f.station, &f.serial());
    client.set_paused(&f.admin, &true);
    assert!(client.get_paused());

    assert_eq!(
        client.try_issue_claim(&f.issuer, &f.customer, &f.serial_with(8), &100, &0),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_transfer_claim(&id, &f.customer, &other),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_authorize_return(&id, &f.station, &f.serial()),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_register_station(&f.issuer, &other),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_remove_station(&f.issuer, &f.station),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_register_merchant(&other, &String::from_str(&f.env, "Paused Cafe")),
        Err(Ok(Error::ContractPaused))
    );

    // Redemption is still permissionless and pays the owner.
    client.redeem(&id);
    assert_eq!(f.balance(&f.customer), 200);
    assert_eq!(client.get_claim(&id).status, ClaimStatus::Redeemed);

    client.set_paused(&f.admin, &false);
    assert!(!client.get_paused());
    assert!(client
        .try_issue_claim(&f.issuer, &f.customer, &f.serial_with(9), &100, &0)
        .is_ok());
}

#[test]
fn only_the_stored_admin_can_pause_or_start_a_handover() {
    let f = setup();
    let rogue = Address::generate(&f.env);
    let client = f.client();

    assert_eq!(
        client.try_set_paused(&rogue, &true),
        Err(Ok(Error::NotAdmin))
    );
    assert_eq!(
        client.try_propose_admin(&rogue, &rogue),
        Err(Ok(Error::NotAdmin))
    );
}

#[test]
fn admin_handover_requires_the_nominated_key_to_accept() {
    let f = setup();
    let client = f.client();
    let new_admin = Address::generate(&f.env);
    let stranger = Address::generate(&f.env);

    assert_eq!(
        client.try_accept_admin(&new_admin),
        Err(Ok(Error::NoPendingAdmin))
    );

    client.propose_admin(&f.admin, &new_admin);
    assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));

    assert_eq!(client.try_accept_admin(&stranger), Err(Ok(Error::NotAdmin)));
    client.accept_admin(&new_admin);

    assert_eq!(client.get_admin(), new_admin);
    assert_eq!(client.get_pending_admin(), None);
    assert_eq!(
        client.try_set_paused(&f.admin, &true),
        Err(Ok(Error::NotAdmin))
    );
    client.set_paused(&new_admin, &true);
    assert!(client.get_paused());
}

#[test]
fn pending_admin_handover_can_be_cancelled() {
    let f = setup();
    let client = f.client();
    let new_admin = Address::generate(&f.env);

    assert_eq!(
        client.try_cancel_admin_transfer(&f.admin),
        Err(Ok(Error::NoPendingAdmin))
    );
    client.propose_admin(&f.admin, &new_admin);
    client.cancel_admin_transfer(&f.admin);

    assert_eq!(client.get_pending_admin(), None);
    assert_eq!(client.get_admin(), f.admin);
}

#[test]
fn station_allowlist_is_scoped_to_the_issuer() {
    let f = setup();
    let other_issuer = Address::generate(&f.env);
    f.client()
        .register_merchant(&other_issuer, &String::from_str(&f.env, "Other Cafe"));
    StellarAssetClient::new(&f.env, &f.token).mint(&other_issuer, &1_000);

    let id = f
        .client()
        .issue_claim(&other_issuer, &f.customer, &f.serial(), &100, &0);

    // The first issuer's station is not automatically trusted by the second.
    assert_eq!(
        f.client()
            .try_authorize_return(&id, &f.station, &f.serial()),
        Err(Ok(Error::StationNotAuthorized))
    );
}

#[test]
fn bounded_batch_view_returns_claims_and_rejects_large_requests() {
    let f = setup();
    let client = f.client();
    let serial_a = f.serial_with(1);
    let serial_b = f.serial_with(2);
    let id_a = f.issue_with_serial(&f.customer, 100, &serial_a);
    let id_b = f.issue_with_serial(&f.customer, 250, &serial_b);

    let claims = client.get_claims(&soroban_sdk::vec![&f.env, id_a, id_b]);
    assert_eq!(claims.len(), 2);
    assert_eq!(claims.get(0).unwrap().deposit, 100);
    assert_eq!(claims.get(1).unwrap().deposit, 250);

    let mut too_many = Vec::new(&f.env);
    for i in 0..=crate::MAX_BATCH_SIZE {
        too_many.push_back(u64::from(i));
    }
    assert_eq!(
        client.try_get_claims(&too_many),
        Err(Ok(Error::BatchTooLarge))
    );

    assert_eq!(
        client.try_get_claims(&soroban_sdk::vec![&f.env, 999u64]),
        Err(Ok(Error::ClaimNotFound))
    );
}

#[test]
fn fee_on_transfer_token_is_rejected_atomically_on_issue_and_redeem() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let station = Address::generate(&env);
    let customer = Address::generate(&env);
    let serial = BytesN::from_array(&env, &[42u8; 32]);

    let token = env.register(fee_token::FeeToken, ());
    let fee_client = fee_token::FeeTokenClient::new(&env, &token);
    fee_client.mint(&issuer, &10_000);

    let contract_id = env.register(Looptag, ());
    let client = LooptagClient::new(&env, &contract_id);
    client.initialize(&admin, &token);
    client.register_merchant(&issuer, &String::from_str(&env, "Fee Cafe"));
    client.register_station(&issuer, &station);

    // A fee that withholds part of the deposit leaves the claim under-funded,
    // so issuance must fail and the token movement must roll back.
    fee_client.set_fee_bps(&1_000);
    assert_eq!(
        client.try_issue_claim(&issuer, &customer, &serial, &200, &0),
        Err(Ok(Error::UnexpectedTransferAmount))
    );
    assert_eq!(client.get_claim_count(), 0);
    assert_eq!(fee_client.balance(&issuer), 10_000);
    assert_eq!(fee_client.balance(&contract_id), 0);

    // Issue cleanly, then turn on the fee before redemption. The failed redeem
    // must leave the claim return-authorized and the deposit in the contract.
    fee_client.set_fee_bps(&0);
    let id = client.issue_claim(&issuer, &customer, &serial, &200, &0);
    client.authorize_return(&id, &station, &serial);

    fee_client.set_fee_bps(&1_000);
    assert_eq!(
        client.try_redeem(&id),
        Err(Ok(Error::UnexpectedTransferAmount))
    );
    assert_eq!(client.get_claim(&id).status, ClaimStatus::ReturnAuthorized);
    assert_eq!(fee_client.balance(&contract_id), 200);

    fee_client.set_fee_bps(&0);
    client.redeem(&id);
    assert_eq!(fee_client.balance(&customer), 200);
    assert_eq!(client.get_claim(&id).status, ClaimStatus::Redeemed);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModelStatus {
    Active,
    ReturnAuthorized,
    Redeemed,
}

#[derive(Clone, Copy, Debug)]
struct ModelClaim {
    owner: usize,
    deposit: i128,
    serial: u8,
    status: ModelStatus,
}

/// Randomized model check for the invariant that the contract's token balance
/// and each merchant's `outstanding` counter always equal the sum of deposits
/// that have not been redeemed. Proptest also shrinks a failing byte sequence to
/// the shortest operation sequence that still breaks the invariant.
fn run_invariant_sequence(ops: &[u8]) {
    let f = setup();
    let client = f.client();

    let owners = std::vec![
        f.customer.clone(),
        Address::generate(&f.env),
        Address::generate(&f.env)
    ];

    let mut claims: std::vec::Vec<ModelClaim> = std::vec::Vec::new();
    let mut outstanding: i128 = 0;
    let mut total_issued: i128 = 0;

    for &byte in ops {
        let op = byte % 6;
        let idx = (usize::from(byte) / 6) % 8;
        let owner_idx = (usize::from(byte) / 48) % owners.len();
        let deposit = 1 + i128::from(byte % 100);

        match op {
            0 => {
                // Issue a new claim with a fresh serial.
                if claims.len() < 8 {
                    let serial_byte = (claims.len() as u8) + 1;
                    let serial = f.serial_with(serial_byte);
                    let id =
                        client.issue_claim(&f.issuer, &owners[owner_idx], &serial, &deposit, &0);
                    assert_eq!(id, claims.len() as u64 + 1);
                    claims.push(ModelClaim {
                        owner: owner_idx,
                        deposit,
                        serial: serial_byte,
                        status: ModelStatus::Active,
                    });
                    outstanding += deposit;
                    total_issued += deposit;
                }
            }
            1 => {
                // Transfer an active claim to a different owner.
                if let Some(claim) = claims.get(idx).copied() {
                    if claim.status == ModelStatus::Active {
                        let new_owner = (claim.owner + 1 + owner_idx) % owners.len();
                        if new_owner != claim.owner {
                            let id = idx as u64 + 1;
                            client.transfer_claim(&id, &owners[claim.owner], &owners[new_owner]);
                            claims[idx].owner = new_owner;
                        }
                    }
                }
            }
            2 => {
                // Attest the return of an active claim.
                if let Some(claim) = claims.get(idx).copied() {
                    if claim.status == ModelStatus::Active {
                        let id = idx as u64 + 1;
                        let serial = f.serial_with(claim.serial);
                        client.authorize_return(&id, &f.station, &serial);
                        claims[idx].status = ModelStatus::ReturnAuthorized;
                    }
                }
            }
            3 => {
                // Redeem a return-authorized claim.
                if let Some(claim) = claims.get(idx).copied() {
                    if claim.status == ModelStatus::ReturnAuthorized {
                        let id = idx as u64 + 1;
                        client.redeem(&id);
                        claims[idx].status = ModelStatus::Redeemed;
                        outstanding -= claim.deposit;
                    }
                }
            }
            4 => {
                // A duplicate issue for a live serial must fail atomically.
                if let Some((i, claim)) = claims
                    .iter()
                    .enumerate()
                    .find(|(_, claim)| claim.status != ModelStatus::Redeemed)
                {
                    let serial = f.serial_with(claim.serial);
                    let result = client.try_issue_claim(
                        &f.issuer,
                        &owners[owner_idx],
                        &serial,
                        &deposit,
                        &0,
                    );
                    assert_eq!(result, Err(Ok(Error::SerialAlreadyActive)));
                    // The failed call must not change the claim count.
                    assert_eq!(client.get_claim_count(), claims.len() as u64);
                    // Keep the old claim id addressable in the model.
                    assert!(i < claims.len());
                }
            }
            5 => {
                // A redeemed serial can back a new claim with a new id.
                if claims.len() < 8 {
                    if let Some(claim) = claims.get(idx).copied() {
                        if claim.status == ModelStatus::Redeemed {
                            let serial = f.serial_with(claim.serial);
                            let id = client.issue_claim(
                                &f.issuer,
                                &owners[owner_idx],
                                &serial,
                                &deposit,
                                &0,
                            );
                            assert_eq!(id, claims.len() as u64 + 1);
                            claims.push(ModelClaim {
                                owner: owner_idx,
                                deposit,
                                serial: claim.serial,
                                status: ModelStatus::Active,
                            });
                            outstanding += deposit;
                            total_issued += deposit;
                        }
                    }
                }
            }
            _ => unreachable!(),
        }

        assert_eq!(f.balance(&f.contract_id), outstanding);
        assert_eq!(client.get_outstanding_liability(&f.issuer), outstanding);
        assert_eq!(f.balance(&f.issuer), 10_000 - total_issued);
        assert_eq!(client.get_claim_count(), claims.len() as u64);

        for (i, claim) in claims.iter().enumerate() {
            let id = i as u64 + 1;
            let on_chain = client.get_claim(&id);
            assert_eq!(on_chain.owner, owners[claim.owner]);
            assert_eq!(on_chain.deposit, claim.deposit);
            assert_eq!(
                on_chain.status,
                match claim.status {
                    ModelStatus::Active => ClaimStatus::Active,
                    ModelStatus::ReturnAuthorized => ClaimStatus::ReturnAuthorized,
                    ModelStatus::Redeemed => ClaimStatus::Redeemed,
                }
            );

            let serial_claim = client.get_serial_claim(&f.issuer, &f.serial_with(claim.serial));
            if claim.status == ModelStatus::Redeemed {
                // The same serial may now be reused by a later claim; only the
                // last live claim for that serial should own the index.
                if !claims.iter().skip(i + 1).any(|other| {
                    other.serial == claim.serial && other.status != ModelStatus::Redeemed
                }) {
                    assert_eq!(serial_claim, None);
                }
            } else {
                assert_eq!(serial_claim, Some(id));
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    #[test]
    fn deposit_accounting_invariants_hold_for_random_sequences(
        ops in prop::collection::vec(any::<u8>(), 1..24)
    ) {
        run_invariant_sequence(&ops);
    }
}
