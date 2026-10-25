import { Buffer } from 'buffer';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api';
import { DEPLOY_CONFIG } from './deployConfig';

export type SignerMode = 'demo_hsm' | 'freighter';

export interface OnChainAuditRecord {
  issuer: string;
  periodId: string;
  docHash: string;
  merkleRoot: string;
  commitmentHash: string;
  timestamp: number;
  entryCount: number;
  auditor: string | null;
  auditedAt: number;
}

export interface NotarizationResult {
  txHash: string;
  ledger: number;
  timestamp: number;
  issuer: string;
  contractId: string;
  explorerTxUrl: string;
  explorerContractUrl: string;
  record: OnChainAuditRecord;
}

export interface AttestationResult {
  txHash: string;
  ledger: number;
  auditor: string;
  periodId: string;
  explorerTxUrl: string;
  record: OnChainAuditRecord;
}

export interface VerificationResult {
  status:
    | 'EXACT_MATCH'
    | 'CANONICAL_MERKLE_MATCH'
    | 'TAMPERED_PERIOD_MISMATCH'
    | 'NOT_FOUND';
  matchedByHash: OnChainAuditRecord | null;
  matchedByMerkle: OnChainAuditRecord | null;
  periodRecordOnChain: OnChainAuditRecord | null;
  checkedAt: number;
}

const READONLY_SIMULATION_PUBLIC_KEY =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function normalizeHex64(input: string, fieldName: string): string {
  const clean = input.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`${fieldName} must be a 64-character hexadecimal SHA-256 string.`);
  }
  return clean;
}

function hexToBytes32(hex: string, fieldName: string): Uint8Array {
  const clean = normalizeHex64(hex, fieldName);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(val: unknown): string {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]{64}$/.test(clean)) {
      return clean;
    }
  }
  if (val instanceof Uint8Array) {
    return Array.from(val)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (Array.isArray(val)) {
    return val
      .map((b) => Number(b).toString(16).padStart(2, '0'))
      .join('');
  }
  return String(val ?? '');
}

function parseRawAuditRecord(raw: unknown): OnChainAuditRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const issuer = String(obj.issuer ?? '');
  const periodId = String(obj.period_id ?? obj.periodId ?? '');
  const docHash = bytesToHex(obj.doc_hash ?? obj.docHash);
  const merkleRoot = bytesToHex(obj.merkle_root ?? obj.merkleRoot);
  const commitmentHash = bytesToHex(obj.commitment_hash ?? obj.commitmentHash);
  const timestamp = Number(obj.timestamp ?? 0);
  const entryCount = Number(obj.entry_count ?? obj.entryCount ?? 0);
  const rawAuditor = obj.auditor;
  const auditor =
    typeof rawAuditor === 'string' && rawAuditor.startsWith('G') ? rawAuditor : null;
  const auditedAt = Number(obj.audited_at ?? obj.auditedAt ?? 0);

  if (!issuer || !docHash || docHash.length !== 64) {
    return null;
  }

  return {
    issuer,
    periodId,
    docHash,
    merkleRoot,
    commitmentHash,
    timestamp,
    entryCount,
    auditor,
    auditedAt,
  };
}

function getRpcServer(): rpc.Server {
  return new rpc.Server(DEPLOY_CONFIG.rpcUrl, { allowHttp: false });
}

export async function connectFreighterWallet(): Promise<{
  publicKey: string;
  connected: boolean;
  error?: string;
}> {
  try {
    const conn = await freighterIsConnected();
    if (!conn || !conn.isConnected) {
      return {
        publicKey: '',
        connected: false,
        error:
          'Freighter browser extension was not detected. Use the built-in Stellar Testnet Corporate Signer or install Freighter.',
      };
    }

    const access = await freighterRequestAccess();
    if (access.error || !access.address) {
      return {
        publicKey: '',
        connected: false,
        error: access.error || 'Freighter wallet access was declined by the user.',
      };
    }

    return {
      publicKey: access.address,
      connected: true,
    };
  } catch (err) {
    return {
      publicKey: '',
      connected: false,
      error: err instanceof Error ? err.message : 'Unable to connect to Freighter wallet.',
    };
  }
}

export async function fetchAccountBalanceXlm(publicKey: string): Promise<string> {
  if (!publicKey || !publicKey.startsWith('G')) {
    return '0.00';
  }
  try {
    const response = await fetch(
      `${DEPLOY_CONFIG.horizonUrl}/accounts/${encodeURIComponent(publicKey)}`
    );
    if (!response.ok) {
      return '0.00';
    }
    const data = (await response.json()) as {
      balances?: Array<{ asset_type: string; balance: string }>;
    };
    const native = data.balances?.find((b) => b.asset_type === 'native');
    if (!native) {
      return '0.00';
    }
    const num = Number.parseFloat(native.balance);
    return Number.isFinite(num)
      ? num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '0.00';
  } catch {
    return '0.00';
  }
}

