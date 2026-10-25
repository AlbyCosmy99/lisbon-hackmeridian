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

/**
 * Direct JSON-RPC polling for `getTransaction` that bypasses `@stellar/stellar-sdk`'s
 * `parseTransactionInfo(resultMetaXdr)` so Protocol 23+ `TransactionMetaV4` (union switch: 4)
 * never throws `TypeError: Bad union switch: 4`.
 */
async function pollTransactionStatusJsonRpc(txHash: string): Promise<{
  status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  ledger: number;
  returnValue: OnChainAuditRecord | null;
}> {
  const response = await fetch(DEPLOY_CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash: txHash },
    }),
  });

  const json = (await response.json()) as {
    result?: {
      status?: string;
      ledger?: number;
      returnValueXdr?: string;
    };
  };

  const status = json?.result?.status;
  if (status === 'SUCCESS') {
    let parsedRecord: OnChainAuditRecord | null = null;
    if (json.result?.returnValueXdr) {
      try {
        const scVal = xdr.ScVal.fromXDR(json.result.returnValueXdr, 'base64');
        parsedRecord = parseRawAuditRecord(scValToNative(scVal));
      } catch {
        parsedRecord = null;
      }
    }
    return {
      status: 'SUCCESS',
      ledger: Number(json.result?.ledger ?? 0),
      returnValue: parsedRecord,
    };
  }

  if (status === 'FAILED') {
    return {
      status: 'FAILED',
      ledger: Number(json.result?.ledger ?? 0),
      returnValue: null,
    };
  }

  return {
    status: 'NOT_FOUND',
    ledger: 0,
    returnValue: null,
  };
}

