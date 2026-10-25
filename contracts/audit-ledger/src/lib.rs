#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    String, Vec,
};

/// Minimum remaining TTL threshold (~1 day at 5s per ledger) before extending archival state.
const MIN_TTL_LEDGERS: u32 = 17_280;
/// Target persistent storage TTL (~30 days at 5s per ledger) for regulatory audit records.
const MAX_TTL_LEDGERS: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AuditError {
    HashAlreadyNotarized = 1,
    PeriodAlreadyClosed = 2,
    RecordNotFound = 3,
    AlreadyAttested = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditRecord {
    pub issuer: Address,
    pub period_id: String,
    pub doc_hash: BytesN<32>,
    pub merkle_root: BytesN<32>,
    pub commitment_hash: BytesN<32>,
    pub timestamp: u64,
    pub entry_count: u32,
    pub auditor: Option<Address>,
    pub audited_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    ByHash(BytesN<32>),
    ByMerkle(BytesN<32>),
    ByPeriod(Address, String),
    History(Address),
}

#[contract]
pub struct AuditLedgerContract;

#[contractimpl]
impl AuditLedgerContract {
    /// Notarize a financial close package hash, Merkle root, and privacy commitment on Stellar.
    /// Enforces cryptographically verified CFO authorization, prevents duplicate period closes
    /// or re-notarizing an existing document hash, and extends Soroban state archival TTLs.
    pub fn notarize(
        env: Env,
        issuer: Address,
        period_id: String,
        doc_hash: BytesN<32>,
        merkle_root: BytesN<32>,
        commitment_hash: BytesN<32>,
        entry_count: u32,
    ) -> Result<AuditRecord, AuditError> {
        issuer.require_auth();

        let hash_key = DataKey::ByHash(doc_hash.clone());
        if env.storage().persistent().has(&hash_key) {
            return Err(AuditError::HashAlreadyNotarized);
        }

        let period_key = DataKey::ByPeriod(issuer.clone(), period_id.clone());
        if env.storage().persistent().has(&period_key) {
            return Err(AuditError::PeriodAlreadyClosed);
        }

        let timestamp = env.ledger().timestamp();
        let record = AuditRecord {
            issuer: issuer.clone(),
            period_id: period_id.clone(),
            doc_hash: doc_hash.clone(),
            merkle_root: merkle_root.clone(),
            commitment_hash,
            timestamp,
            entry_count,
            auditor: None,
            audited_at: 0,
        };

        let merkle_key = DataKey::ByMerkle(merkle_root);
        let history_key = DataKey::History(issuer.clone());

        env.storage().persistent().set(&hash_key, &record);
        env.storage().persistent().set(&merkle_key, &record);
        env.storage().persistent().set(&period_key, &record);

        let mut history: Vec<AuditRecord> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(record.clone());
        env.storage().persistent().set(&history_key, &history);

        env.storage()
            .persistent()
            .extend_ttl(&hash_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&merkle_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&period_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&history_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);

        env.events()
            .publish((symbol_short!("notarize"), issuer), record.clone());

        Ok(record)
    }

    /// Record an on-chain External Auditor co-signature (bilateral audit attestation)
    /// on an existing CFO close record.
    pub fn attest_audit(
        env: Env,
        auditor: Address,
        issuer: Address,
        period_id: String,
    ) -> Result<AuditRecord, AuditError> {
        auditor.require_auth();

        let period_key = DataKey::ByPeriod(issuer.clone(), period_id.clone());
        let mut record: AuditRecord = env
            .storage()
            .persistent()
            .get(&period_key)
            .ok_or(AuditError::RecordNotFound)?;

        record.auditor = Some(auditor.clone());
        record.audited_at = env.ledger().timestamp();

        let hash_key = DataKey::ByHash(record.doc_hash.clone());
        let merkle_key = DataKey::ByMerkle(record.merkle_root.clone());
        let history_key = DataKey::History(issuer.clone());

        env.storage().persistent().set(&hash_key, &record);
        env.storage().persistent().set(&merkle_key, &record);
        env.storage().persistent().set(&period_key, &record);

        let history: Vec<AuditRecord> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated_history = Vec::new(&env);
        for item in history.iter() {
            if item.period_id == period_id {
                updated_history.push_back(record.clone());
            } else {
                updated_history.push_back(item);
            }
        }
        env.storage().persistent().set(&history_key, &updated_history);

        env.storage()
            .persistent()
            .extend_ttl(&hash_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&merkle_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&period_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&history_key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("attest"), auditor, period_id),
            record.clone(),
        );

        Ok(record)
    }

    /// Compute a SHA-256 Merkle parent node from two 32-byte child hashes using
    /// Soroban's native cryptographic host function (`env.crypto().sha256`).
    pub fn verify_merkle_pair(env: Env, left: BytesN<32>, right: BytesN<32>) -> BytesN<32> {
        let mut combined = Bytes::new(&env);
        combined.append(&Bytes::from_slice(&env, &left.to_array()));
        combined.append(&Bytes::from_slice(&env, &right.to_array()));
        env.crypto().sha256(&combined).into()
    }

    /// Retrieve an immutable audit record by its SHA-256 document hash.
    pub fn get_by_hash(env: Env, doc_hash: BytesN<32>) -> Option<AuditRecord> {
        let key = DataKey::ByHash(doc_hash);
        env.storage().persistent().get(&key)
    }

    /// Retrieve an immutable audit record by its journal Merkle root.
    pub fn get_by_merkle(env: Env, merkle_root: BytesN<32>) -> Option<AuditRecord> {
        let key = DataKey::ByMerkle(merkle_root);
        env.storage().persistent().get(&key)
    }

    /// Retrieve an immutable audit record by CFO issuer address and accounting period ID.
    pub fn get_by_period(env: Env, issuer: Address, period_id: String) -> Option<AuditRecord> {
        let key = DataKey::ByPeriod(issuer, period_id);
        env.storage().persistent().get(&key)
    }

    /// Retrieve the full chronological history of notarized accounting closes for an issuer.
    pub fn get_history(env: Env, issuer: Address) -> Vec<AuditRecord> {
        let key = DataKey::History(issuer);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    #[test]
    fn test_notarize_and_all_getters() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_761_400_000;
        });

        let contract_id = env.register(AuditLedgerContract, ());
        let client = AuditLedgerContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let period_id = String::from_str(&env, "2026-10-SAP-GL");
        let doc_hash = BytesN::from_array(&env, &[0x11u8; 32]);
        let merkle_root = BytesN::from_array(&env, &[0x22u8; 32]);
        let commitment_hash = BytesN::from_array(&env, &[0x33u8; 32]);

        let record = client.notarize(
            &issuer,
            &period_id,
            &doc_hash,
            &merkle_root,
            &commitment_hash,
            &12u32,
        );

        assert_eq!(record.issuer, issuer);
        assert_eq!(record.period_id, period_id);
        assert_eq!(record.doc_hash, doc_hash);
        assert_eq!(record.merkle_root, merkle_root);
        assert_eq!(record.commitment_hash, commitment_hash);
        assert_eq!(record.timestamp, 1_761_400_000);
        assert_eq!(record.entry_count, 12);
        assert_eq!(record.auditor, None);
        assert_eq!(record.audited_at, 0);

        let by_hash = client.get_by_hash(&doc_hash).expect("record by hash");
        assert_eq!(by_hash, record);

        let by_merkle = client.get_by_merkle(&merkle_root).expect("record by merkle");
        assert_eq!(by_merkle, record);

        let by_period = client
            .get_by_period(&issuer, &period_id)
            .expect("record by period");
        assert_eq!(by_period, record);

        let history = client.get_history(&issuer);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap(), record);
    }

    #[test]
    fn test_attest_audit_and_missing_record() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_761_400_000;
        });

        let contract_id = env.register(AuditLedgerContract, ());
        let client = AuditLedgerContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let auditor = Address::generate(&env);
        let period_id = String::from_str(&env, "2026-09-SAP-GL");
        let missing_period = String::from_str(&env, "2025-01-SAP-GL");
        let doc_hash = BytesN::from_array(&env, &[0x44u8; 32]);
        let merkle_root = BytesN::from_array(&env, &[0x55u8; 32]);
        let commitment_hash = BytesN::from_array(&env, &[0x66u8; 32]);

        let missing_res = client.try_attest_audit(&auditor, &issuer, &missing_period);
        assert_eq!(missing_res, Err(Ok(AuditError::RecordNotFound)));

        client.notarize(
            &issuer,
            &period_id,
            &doc_hash,
            &merkle_root,
            &commitment_hash,
            &7u32,
        );

        env.ledger().with_mut(|li| {
            li.timestamp = 1_761_405_500;
        });

        let attested = client.attest_audit(&auditor, &issuer, &period_id);
        assert_eq!(attested.auditor, Some(auditor.clone()));
        assert_eq!(attested.audited_at, 1_761_405_500);

        let by_hash = client.get_by_hash(&doc_hash).unwrap();
        assert_eq!(by_hash.auditor, Some(auditor.clone()));
        assert_eq!(by_hash.audited_at, 1_761_405_500);

        let history = client.get_history(&issuer);
        assert_eq!(history.get(0).unwrap().auditor, Some(auditor));
    }

    #[test]
    fn test_verify_merkle_pair_native_sha256() {
        let env = Env::default();
        let contract_id = env.register(AuditLedgerContract, ());
        let client = AuditLedgerContractClient::new(&env, &contract_id);

        let left = BytesN::from_array(&env, &[0x10u8; 32]);
        let right = BytesN::from_array(&env, &[0x20u8; 32]);

        let parent = client.verify_merkle_pair(&left, &right);
        let mut expected_input = Bytes::new(&env);
        expected_input.append(&Bytes::from_slice(&env, &[0x10u8; 32]));
        expected_input.append(&Bytes::from_slice(&env, &[0x20u8; 32]));
        let expected: BytesN<32> = env.crypto().sha256(&expected_input).into();

        assert_eq!(parent, expected);
    }

    #[test]
    fn test_rejects_duplicate_hash() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(AuditLedgerContract, ());
        let client = AuditLedgerContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let period_1 = String::from_str(&env, "2026-09-SAP-GL");
        let period_2 = String::from_str(&env, "2026-10-SAP-GL");
        let doc_hash = BytesN::from_array(&env, &[0xAAu8; 32]);
        let merkle_1 = BytesN::from_array(&env, &[0xBBu8; 32]);
        let merkle_2 = BytesN::from_array(&env, &[0xCCu8; 32]);
        let commitment = BytesN::from_array(&env, &[0xDDu8; 32]);

        client.notarize(&issuer, &period_1, &doc_hash, &merkle_1, &commitment, &10u32);

        let duplicate_res =
            client.try_notarize(&issuer, &period_2, &doc_hash, &merkle_2, &commitment, &10u32);
        assert_eq!(duplicate_res, Err(Ok(AuditError::HashAlreadyNotarized)));
    }

    #[test]
    fn test_rejects_duplicate_period_for_same_issuer() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(AuditLedgerContract, ());
        let client = AuditLedgerContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let period = String::from_str(&env, "2026-10-SAP-GL");
        let doc_hash_1 = BytesN::from_array(&env, &[0x01u8; 32]);
        let doc_hash_2 = BytesN::from_array(&env, &[0x02u8; 32]);
        let merkle_1 = BytesN::from_array(&env, &[0x03u8; 32]);
        let merkle_2 = BytesN::from_array(&env, &[0x04u8; 32]);
        let commitment = BytesN::from_array(&env, &[0x05u8; 32]);

        client.notarize(&issuer, &period, &doc_hash_1, &merkle_1, &commitment, &8u32);

        let duplicate_period_res =
            client.try_notarize(&issuer, &period, &doc_hash_2, &merkle_2, &commitment, &9u32);
        assert_eq!(duplicate_period_res, Err(Ok(AuditError::PeriodAlreadyClosed)));
    }
}