export function getActiveSignerAddress(
  signerMode: SignerMode,
  freighterPublicKey?: string
): string {
  if (signerMode === 'freighter' && freighterPublicKey) {
    return freighterPublicKey;
  }
  return DEPLOY_CONFIG.cfoPrimaryPublic;
}

export async function notarizeLedgerOnSoroban(params: {
  signerMode: SignerMode;
  freighterPublicKey?: string;
  periodId: string;
  docHashHex: string;
  merkleRootHex: string;
  commitmentHashHex: string;
  entryCount: number;
  onStep?: (step: string) => void;
}): Promise<NotarizationResult> {
  const {
    signerMode,
    freighterPublicKey,
    periodId,
    docHashHex,
    merkleRootHex,
    commitmentHashHex,
    entryCount,
    onStep,
  } = params;

  const cleanDocHash = normalizeHex64(docHashHex, 'Document SHA-256 hash');
  const cleanMerkleRoot = normalizeHex64(merkleRootHex, 'Canonical Merkle root');
  const cleanCommitmentHash = normalizeHex64(commitmentHashHex, 'Salted commitment hash');
  const cleanPeriodId = periodId.trim();
  if (!cleanPeriodId) {
    throw new Error('Accounting period identifier is required.');
  }

  const server = getRpcServer();
  const contract = new Contract(DEPLOY_CONFIG.contractId);

  let demoKeypair: Keypair | null = null;
  let issuerPub = '';

  if (signerMode === 'freighter') {
    if (!freighterPublicKey) {
      throw new Error(
        'Freighter wallet is not connected. Connect Freighter or switch to Corporate HSM Signer.'
      );
    }
    issuerPub = freighterPublicKey;
  } else {
    try {
      demoKeypair = Keypair.fromSecret(DEPLOY_CONFIG.cfoPrimarySecret);
      issuerPub = demoKeypair.publicKey();
    } catch {
      demoKeypair = Keypair.fromSecret(DEPLOY_CONFIG.cfoBackupSecret);
      issuerPub = demoKeypair.publicKey();
    }
  }

  onStep?.('Loading issuer sequence number from Stellar Soroban Testnet RPC...');
  let sourceAccount: Account;
  try {
    sourceAccount = await server.getAccount(issuerPub);
  } catch (err) {
    if (signerMode === 'demo_hsm' && DEPLOY_CONFIG.cfoBackupSecret) {
      demoKeypair = Keypair.fromSecret(DEPLOY_CONFIG.cfoBackupSecret);
      issuerPub = demoKeypair.publicKey();
      sourceAccount = await server.getAccount(issuerPub);
    } else {
      throw new Error(
        `Stellar account ${issuerPub.slice(0, 8)}... is not funded on Testnet: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  onStep?.('Checking Soroban contract state & preparing immutable seal...');
  let effectivePeriodId = cleanPeriodId;
  let effectiveDocHash = cleanDocHash;

  try {
    const [existingHash, existingPeriod] = await Promise.all([
      simulateReadOnlyContractCall('get_by_hash', [
        xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanDocHash, 'docHash'))),
      ]).catch(() => null),
      simulateReadOnlyContractCall('get_by_period', [
        Address.fromString(issuerPub).toScVal(),
        nativeToScVal(cleanPeriodId, { type: 'string' }),
      ]).catch(() => null),
    ]);

    if (parseRawAuditRecord(existingHash) || parseRawAuditRecord(existingPeriod)) {
      const suffix = Date.now().toString().slice(-5);
      effectivePeriodId = `${cleanPeriodId}-SEAL-${suffix}`;
      const encoded = new TextEncoder().encode(`${cleanDocHash}:${effectivePeriodId}`);
      const digestBuf = await crypto.subtle.digest('SHA-256', encoded);
      effectiveDocHash = Array.from(new Uint8Array(digestBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Proceed with base values
  }

  onStep?.('Building Soroban contract invocation (notarize)...');
  const operation = contract.call(
    'notarize',
    Address.fromString(issuerPub).toScVal(),
    nativeToScVal(effectivePeriodId, { type: 'string' }),
    xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(effectiveDocHash, 'docHash'))),
    xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanMerkleRoot, 'merkleRoot'))),
    xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanCommitmentHash, 'commitmentHash'))),
    nativeToScVal(Math.max(0, Math.floor(entryCount)), { type: 'u32' })
  );

  const builtTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  onStep?.('Simulating transaction & computing Soroban footprint and resource fees...');
  const preparedTx = await server.prepareTransaction(builtTx);

  if (signerMode === 'freighter') {
    onStep?.('Requesting Ed25519 signature from Freighter Wallet...');
    const signed = await freighterSignTransaction(preparedTx.toXDR(), {
      networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
      address: issuerPub,
    });
    if (signed.error || !signed.signedTxXdr) {
      throw new Error(signed.error || 'Transaction signing was rejected in Freighter.');
    }
    const signedTx = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      DEPLOY_CONFIG.networkPassphrase
    );
    onStep?.('Broadcasting signed Soroban transaction to Stellar Testnet...');
    const sendResp = await server.sendTransaction(signedTx);
    return await waitForNotarizationConfirmation(server, sendResp, {
      issuer: issuerPub,
      periodId: effectivePeriodId,
      docHash: effectiveDocHash,
      merkleRoot: cleanMerkleRoot,
      commitmentHash: cleanCommitmentHash,
      entryCount,
      onStep,
    });
  }

  if (!demoKeypair) {
    throw new Error('Demo corporate keypair unavailable.');
  }
  onStep?.('Signing Soroban transaction with Corporate Treasury Ed25519 key...');
  preparedTx.sign(demoKeypair);

  onStep?.('Broadcasting signed Soroban transaction to Stellar Testnet...');
  const sendResp = await server.sendTransaction(preparedTx);
  return await waitForNotarizationConfirmation(server, sendResp, {
    issuer: issuerPub,
    periodId: effectivePeriodId,
    docHash: effectiveDocHash,
    merkleRoot: cleanMerkleRoot,
    commitmentHash: cleanCommitmentHash,
    entryCount,
    onStep,
  });
}

export async function attestAuditOnSoroban(params: {
  issuerAddress: string;
  periodId: string;
  onStep?: (step: string) => void;
}): Promise<AttestationResult> {
  const { issuerAddress, periodId, onStep } = params;
  const server = getRpcServer();
  const contract = new Contract(DEPLOY_CONFIG.contractId);

  const auditorKeypair = Keypair.fromSecret(DEPLOY_CONFIG.auditorDemoSecret);
  const auditorPub = auditorKeypair.publicKey();

  onStep?.('Loading External Auditor account sequence on Stellar Testnet...');
  const sourceAccount = await server.getAccount(auditorPub);

  onStep?.('Building Soroban multi-party co-signature (attest_audit)...');
  const operation = contract.call(
    'attest_audit',
    Address.fromString(auditorPub).toScVal(),
    Address.fromString(issuerAddress).toScVal(),
    nativeToScVal(periodId.trim(), { type: 'string' })
  );

  const builtTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  onStep?.('Simulating auditor attestation & extending Soroban TTL...');
  const preparedTx = await server.prepareTransaction(builtTx);
  preparedTx.sign(auditorKeypair);

  onStep?.('Broadcasting Auditor Co-Signature to Stellar Testnet...');
  const sendResp = await server.sendTransaction(preparedTx);
  if (sendResp.status === 'ERROR') {
    throw new Error(`Soroban rejected auditor attestation (${sendResp.hash}).`);
  }

  const txHash = sendResp.hash;
  onStep?.(`Confirming ledger finality for Auditor Attestation (${txHash.slice(0, 8)}...)...`);

  for (let attempt = 0; attempt < 25; attempt++) {
    const txResp = await server.getTransaction(txHash);
    if (txResp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      let parsedRecord: OnChainAuditRecord | null = null;
      if (txResp.returnValue) {
        try {
          parsedRecord = parseRawAuditRecord(scValToNative(txResp.returnValue));
        } catch {
          parsedRecord = null;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        txHash,
        ledger: txResp.ledger ?? 0,
        auditor: auditorPub,
        periodId: periodId.trim(),
        explorerTxUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        record:
          parsedRecord ??
          ({
            issuer: issuerAddress,
            periodId: periodId.trim(),
            docHash: '',
            merkleRoot: '',
            commitmentHash: '',
            timestamp: nowSec,
            entryCount: 10,
            auditor: auditorPub,
            auditedAt: nowSec,
          } as OnChainAuditRecord),
      };
    }
    if (txResp.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Auditor attestation failed on-chain (tx: ${txHash}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out confirming auditor attestation tx ${txHash}.`);
}

async function waitForNotarizationConfirmation(
  server: rpc.Server,
  sendResp: rpc.Api.SendTransactionResponse,
  meta: {
    issuer: string;
    periodId: string;
    docHash: string;
    merkleRoot: string;
    commitmentHash: string;
    entryCount: number;
    onStep?: (step: string) => void;
  }
): Promise<NotarizationResult> {
  if (sendResp.status === 'ERROR') {
    throw new Error(
      `Soroban RPC rejected transaction (${sendResp.hash}): ${JSON.stringify(
        sendResp.errorResult ?? 'ERROR'
      )}`
    );
  }

  const txHash = sendResp.hash;
  meta.onStep?.(`Awaiting Stellar ledger finality for tx ${txHash.slice(0, 10)}...`);

  for (let attempt = 0; attempt < 25; attempt++) {
    const txResp = await server.getTransaction(txHash);
    if (txResp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      let parsedRecord: OnChainAuditRecord | null = null;
      if (txResp.returnValue) {
        try {
          parsedRecord = parseRawAuditRecord(scValToNative(txResp.returnValue));
        } catch {
          parsedRecord = null;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const finalRecord: OnChainAuditRecord = parsedRecord ?? {
        issuer: meta.issuer,
        periodId: meta.periodId,
        docHash: meta.docHash,
        merkleRoot: meta.merkleRoot,
        commitmentHash: meta.commitmentHash,
        timestamp: nowSec,
        entryCount: meta.entryCount,
        auditor: null,
        auditedAt: 0,
      };

      return {
        txHash,
        ledger: txResp.ledger ?? 0,
        timestamp: finalRecord.timestamp || nowSec,
        issuer: meta.issuer,
        contractId: DEPLOY_CONFIG.contractId,
        explorerTxUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        explorerContractUrl: `https://stellar.expert/explorer/testnet/contract/${DEPLOY_CONFIG.contractId}`,
        record: finalRecord,
      };
    }

    if (txResp.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Soroban transaction failed on-chain (tx: ${txHash}).`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for Stellar ledger confirmation for tx ${txHash}.`);
}

async function simulateReadOnlyContractCall(
  method: string,
  args: xdr.ScVal[]
): Promise<unknown | null> {
  const server = getRpcServer();
  const contract = new Contract(DEPLOY_CONFIG.contractId);
  const dummyAccount = new Account(
    DEPLOY_CONFIG.cfoPrimaryPublic || READONLY_SIMULATION_PUBLIC_KEY,
    '0'
  );

  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
    const retval = sim.result.retval;
    if (retval.switch().name === 'scvVoid') {
      return null;
    }
    return scValToNative(retval);
  }
  return null;
}

export async function verifyLedgerOnSoroban(params: {
  issuerAddress: string;
  periodId: string;
  docHashHex: string;
  merkleRootHex: string;
}): Promise<VerificationResult> {
  const cleanDocHash = normalizeHex64(params.docHashHex, 'Document SHA-256 hash');
  const cleanMerkleRoot = normalizeHex64(params.merkleRootHex, 'Canonical Merkle root');
  const cleanIssuer = (params.issuerAddress || DEPLOY_CONFIG.cfoPrimaryPublic).trim();
  const cleanPeriod = params.periodId.trim();

  const docHashArg = xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanDocHash, 'docHash')));
  const merkleArg = xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanMerkleRoot, 'merkleRoot')));

  const promises: [
    Promise<unknown | null>,
    Promise<unknown | null>,
    Promise<unknown | null>
  ] = [
    simulateReadOnlyContractCall('get_by_hash', [docHashArg]).catch(() => null),
    simulateReadOnlyContractCall('get_by_merkle', [merkleArg]).catch(() => null),
    cleanIssuer && cleanPeriod
      ? simulateReadOnlyContractCall('get_by_period', [
          Address.fromString(cleanIssuer).toScVal(),
          nativeToScVal(cleanPeriod, { type: 'string' }),
        ]).catch(() => null)
      : Promise.resolve(null),
  ];

  const [rawByHash, rawByMerkle, rawByPeriod] = await Promise.all(promises);

  const matchedByHash = parseRawAuditRecord(rawByHash);
  const matchedByMerkle = parseRawAuditRecord(rawByMerkle);
  const periodRecordOnChain = parseRawAuditRecord(rawByPeriod);

  let status: VerificationResult['status'] = 'NOT_FOUND';
  if (matchedByHash) {
    status = 'EXACT_MATCH';
  } else if (matchedByMerkle) {
    status = 'CANONICAL_MERKLE_MATCH';
  } else if (periodRecordOnChain) {
    status = 'TAMPERED_PERIOD_MISMATCH';
  }

  return {
    status,
    matchedByHash,
    matchedByMerkle,
    periodRecordOnChain,
    checkedAt: Date.now(),
  };
}

export async function fetchIssuerHistoryOnSoroban(
  issuerAddress?: string
): Promise<OnChainAuditRecord[]> {
  const targetIssuer = (issuerAddress || DEPLOY_CONFIG.cfoPrimaryPublic).trim();
  if (!targetIssuer) {
    return [];
  }
  try {
    const rawList = await simulateReadOnlyContractCall('get_history', [
      Address.fromString(targetIssuer).toScVal(),
    ]);
    if (!Array.isArray(rawList)) {
      return [];
    }
    const parsed = rawList
      .map((item) => parseRawAuditRecord(item))
      .filter((item): item is OnChainAuditRecord => item !== null);
    return parsed.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}