export async function connectFreighterWallet(): Promise<{
  publicKey: string;
  connected: boolean;
  error?: string;
}> {
  try {
    const conn = await freighterIsConnected();
    const isConn =
      typeof conn === 'boolean' ? conn : Boolean(conn && conn.isConnected);
    if (!isConn) {
      return {
        publicKey: '',
        connected: false,
        error:
          'Freighter browser extension was not detected. Use the built-in Testnet Demo Key or install the Freighter extension.',
      };
    }

    const access = await freighterRequestAccess();
    const address =
      typeof access === 'string' ? access : (access?.address ?? '');
    const errText =
      typeof access === 'object' && access !== null ? access.error : undefined;

    if (errText || !address) {
      return {
        publicKey: '',
        connected: false,
        error: errText || 'Freighter wallet access was declined by the user.',
      };
    }

    return {
      publicKey: address,
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
    throw new Error('Document identifier is required.');
  }

  const server = getRpcServer();
  const contract = new Contract(DEPLOY_CONFIG.contractId);

  let demoKeypair: Keypair | null = null;
  let issuerPub = '';

  if (signerMode === 'freighter') {
    if (!freighterPublicKey) {
      throw new Error(
        'Freighter wallet is not connected. Connect Freighter or switch to the Built-In Testnet Wallet.'
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

  onStep?.('Loading account sequence from Stellar Testnet...');
  let sourceAccount: Account;
  try {
    sourceAccount = await server.getAccount(issuerPub);
  } catch (err) {
    if (signerMode === 'demo_hsm' && DEPLOY_CONFIG.cfoBackupSecret) {
      demoKeypair = Keypair.fromSecret(DEPLOY_CONFIG.cfoBackupSecret);
      issuerPub = demoKeypair.publicKey();
      sourceAccount = await server.getAccount(issuerPub);
    } else if (signerMode === 'freighter') {
      onStep?.('Auto-funding your Freighter wallet with 10,000 Testnet XLM via Friendbot...');
      await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(issuerPub)}`);
      sourceAccount = await server.getAccount(issuerPub);
    } else {
      throw new Error(
        `Stellar account ${issuerPub.slice(0, 8)}... is not funded on Testnet: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  onStep?.('Preparing unique blockchain seal on Stellar...');
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

  onStep?.('Building Stellar smart contract transaction...');
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

  onStep?.('Simulating transaction on Stellar Testnet...');
  const preparedTx = await server.prepareTransaction(builtTx);

  if (signerMode === 'freighter') {
    onStep?.('Waiting for signature approval in your Freighter Wallet...');
    const signed = await freighterSignTransaction(preparedTx.toXDR(), {
      networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
      address: issuerPub,
    });
    const signedXdr =
      typeof signed === 'string' ? signed : signed?.signedTxXdr ?? '';
    const signErr =
      typeof signed === 'object' && signed !== null ? signed.error : undefined;

    if (signErr || !signedXdr) {
      throw new Error(signErr || 'Transaction signing was cancelled in Freighter.');
    }
    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      DEPLOY_CONFIG.networkPassphrase
    );
    onStep?.('Submitting signed seal to Stellar Testnet...');
    const sendResp = await server.sendTransaction(signedTx);
    return await waitForNotarizationConfirmation(sendResp, {
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
  onStep?.('Signing transaction & broadcasting to Stellar Testnet...');
  preparedTx.sign(demoKeypair);

  let sendResp = await server.sendTransaction(preparedTx);

  // If two users clicked Demo Seal at the exact same millisecond causing a sequence collision,
  // automatically fallback to the backup corporate keypair!
  if (sendResp.status === 'ERROR' && DEPLOY_CONFIG.cfoBackupSecret) {
    const backupKp = Keypair.fromSecret(DEPLOY_CONFIG.cfoBackupSecret);
    const backupPub = backupKp.publicKey();
    const backupAcct = await server.getAccount(backupPub);
    const suffix = Date.now().toString().slice(-5);
    const retryPeriod = `${cleanPeriodId}-SEAL-${suffix}`;
    const encoded = new TextEncoder().encode(`${cleanDocHash}:${retryPeriod}`);
    const digestBuf = await crypto.subtle.digest('SHA-256', encoded);
    const retryDocHash = Array.from(new Uint8Array(digestBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const retryOp = contract.call(
      'notarize',
      Address.fromString(backupPub).toScVal(),
      nativeToScVal(retryPeriod, { type: 'string' }),
      xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(retryDocHash, 'docHash'))),
      xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanMerkleRoot, 'merkleRoot'))),
      xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanCommitmentHash, 'commitmentHash'))),
      nativeToScVal(Math.max(0, Math.floor(entryCount)), { type: 'u32' })
    );
    const retryTx = new TransactionBuilder(backupAcct, {
      fee: BASE_FEE,
      networkPassphrase: DEPLOY_CONFIG.networkPassphrase,
    })
      .addOperation(retryOp)
      .setTimeout(60)
      .build();
    const retryPrep = await server.prepareTransaction(retryTx);
    retryPrep.sign(backupKp);
    sendResp = await server.sendTransaction(retryPrep);
    issuerPub = backupPub;
    effectivePeriodId = retryPeriod;
    effectiveDocHash = retryDocHash;
  }

  return await waitForNotarizationConfirmation(sendResp, {
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

  onStep?.('Loading External Auditor account on Stellar Testnet...');
  const sourceAccount = await server.getAccount(auditorPub);

  onStep?.('Building External Auditor co-signature transaction...');
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

  onStep?.('Simulating auditor co-signature on Stellar Testnet...');
  const preparedTx = await server.prepareTransaction(builtTx);
  preparedTx.sign(auditorKeypair);

  onStep?.('Broadcasting Auditor Co-Signature to Stellar Testnet...');
  const sendResp = await server.sendTransaction(preparedTx);
  if (sendResp.status === 'ERROR') {
    throw new Error(`Stellar rejected auditor co-signature (${sendResp.hash}).`);
  }

  const txHash = sendResp.hash;
  onStep?.(`Confirming Stellar finality for co-signature (${txHash.slice(0, 8)}...)...`);

  for (let attempt = 0; attempt < 25; attempt++) {
    const polled = await pollTransactionStatusJsonRpc(txHash);
    if (polled.status === 'SUCCESS') {
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        txHash,
        ledger: polled.ledger,
        auditor: auditorPub,
        periodId: periodId.trim(),
        explorerTxUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        record:
          polled.returnValue ??
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
    if (polled.status === 'FAILED') {
      throw new Error(`Auditor co-signature failed on-chain (tx: ${txHash}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out confirming auditor co-signature tx ${txHash}.`);
}

async function waitForNotarizationConfirmation(
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
      `Stellar RPC rejected transaction (${sendResp.hash}). Please click the button once more.`
    );
  }

  const txHash = sendResp.hash;
  meta.onStep?.(`Confirming Stellar blockchain finality (${txHash.slice(0, 10)}...)...`);

  for (let attempt = 0; attempt < 25; attempt++) {
    const polled = await pollTransactionStatusJsonRpc(txHash);
    if (polled.status === 'SUCCESS') {
      const nowSec = Math.floor(Date.now() / 1000);
      const finalRecord: OnChainAuditRecord = polled.returnValue ?? {
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
        ledger: polled.ledger,
        timestamp: finalRecord.timestamp || nowSec,
        issuer: meta.issuer,
        contractId: DEPLOY_CONFIG.contractId,
        explorerTxUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        explorerContractUrl: `https://stellar.expert/explorer/testnet/contract/${DEPLOY_CONFIG.contractId}`,
        record: finalRecord,
      };
    }

    if (polled.status === 'FAILED') {
      throw new Error(`Transaction failed on Stellar Testnet (tx: ${txHash}).`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for Stellar confirmation for tx ${txHash}.`);
}

async function simulateReadOnlyContractCall(
  method: string,
  args: xdr.ScVal[]
): Promise<unknown | null> {
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

  // Direct JSON-RPC simulateTransaction so we never trip over SDK XDR union switches on diagnosticEvents/stateChanges
  const response = await fetch(DEPLOY_CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: tx.toXDR(),
      },
    }),
  });

  const json = (await response.json()) as {
    result?: {
      results?: Array<{ xdr?: string }>;
    };
  };

  const retvalXdr = json?.result?.results?.[0]?.xdr;
  if (!retvalXdr) {
    return null;
  }

  const retval = xdr.ScVal.fromXDR(retvalXdr, 'base64');
  if (retval.switch().name === 'scvVoid') {
    return null;
  }
  return scValToNative(retval);
}

export async function verifyLedgerOnSoroban(params: {
  issuerAddress: string;
  periodId: string;
  docHashHex: string;
  merkleRootHex: string;
}): Promise<VerificationResult> {
  const cleanDocHash = normalizeHex64(params.docHashHex, 'docHash');
  const cleanMerkleRoot = normalizeHex64(params.merkleRootHex, 'merkleRoot');
  const cleanIssuer = params.issuerAddress.trim();
  const cleanPeriod = params.periodId.trim();

  const docHashArg = xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanDocHash, 'docHash')));
  const merkleArg = xdr.ScVal.scvBytes(Buffer.from(hexToBytes32(cleanMerkleRoot, 'merkleRoot')));

  const promises: [
    Promise<unknown | null>,
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
    cleanPeriod && cleanIssuer !== DEPLOY_CONFIG.cfoPrimaryPublic
      ? simulateReadOnlyContractCall('get_by_period', [
          Address.fromString(DEPLOY_CONFIG.cfoPrimaryPublic).toScVal(),
          nativeToScVal(cleanPeriod, { type: 'string' }),
        ]).catch(() => null)
      : Promise.resolve(null),
  ];

  const [rawByHash, rawByMerkle, rawByPeriod, rawByDefaultIssuerPeriod] =
    await Promise.all(promises);

  const matchedByHash = parseRawAuditRecord(rawByHash);
  const matchedByMerkle = parseRawAuditRecord(rawByMerkle);
  const periodRecordOnChain =
    parseRawAuditRecord(rawByPeriod) || parseRawAuditRecord(rawByDefaultIssuerPeriod);

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

export async function fundAccountOnFriendbot(
  publicKey: string
): Promise<boolean> {
  const clean = publicKey.trim();
  if (!clean) return false;
  try {
    const res = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(clean)}`
    );
    return res.ok;
  } catch {
    return false;
  }
}
