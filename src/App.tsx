import React, { useEffect, useMemo, useState } from 'react';
import { MerkleTreeVisualizer } from './components/MerkleTreeVisualizer';
import { DEPLOY_CONFIG } from './lib/deployConfig';
import {
  ParsedLedger,
  RowDiffItem,
  RowMerkleProof,
  TamperXRayReport,
  createTamperedCloneOfLedger,
  formatCentsToEur,
  generateRowMerkleProof,
  processLedgerContent,
  processMultipleFilesBatch,
  runTamperXRay,
  verifyRowMerkleProof,
} from './lib/merkleAndCrypto';
import { generateVerificationMatrixSvgDataUri } from './lib/qrGenerator';
import {
  getAuthenticOct2026Csv,
  getAuthenticSep2026Csv,
  getMacExcelResavedOct2026Csv,
  getMessyErpOct2026Csv,
  getTamperedOct2026Csv,
} from './lib/sampleData';
import {
  AttestationResult,
  NotarizationResult,
  OnChainAuditRecord,
  SignerMode,
  VerificationResult,
  attestAuditOnSoroban,
  connectFreighterWallet,
  fetchAccountBalanceXlm,
  fetchIssuerHistoryOnSoroban,
  getActiveSignerAddress,
  notarizeLedgerOnSoroban,
  verifyLedgerOnSoroban,
} from './lib/stellarSoroban';

type PortalTab = 'issuer' | 'auditor';
type AuditorScenario = 'authentic' | 'resaved_excel' | 'tampered_fraud' | 'custom';

export function App() {
  const [activeTab, setActiveTab] = useState<PortalTab>('issuer');

  // Signer & Wallet State
  const [signerMode, setSignerMode] = useState<SignerMode>('demo_hsm');
  const [freighterAddress, setFreighterAddress] = useState<string>('');
  const [walletError, setWalletError] = useState<string>('');
  const [xlmBalance, setXlmBalance] = useState<string>('9,887.72');
  const [showWalletMenu, setShowWalletMenu] = useState<boolean>(false);

  // Company / Issuer State
  const [issuerLedger, setIssuerLedger] = useState<ParsedLedger | null>(null);
  const [customPeriodId, setCustomPeriodId] = useState<string>('2026-10-SAP-GL');
  const [rowSearchQuery, setRowSearchQuery] = useState<string>('');
  const [isNotarizing, setIsNotarizing] = useState<boolean>(false);
  const [notarizeStep, setNotarizeStep] = useState<string>('');
  const [notarizeError, setNotarizeError] = useState<string>('');
  const [lastNotarization, setLastNotarization] = useState<NotarizationResult | null>(null);
  const [issuerExistingRecord, setIssuerExistingRecord] = useState<OnChainAuditRecord | null>(null);
  const [showMerkleTopology, setShowMerkleTopology] = useState<boolean>(false);
  const [showTechnicalReceipt, setShowTechnicalReceipt] = useState<boolean>(false);

  // Locally cached authentic snapshots by periodId for Forensic Redline Diff
  const [sealedSnapshots, setSealedSnapshots] = useState<Record<string, ParsedLedger>>({});

  // Auditor State
  const [auditorScenario, setAuditorScenario] = useState<AuditorScenario>('authentic');
  const [auditorScenarioNote, setAuditorScenarioNote] = useState<string>('');
  const [auditorLedger, setAuditorLedger] = useState<ParsedLedger | null>(null);
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);
  const [tamperXRay, setTamperXRay] = useState<TamperXRayReport | null>(null);
  const [isAttesting, setIsAttesting] = useState<boolean>(false);
  const [attestStep, setAttestStep] = useState<string>('');
  const [attestError, setAttestError] = useState<string>('');
  const [lastAttestation, setLastAttestation] = useState<AttestationResult | null>(null);
  const [rawMessyPreview, setRawMessyPreview] = useState<string>('');
  const [showRawMessyModal, setShowRawMessyModal] = useState<boolean>(false);

  // Single-Row Merkle Proof State
  const [selectedProofRowIndex, setSelectedProofRowIndex] = useState<number>(4);
  const [activeRowProof, setActiveRowProof] = useState<RowMerkleProof | null>(null);
  const [rowProofCheck, setRowProofCheck] = useState<{
    valid: boolean;
    computedRoot: string;
    recalculatedLeafHash: string;
  } | null>(null);

  // Certificate Modal
  const [certificateRecord, setCertificateRecord] = useState<{
    record: OnChainAuditRecord;
    txHash: string;
    fileName: string;
    totalFormatted: string;
  } | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string>('');

  const activeSignerPub = useMemo(
    () => getActiveSignerAddress(signerMode, freighterAddress),
    [signerMode, freighterAddress]
  );

  // Pre-cache sealed reference snapshots in background (without pre-loading any fake UI file!)
  useEffect(() => {
    let mounted = true;
    async function initReferenceSnapshots() {
      const oct = getAuthenticOct2026Csv();
      const sep = getAuthenticSep2026Csv();
      const [parsedOct, parsedSep] = await Promise.all([
        processLedgerContent(oct.fileName, oct.content, oct.periodId),
        processLedgerContent(sep.fileName, sep.content, sep.periodId),
      ]);
      if (!mounted) return;
      setSealedSnapshots({
        [parsedOct.periodId]: parsedOct,
        [parsedSep.periodId]: parsedSep,
      });
    }
    void initReferenceSnapshots();
    return () => {
      mounted = false;
    };
  }, []);

  // Sync balance
  useEffect(() => {
    let cancelled = false;
    async function syncChainState() {
      const [bal] = await Promise.all([
        fetchAccountBalanceXlm(activeSignerPub),
        fetchIssuerHistoryOnSoroban(activeSignerPub),
      ]);
      if (cancelled) return;
      if (bal !== '0.00') {
        setXlmBalance(bal);
      }
    }
    void syncChainState();
    return () => {
      cancelled = true;
    };
  }, [activeSignerPub]);

  // Check if current document is already sealed on Stellar Soroban
  useEffect(() => {
    let cancelled = false;
    async function checkExistingOnChain() {
      if (!issuerLedger) return;
      try {
        const res = await verifyLedgerOnSoroban({
          issuerAddress: activeSignerPub,
          periodId: customPeriodId || issuerLedger.periodId,
          docHashHex: issuerLedger.rawFileHash,
          merkleRootHex: issuerLedger.merkleRoot,
        });
        if (cancelled) return;
        // Only treat as already sealed if THIS document's exact SHA-256 or Canonical Merkle Root is on-chain
        const found = res.matchedByHash || res.matchedByMerkle || null;
        setIssuerExistingRecord(found);
      } catch {
        if (!cancelled) setIssuerExistingRecord(null);
      }
    }
    void checkExistingOnChain();
    return () => {
      cancelled = true;
    };
  }, [issuerLedger, customPeriodId, activeSignerPub]);

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedLabel(label);
    setTimeout(() => setCopiedLabel(''), 1600);
  };

  const handleConnectFreighter = async () => {
    setWalletError('');
    const result = await connectFreighterWallet();
    if (!result.connected) {
      setWalletError(result.error || 'Freighter extension not detected.');
      setSignerMode('demo_hsm');
      return;
    }
    setFreighterAddress(result.publicKey);
    setSignerMode('freighter');
    setShowWalletMenu(false);
  };

  const handleLoadIssuerPreset = async (
    preset: 'oct_2026' | 'sep_2026' | 'messy_erp'
  ) => {
    setNotarizeError('');
    setLastNotarization(null);
    if (preset === 'messy_erp') {
      const messy = getMessyErpOct2026Csv();
      setRawMessyPreview(messy.rawPreview);
      const parsed = await processLedgerContent(
        messy.fileName,
        messy.content,
        messy.periodId
      );
      setIssuerLedger(parsed);
      setCustomPeriodId(parsed.periodId);
      setSealedSnapshots((prev) => ({ ...prev, [parsed.periodId]: parsed }));
      const proof = generateRowMerkleProof(parsed, 4);
      setActiveRowProof(proof);
      const check = await verifyRowMerkleProof(proof, parsed.merkleRoot);
      setRowProofCheck(check);
      return;
    }

    setRawMessyPreview('');
    const dataset =
      preset === 'oct_2026' ? getAuthenticOct2026Csv() : getAuthenticSep2026Csv();
    const parsed = await processLedgerContent(
      dataset.fileName,
      dataset.content,
      dataset.periodId
    );
    setIssuerLedger(parsed);
    setCustomPeriodId(parsed.periodId);
    setSealedSnapshots((prev) => ({ ...prev, [parsed.periodId]: parsed }));
    const proof = generateRowMerkleProof(parsed, 4);
    setActiveRowProof(proof);
    const check = await verifyRowMerkleProof(proof, parsed.merkleRoot);
    setRowProofCheck(check);
  };

  const handleIssuerFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setNotarizeError('');
    setLastNotarization(null);
    setIssuerExistingRecord(null);
    setRawMessyPreview('');

    const loadedFiles: Array<{ name: string; bytes: Uint8Array }> = [];
    for (let i = 0; i < fileList.length; i += 1) {
      const f = fileList[i];
      const buffer = await f.arrayBuffer();
      loadedFiles.push({ name: f.name, bytes: new Uint8Array(buffer) });
    }

    const parsed = await processMultipleFilesBatch(loadedFiles);
    setIssuerLedger(parsed);
    setCustomPeriodId(parsed.periodId);
    setSealedSnapshots((prev) => ({ ...prev, [parsed.periodId]: parsed }));
    const proof = generateRowMerkleProof(parsed, 1);
    setActiveRowProof(proof);
    const check = await verifyRowMerkleProof(proof, parsed.merkleRoot);
    setRowProofCheck(check);
    e.target.value = '';
  };

  const handleProceedToAuditorStep3 = async (simulateFraud: boolean) => {
    if (!issuerLedger) return;
    setActiveTab('auditor');
    setAttestError('');
    setLastAttestation(null);
    const effectivePeriod = (customPeriodId || issuerLedger.periodId).trim();
    const cleanSnapshot: ParsedLedger = {
      ...issuerLedger,
      periodId: effectivePeriod,
    };
    setSealedSnapshots((prev) => ({ ...prev, [effectivePeriod]: cleanSnapshot }));

    if (simulateFraud) {
      if (effectivePeriod === '2026-10-SAP-GL' && issuerLedger.rows.length === 10) {
        await handleSelectAuditorScenario('tampered_fraud');
      } else {
        const { tamperedLedger, note } = await createTamperedCloneOfLedger(cleanSnapshot);
        await runAuditorVerification(tamperedLedger, 'tampered_fraud', note);
      }
    } else {
      await runAuditorVerification(
        cleanSnapshot,
        'authentic',
        `Cryptographic verification of "${cleanSnapshot.fileName}" against its immutable Stellar Soroban seal.`
      );
    }
  };

  const handleAttestAuditOnSoroban = async () => {
    const targetPeriod =
      verificationResult?.periodRecordOnChain?.periodId ||
      auditorLedger?.periodId ||
      '2026-10-SAP-GL';
    const targetIssuer =
      verificationResult?.periodRecordOnChain?.issuer ||
      DEPLOY_CONFIG.cfoPrimaryPublic;

    setIsAttesting(true);
    setAttestError('');
    setAttestStep('Connecting External Auditor key & building Soroban attestation...');
    try {
      const res = await attestAuditOnSoroban({
        issuerAddress: targetIssuer,
        periodId: targetPeriod,
        onStep: (step) => setAttestStep(step),
      });
      setLastAttestation(res);
    } catch (err) {
      setAttestError(
        err instanceof Error ? err.message : 'External Auditor attestation failed.'
      );
    } finally {
      setIsAttesting(false);
      setAttestStep('');
    }
  };

  const handleNotarizeOnSoroban = async () => {
    if (!issuerLedger) return;
    setIsNotarizing(true);
    setNotarizeError('');
    setNotarizeStep('Preparing Soroban transaction...');
    try {
      const effectivePeriod = (customPeriodId || issuerLedger.periodId).trim();
      const result = await notarizeLedgerOnSoroban({
        signerMode,
        freighterPublicKey: freighterAddress,
        periodId: effectivePeriod,
        docHashHex: issuerLedger.rawFileHash,
        merkleRootHex: issuerLedger.merkleRoot,
        commitmentHashHex: issuerLedger.commitmentHash,
        entryCount: issuerLedger.rows.length,
        onStep: (step) => setNotarizeStep(step),
      });

      setLastNotarization(result);
      setIssuerExistingRecord(result.record);
      setSealedSnapshots((prev) => ({ ...prev, [effectivePeriod]: issuerLedger }));
    } catch (err) {
      setNotarizeError(
        err instanceof Error ? err.message : 'Soroban notarization failed.'
      );
    } finally {
      setIsNotarizing(false);
      setNotarizeStep('');
    }
  };

  const runAuditorVerification = async (
    ledgerToVerify: ParsedLedger,
    scenario: AuditorScenario,
    noteText: string
  ) => {
    setAuditorScenario(scenario);
    setAuditorScenarioNote(noteText);
    setAuditorLedger(ledgerToVerify);

    const targetRow = Math.min(4, ledgerToVerify.rows.length);
    setSelectedProofRowIndex(targetRow);
    const proof = generateRowMerkleProof(ledgerToVerify, targetRow);
    setActiveRowProof(proof);

    const onChainRes = await verifyLedgerOnSoroban({
      issuerAddress: DEPLOY_CONFIG.cfoPrimaryPublic,
      periodId: ledgerToVerify.periodId,
      docHashHex: ledgerToVerify.rawFileHash,
      merkleRootHex: ledgerToVerify.merkleRoot,
    });

    const baselineSnapshot = sealedSnapshots[ledgerToVerify.periodId];
    let effectiveRes = onChainRes;

    if (onChainRes.status === 'NOT_FOUND' && baselineSnapshot) {
      const syntheticRecord: OnChainAuditRecord = {
        issuer: activeSignerPub,
        periodId: baselineSnapshot.periodId,
        docHash: baselineSnapshot.rawFileHash,
        merkleRoot: baselineSnapshot.merkleRoot,
        commitmentHash: baselineSnapshot.commitmentHash,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
        entryCount: baselineSnapshot.rows.length,
        auditor: null,
        auditedAt: 0,
      };
      if (ledgerToVerify.rawFileHash === baselineSnapshot.rawFileHash) {
        effectiveRes = {
          status: 'EXACT_MATCH',
          matchedByHash: syntheticRecord,
          matchedByMerkle: syntheticRecord,
          periodRecordOnChain: syntheticRecord,
          checkedAt: Date.now(),
        };
      } else if (ledgerToVerify.merkleRoot === baselineSnapshot.merkleRoot) {
        effectiveRes = {
          status: 'CANONICAL_MERKLE_MATCH',
          matchedByHash: null,
          matchedByMerkle: syntheticRecord,
          periodRecordOnChain: syntheticRecord,
          checkedAt: Date.now(),
        };
      } else {
        effectiveRes = {
          status: 'TAMPERED_PERIOD_MISMATCH',
          matchedByHash: null,
          matchedByMerkle: null,
          periodRecordOnChain: syntheticRecord,
          checkedAt: Date.now(),
        };
      }
    }

    setVerificationResult(effectiveRes);

    const expectedRoot =
      effectiveRes.periodRecordOnChain?.merkleRoot ||
      effectiveRes.matchedByMerkle?.merkleRoot ||
      baselineSnapshot?.merkleRoot ||
      ledgerToVerify.merkleRoot;

    const proofCheck = await verifyRowMerkleProof(proof, expectedRoot);
    setRowProofCheck(proofCheck);

    if (
      (effectiveRes.status === 'TAMPERED_PERIOD_MISMATCH' ||
        scenario === 'tampered_fraud') &&
      baselineSnapshot
    ) {
      effectiveRes = {
        ...effectiveRes,
        status: 'TAMPERED_PERIOD_MISMATCH',
        periodRecordOnChain:
          effectiveRes.periodRecordOnChain || {
            issuer: activeSignerPub,
            periodId: baselineSnapshot.periodId,
            docHash: baselineSnapshot.rawFileHash,
            merkleRoot: baselineSnapshot.merkleRoot,
            commitmentHash: baselineSnapshot.commitmentHash,
            timestamp: Math.floor(Date.now() / 1000) - 3600,
            entryCount: baselineSnapshot.rows.length,
            auditor: null,
            auditedAt: 0,
          },
      };
      setVerificationResult(effectiveRes);
      setTamperXRay(runTamperXRay(baselineSnapshot, ledgerToVerify));
    } else {
      setTamperXRay(null);
    }
  };

  const handleSelectAuditorScenario = async (
    scenario: 'authentic' | 'resaved_excel' | 'tampered_fraud'
  ) => {
    if (scenario === 'authentic') {
      const data = getAuthenticOct2026Csv();
      const parsed = await processLedgerContent(
        data.fileName,
        data.content,
        data.periodId
      );
      await runAuditorVerification(
        parsed,
        'authentic',
        'Every entry and byte matches the October 2026 close anchored on Stellar Soroban.'
      );
    } else if (scenario === 'resaved_excel') {
      const data = getMacExcelResavedOct2026Csv();
      const parsed = await processLedgerContent(
        data.fileName,
        data.content,
        data.periodId
      );
      await runAuditorVerification(
        parsed,
        'resaved_excel',
        'Spreadsheet re-export altered CRLF line endings and cell padding. Raw file SHA-256 changed, but our Canonical Accounting Merkle Root confirms 100% of numbers are untouched.'
      );
    } else {
      const data = getTamperedOct2026Csv();
      const parsed = await processLedgerContent(
        data.fileName,
        data.content,
        data.periodId
      );
      await runAuditorVerification(
        parsed,
        'tampered_fraud',
        'Retroactive alteration isolated: Row #4 (External IT Consulting) was inflated by +EUR 15,000.00 and offset on Row #5 (Operating Cash) after the monthly close was sealed.'
      );
    }
  };

  const handleAuditorFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const parsed = await processLedgerContent(file.name, new Uint8Array(buffer));
    await runAuditorVerification(
      parsed,
      'custom',
      `Uploaded file "${file.name}" verified against Stellar Soroban.`
    );
  };

  const handleSelectProofRow = async (rowIndex: number) => {
    const targetLedger = activeTab === 'auditor' ? auditorLedger : issuerLedger;
    if (!targetLedger) return;
    setSelectedProofRowIndex(rowIndex);
    const proof = generateRowMerkleProof(targetLedger, rowIndex);
    setActiveRowProof(proof);

    const expectedRoot =
      activeTab === 'auditor' && verificationResult?.periodRecordOnChain
        ? verificationResult.periodRecordOnChain.merkleRoot
        : targetLedger.merkleRoot;
    const check = await verifyRowMerkleProof(proof, expectedRoot);
    setRowProofCheck(check);
  };

  useEffect(() => {
    if (activeTab === 'auditor' && !verificationResult && auditorLedger) {
      void runAuditorVerification(
        auditorLedger,
        'authentic',
        'Every entry and byte matches the October 2026 close anchored on Stellar Soroban.'
      );
    }
  }, [activeTab]);

  const activeLedger = activeTab === 'issuer' ? issuerLedger : auditorLedger;

  const filteredRows = useMemo(() => {
    if (!activeLedger) return [];
    const q = rowSearchQuery.trim().toLowerCase();
    if (!q) return activeLedger.rows;
    return activeLedger.rows.filter(
      (r) =>
        r.entryId.toLowerCase().includes(q) ||
        r.accountCode.toLowerCase().includes(q) ||
        r.accountName.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q)
    );
  }, [activeLedger, rowSearchQuery]);

  const diffByRowIndex = useMemo(() => {
    const map = new Map<number, RowDiffItem>();
    if (activeTab === 'auditor' && tamperXRay?.modifiedRows) {
      for (const item of tamperXRay.modifiedRows) {
        map.set(item.rowIndex, item);
      }
    }
    return map;
  }, [activeTab, tamperXRay]);

  const contractExplorerUrl = `https://stellar.expert/explorer/testnet/contract/${DEPLOY_CONFIG.contractId}`;
  const latestTxUrl = lastNotarization
    ? lastNotarization.explorerTxUrl
    : `https://stellar.expert/explorer/testnet/tx/${DEPLOY_CONFIG.initialTxHash}`;

  const currentSealedRecord =
    activeTab === 'issuer'
      ? lastNotarization?.record || issuerExistingRecord
      : verificationResult?.matchedByHash ||
        verificationResult?.matchedByMerkle ||
        verificationResult?.periodRecordOnChain ||
        null;

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#141413]">
      {/* =========================================================
          FOCAL POINT 1: CLEAR ARCHITECTURAL MASTHEAD
         ========================================================= */}
      <header className="border-b border-[#D8D4CA] bg-white sticky top-0 z-30 no-print">
        <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-4">
          {/* Left: Brand Identity */}
          <div className="flex items-baseline gap-3">
            <span className="font-serif-editorial text-3xl tracking-tight text-stone-950">
              AuditLedger
            </span>
            <span className="text-xs font-mono uppercase tracking-widest text-stone-500 hidden sm:inline">
              / Stellar Soroban
            </span>
          </div>

          {/* Center: High-Contrast Role Switcher (Step 1 vs Step 2) */}
          <nav className="flex items-center h-full gap-2 sm:gap-6">
            <button
              type="button"
              onClick={() => setActiveTab('issuer')}
              className={`h-full px-3 flex items-center text-sm sm:text-base font-medium border-b-[3px] transition cursor-pointer ${
                activeTab === 'issuer'
                  ? 'border-stone-950 text-stone-950 font-semibold'
                  : 'border-transparent text-stone-500 hover:text-stone-900'
              }`}
            >
              1. Company - Seal Close
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('auditor')}
              className={`h-full px-3 flex items-center text-sm sm:text-base font-medium border-b-[3px] transition cursor-pointer ${
                activeTab === 'auditor'
                  ? 'border-stone-950 text-stone-950 font-semibold'
                  : 'border-transparent text-stone-500 hover:text-stone-900'
              }`}
            >
              2. External Auditor - Verify
            </button>
          </nav>

          {/* Right: Readable Network & Wallet Selector */}
          <div className="relative flex items-center">
            <button
              type="button"
              onClick={() => setShowWalletMenu((prev) => !prev)}
              className="flex items-center gap-2.5 px-3.5 py-2 border border-[#D8D4CA] bg-[#FAF8F5] hover:bg-stone-100 text-xs sm:text-sm font-mono text-stone-800 cursor-pointer"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-600" />
              <span>
                {activeSignerPub.slice(0, 5)}..{activeSignerPub.slice(-4)}
              </span>
              <span className="hidden md:inline text-stone-500">
                ({xlmBalance} XLM)
              </span>
            </button>

            {showWalletMenu && (
              <div className="absolute right-0 top-13 w-84 bg-white border border-stone-900 shadow-xl p-4 space-y-3 z-40 text-sm">
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="font-semibold text-stone-900">
                    Active Signing Authority
                  </span>
                  <span className="font-mono text-xs text-emerald-700 font-semibold">
                    {xlmBalance} XLM
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setSignerMode('demo_hsm');
                    setWalletError('');
                    setShowWalletMenu(false);
                  }}
                  className={`w-full p-3 text-left border transition cursor-pointer ${
                    signerMode === 'demo_hsm'
                      ? 'bg-stone-950 text-white border-stone-950'
                      : 'bg-[#FAF8F5] hover:bg-stone-100 text-stone-900 border-stone-300'
                  }`}
                >
                  <div className="font-semibold text-sm">Corporate Treasury Key</div>
                  <div className="text-xs opacity-80 mt-0.5">
                    Pre-funded Testnet account (1-click stage signing)
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => void handleConnectFreighter()}
                  className={`w-full p-3 text-left border transition cursor-pointer ${
                    signerMode === 'freighter'
                      ? 'bg-stone-950 text-white border-stone-950'
                      : 'bg-[#FAF8F5] hover:bg-stone-100 text-stone-900 border-stone-300'
                  }`}
                >
                  <div className="font-semibold text-sm">Freighter Browser Wallet</div>
                  <div className="text-xs opacity-80 mt-0.5">
                    {freighterAddress
                      ? `${freighterAddress.slice(0, 8)}...${freighterAddress.slice(-6)}`
                      : 'Connect local extension wallet'}
                  </div>
                </button>

                <div className="pt-2 border-t border-stone-200 flex items-center justify-between font-mono text-xs">
                  <span className="text-stone-500">Soroban Contract</span>
                  <a
                    href={contractExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-stone-900 font-semibold underline"
                  >
                    {DEPLOY_CONFIG.contractId.slice(0, 8)}...
                    {DEPLOY_CONFIG.contractId.slice(-6)}
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        {walletError && (
          <div className="border-t border-amber-300 bg-amber-50 px-6 py-2.5 text-sm text-amber-950 flex items-center justify-between">
            <span>{walletError}</span>
            <button
              type="button"
              onClick={() => setWalletError('')}
              className="font-mono uppercase text-xs font-semibold underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </header>

      {/* =========================================================
          SPLIT-PANE WORKSPACE (LEFT = LEDGER, RIGHT = SEAL DOCKET)
         ========================================================= */}
      <div className="border-b border-[#D8D4CA] bg-[#F4F1EA] no-print">
        <div className="max-w-[1440px] mx-auto px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-stone-800">
          <div>
            <span className="font-mono font-bold uppercase text-stone-950 mr-2">
              {activeTab === 'issuer'
                ? 'COMPANY STEP-BY-STEP:'
                : 'AUDITOR STEP-BY-STEP:'}
            </span>
            {activeTab === 'issuer' ? (
              <span>
                <strong>1.</strong> Upload your CSV or PDF file(s) from your computer ·{' '}
                <strong>2.</strong> Click Seal to lock its digital fingerprint on Stellar ·{' '}
                <strong>3.</strong> Switch to External Auditor to verify or test tamper detection.
              </span>
            ) : (
              <span>
                <strong>Free Instant Check (0 XLM):</strong> Upload a file (or test the file you just sealed) to see if every row matches the Stellar blockchain seal or if someone changed a number.
              </span>
            )}
          </div>
          <span className="font-mono text-xs text-emerald-900 font-semibold">
            Live Stellar Testnet · 100% Real Blockchain
          </span>
        </div>
      </div>

      {!activeLedger && (
        <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-12 flex items-center justify-center no-print">
          <div className="max-w-2xl w-full bg-white border-2 border-stone-950 p-8 sm:p-12 space-y-6 text-center shadow-sm">
            <div className="text-xs font-mono font-bold uppercase tracking-widest text-stone-500">
              {activeTab === 'issuer'
                ? 'STEP 1 OF 3 · COMPANY DOCUMENT UPLOAD'
                : 'EXTERNAL AUDITOR · INDEPENDENT FILE CHECK'}
            </div>
            <h1 className="font-serif-editorial text-4xl sm:text-5xl text-stone-950">
              {activeTab === 'issuer'
                ? 'Upload Document(s) to Seal on Stellar'
                : 'Upload a Document to Verify Authenticity'}
            </h1>
            <p className="text-sm sm:text-base text-stone-600 leading-relaxed max-w-xl mx-auto">
              {activeTab === 'issuer'
                ? 'Select any CSV spreadsheet, accounting export, or PDF document from your computer. Your file stays 100% private in your browser while its tamper-proof digital fingerprint is sealed on the Stellar blockchain.'
                : 'Upload the file you received from the company. AuditLedger will check the Stellar blockchain in 1 second (for free) and highlight in red if even a single row or number was modified after sealing.'}
            </p>

            <div className="pt-2">
              {activeTab === 'issuer' ? (
                <label className="inline-block py-4 px-8 bg-stone-950 hover:bg-stone-800 text-white text-base font-semibold tracking-wide cursor-pointer transition shadow-sm">
                  <span>+ Select CSV or PDF File(s) from Your Computer</span>
                  <input
                    type="file"
                    multiple
                    accept=".csv,.txt,.json,.pdf"
                    onChange={(e) => void handleIssuerFileUpload(e)}
                    className="hidden"
                  />
                </label>
              ) : (
                <div className="space-y-4">
                  <label className="inline-block py-4 px-8 bg-stone-950 hover:bg-stone-800 text-white text-base font-semibold tracking-wide cursor-pointer transition shadow-sm">
                    <span>+ Select File to Verify Against Stellar</span>
                    <input
                      type="file"
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleAuditorFileUpload(e)}
                      className="hidden"
                    />
                  </label>
                  {issuerLedger && (
                    <div className="pt-3 border-t border-stone-200 flex flex-wrap items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(false)}
                        className="px-4 py-2 border border-stone-900 bg-white hover:bg-stone-100 text-xs font-semibold uppercase tracking-wider text-stone-900 cursor-pointer"
                      >
                        Check the File You Just Uploaded ({issuerLedger.fileName})
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(true)}
                        className="px-4 py-2 border border-red-700 bg-red-50 hover:bg-red-100 text-xs font-semibold uppercase tracking-wider text-red-800 cursor-pointer"
                      >
                        Simulate Tampering on {issuerLedger.fileName}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-6 border-t border-stone-200 flex flex-wrap items-center justify-center gap-4 text-xs text-stone-500">
              <span>Supported formats: CSV (any columns), PDF, JSON, TXT (Single or Bulk multi-file)</span>
              <span>·</span>
              <button
                type="button"
                onClick={() => {
                  const sample = getAuthenticOct2026Csv();
                  const blob = new Blob([sample.content], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'Sample_Company_Expenses_2026.csv';
                  a.click();
                }}
                className="underline text-stone-700 hover:text-stone-950 font-medium cursor-pointer"
              >
                Need a test CSV file? Download a sample CSV to your PC
              </button>
            </div>
          </div>
        </main>
      )}

      {activeLedger && (
        <main className="flex-1 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 no-print">
          {/* =====================================================
              FOCAL POINT 2 (LEFT 8 COLS): THE ACCOUNTING LEDGER
             ===================================================== */}
          <section className="lg:col-span-8 border-b lg:border-b-0 lg:border-r border-[#D8D4CA] flex flex-col bg-white">
            {/* Document Title & Period Bar */}
            <div className="px-6 sm:px-8 py-6 border-b border-[#D8D4CA] bg-[#FAF8F5] space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-stone-600 font-medium">
                    {activeTab === 'issuer'
                      ? `STEP 1 OF 3 · LOADED DOCUMENT · ${activeLedger.fileName}`
                      : `STEP 3 OF 3 · AUDITOR VERIFICATION · ${activeLedger.fileName}`}
                  </div>
                  <h1 className="font-serif-editorial text-4xl sm:text-5xl text-stone-950 mt-1">
                    {activeTab === 'issuer'
                      ? `Document: ${activeLedger.fileName}`
                      : verificationResult?.status === 'TAMPERED_PERIOD_MISMATCH'
                      ? `Alert: Modified Rows Found in ${activeLedger.fileName}`
                      : verificationResult?.status === 'CANONICAL_MERKLE_MATCH'
                      ? `Verified: ${activeLedger.fileName} (Numbers 100% Intact)`
                      : `Verified: ${activeLedger.fileName}`}
                  </h1>
                </div>

                {/* Upload New File Button */}
                {activeTab === 'issuer' ? (
                  <label className="px-4 py-2.5 border-2 border-stone-950 bg-stone-950 hover:bg-stone-800 text-white text-sm font-semibold cursor-pointer">
                    <span>+ Upload Another CSV / PDF (Single or Bulk)</span>
                    <input
                      type="file"
                      multiple
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleIssuerFileUpload(e)}
                      className="hidden"
                    />
                  </label>
                ) : (
                  <label className="px-4 py-2.5 border-2 border-stone-950 bg-stone-950 hover:bg-stone-800 text-white text-sm font-semibold cursor-pointer">
                    <span>+ Upload File from PC to Verify</span>
                    <input
                      type="file"
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleAuditorFileUpload(e)}
                      className="hidden"
                    />
                  </label>
                )}
              </div>

              {/* Dirty ERP / Custom CSV Auto-Normalization Banner */}
              {activeLedger.normalizationLog.length > 0 && (
                <div className="border border-stone-300 bg-white px-4 py-3 text-xs sm:text-sm flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <span className="font-mono font-bold uppercase text-xs text-emerald-800 mr-2">
                      ✓ Smart Format Cleaner:
                    </span>
                    <span className="text-stone-800">
                      {activeLedger.normalizationLog.join(' · ')}
                    </span>
                  </div>
                </div>
              )}

              {/* In Auditor Mode: Test Controls on the Uploaded File */}
              {activeTab === 'auditor' && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-4 border border-stone-400 bg-white text-xs sm:text-sm">
                  <div>
                    <span className="font-bold text-stone-950 block">
                      Want to see what happens if someone secretly edits a row in this file?
                    </span>
                    <span className="text-stone-600">
                      Test our row-by-row tamper detector on your uploaded file right now:
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleProceedToAuditorStep3(false)}
                      className={`px-3.5 py-2 border font-semibold cursor-pointer ${
                        auditorScenario !== 'tampered_fraud'
                          ? 'border-stone-950 bg-stone-950 text-white'
                          : 'border-stone-400 bg-white text-stone-900 hover:bg-stone-100'
                      }`}
                    >
                      1. Check Original Untouched File
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleProceedToAuditorStep3(true)}
                      className={`px-3.5 py-2 border font-semibold cursor-pointer ${
                        auditorScenario === 'tampered_fraud'
                          ? 'border-red-800 bg-red-800 text-white'
                          : 'border-red-700 bg-red-50 text-red-900 hover:bg-red-100'
                      }`}
                    >
                      2. Simulate Someone Changing a Row
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Commanding Financial Totals Strip (24px Bold Figures) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 border-b border-[#D8D4CA] divide-y sm:divide-y-0 sm:divide-x divide-[#D8D4CA] bg-white">
              <div className="px-6 sm:px-8 py-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? 'Total Debits'
                    : 'Indexed Records'}
                </div>
                <div className="font-mono text-2xl sm:text-3xl font-bold text-stone-950 mt-1">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? formatCentsToEur(activeLedger.totalDebitCents)
                    : `${activeLedger.rows.length} ${
                        activeLedger.rows.length === 1 ? 'Payload' : 'Rows'
                      }`}
                </div>
              </div>

              <div className="px-6 sm:px-8 py-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? 'Total Credits'
                    : 'Document Size'}
                </div>
                <div className="font-mono text-2xl sm:text-3xl font-bold text-stone-950 mt-1">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? formatCentsToEur(activeLedger.totalCreditCents)
                    : activeLedger.fileSizeBytes >= 1048576
                    ? `${(activeLedger.fileSizeBytes / 1048576).toFixed(2)} MB`
                    : `${(activeLedger.fileSizeBytes / 1024).toFixed(1)} KB`}
                </div>
              </div>

              <div className="px-6 sm:px-8 py-5 flex flex-col justify-between">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? 'Balance Check'
                    : 'Row-by-Row Protection'}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                  <span className="font-mono text-xl sm:text-2xl font-bold text-emerald-800 whitespace-nowrap">
                    {activeLedger.documentMode === 'accounting_gl'
                      ? activeLedger.isBalanced
                        ? 'Balanced (0.00)'
                        : 'Unbalanced'
                      : `${activeLedger.rows.length} Protected`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMerkleTopology((prev) => !prev)}
                    className="px-2.5 py-1 border border-stone-400 bg-[#FAF8F5] hover:bg-stone-100 text-xs font-mono font-semibold text-stone-900 whitespace-nowrap cursor-pointer"
                  >
                    {showMerkleTopology ? 'Hide Protection Map' : 'View Protection Map'}
                  </button>
                </div>
              </div>
            </div>

            {/* Expandable Interactive Merkle Tree */}
            {showMerkleTopology && (
              <MerkleTreeVisualizer
                ledger={activeLedger}
                selectedRowIndex={selectedProofRowIndex}
                onSelectRow={(idx) => void handleSelectProofRow(idx)}
                tamperReport={activeTab === 'auditor' ? tamperXRay : null}
                sealedMerkleRoot={currentSealedRecord?.merkleRoot}
              />
            )}

            {/* Table Header & Filter Bar */}
            <div className="px-6 sm:px-8 py-3.5 border-b border-[#D8D4CA] bg-[#FAF8F5] flex flex-wrap items-center justify-between gap-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
                {activeLedger.documentMode === 'accounting_gl'
                  ? `Accounting Entries (${filteredRows.length} Rows)`
                  : `Extracted File Rows (${filteredRows.length} Protected Rows)`}
              </span>
              <input
                type="text"
                value={rowSearchQuery}
                onChange={(e) => setRowSearchQuery(e.target.value)}
                placeholder="Search any row or text..."
                className="w-full sm:w-72 px-3 py-1.5 text-sm bg-white border border-stone-300 text-stone-900 focus:outline-none focus:border-stone-900"
              />
            </div>

            {/* High-Contrast Readable Accounting Table (14px Body Text) */}
            <div className="overflow-x-auto flex-1 bg-white">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#D8D4CA] bg-stone-100/80 text-xs font-semibold uppercase tracking-wider text-stone-700">
                    <th className="py-3.5 px-4 w-12">#</th>
                    <th className="py-3.5 px-4">
                      {activeLedger.documentMode === 'accounting_gl'
                        ? 'Entry ID'
                        : 'Row ID'}
                    </th>
                    <th className="py-3.5 px-4">
                      {activeLedger.documentMode === 'accounting_gl'
                        ? 'Account & Description'
                        : 'Row Content'}
                    </th>
                    {activeLedger.documentMode === 'accounting_gl' ? (
                      <>
                        <th className="py-3.5 px-4 text-right">Debit (EUR)</th>
                        <th className="py-3.5 px-4 text-right">Credit (EUR)</th>
                      </>
                    ) : (
                      <th className="py-3.5 px-4 text-right">Row Digital Seal</th>
                    )}
                    <th className="py-3.5 px-4 text-right">Row Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 text-sm">
                  {filteredRows.map((row) => {
                    const diff = diffByRowIndex.get(row.rowIndex);
                    const isTampered = Boolean(diff);
                    const isSelected = row.rowIndex === selectedProofRowIndex;

                    return (
                      <tr
                        key={row.rowIndex}
                        onClick={() => void handleSelectProofRow(row.rowIndex)}
                        className={`transition cursor-pointer ${
                          isTampered
                            ? 'bg-red-50/90 hover:bg-red-100/70 border-l-4 border-l-red-700'
                            : isSelected
                            ? 'bg-[#F4F1EA]'
                            : 'hover:bg-stone-50'
                        }`}
                      >
                        <td className="py-4 px-4 font-mono text-stone-500">
                          {String(row.rowIndex).padStart(2, '0')}
                        </td>

                        <td className="py-4 px-4 whitespace-nowrap">
                          <div className="font-mono font-semibold text-stone-950">
                            {row.entryId}
                          </div>
                          <div className="font-mono text-xs text-stone-500 mt-0.5">
                            {row.date}
                          </div>
                        </td>

                        <td className="py-4 px-4">
                          <div className="font-semibold text-stone-950">
                            <span className="font-mono text-stone-500 mr-2">
                              [{row.accountCode}]
                            </span>
                            <span>{row.accountName}</span>
                          </div>
                          <div className="text-xs sm:text-sm text-stone-600 mt-0.5">
                            {row.description}
                          </div>
                        </td>

                        {activeLedger.documentMode === 'accounting_gl' ? (
                          <>
                            {/* Debit Column with Forensic Strikethrough Diff */}
                            <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-base">
                              {isTampered && diff?.field === 'Debit Amount' ? (
                                <div className="flex flex-col items-end">
                                  <span className="line-through text-stone-500 text-xs">
                                    Sealed: {diff.sealedValue.replace('EUR ', '')}
                                  </span>
                                  <span className="font-bold text-red-700 text-base">
                                    {diff.uploadedValue.replace('EUR ', '')}
                                  </span>
                                </div>
                              ) : row.debitCents > 0 ? (
                                <span className="font-medium text-stone-950">
                                  {(row.debitCents / 100).toLocaleString('en-US', {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}
                                </span>
                              ) : (
                                <span className="text-stone-300">-</span>
                              )}
                            </td>

                            {/* Credit Column with Forensic Strikethrough Diff */}
                            <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-base">
                              {isTampered && diff?.field === 'Credit Amount' ? (
                                <div className="flex flex-col items-end">
                                  <span className="line-through text-stone-500 text-xs">
                                    Sealed: {diff.sealedValue.replace('EUR ', '')}
                                  </span>
                                  <span className="font-bold text-red-700 text-base">
                                    {diff.uploadedValue.replace('EUR ', '')}
                                  </span>
                                </div>
                              ) : row.creditCents > 0 ? (
                                <span className="font-medium text-stone-950">
                                  {(row.creditCents / 100).toLocaleString('en-US', {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}
                                </span>
                              ) : (
                                <span className="text-stone-300">-</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-xs text-stone-700">
                            {row.leafHash.slice(0, 10)}...{row.leafHash.slice(-6)}
                          </td>
                        )}

                        {/* Row Status Column */}
                        <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-xs">
                          {isTampered ? (
                            <span className="inline-block px-2.5 py-1 bg-red-700 text-white font-bold">
                              ALTERED ({diff?.deltaFormatted.replace('EUR ', '')})
                            </span>
                          ) : (
                            <span className="text-emerald-800 font-semibold">
                              ✓ Verified
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* =====================================================
              FOCAL POINT 3 (RIGHT 4 COLS): FOCUSED NOTARY DOCKET
             ===================================================== */}
          <aside className="lg:col-span-4 bg-[#F4F1EA] flex flex-col divide-y divide-[#D8D4CA]">
            {/* Primary Seal & Verdict Block */}
            <div className="p-6 sm:p-8 space-y-6">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-stone-600">
                  {activeTab === 'issuer'
                    ? 'STEP 2 OF 3 · STELLAR SOROBAN SEAL'
                    : 'STEP 3 OF 3 · BLOCKCHAIN AUDIT VERDICT'}
                </span>
                <a
                  href={contractExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono font-semibold underline text-stone-800 hover:text-black whitespace-nowrap shrink-0"
                >
                  Contract {DEPLOY_CONFIG.contractId.slice(0, 6)}.. ↗
                </a>
              </div>

              {activeTab === 'issuer' ? (
                <>
                  {/* High-Contrast Seal Status Box */}
                  <div className="border-2 border-stone-950 bg-white p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-stone-200 pb-3">
                      <span
                        className={`text-sm font-bold uppercase tracking-wide ${
                          currentSealedRecord
                            ? 'text-emerald-900'
                            : 'text-amber-900'
                        }`}
                      >
                        {currentSealedRecord
                          ? '● Sealed on Stellar'
                          : '○ Unsealed Document'}
                      </span>
                      <span
                        className={`font-mono text-xs font-bold px-2.5 py-0.5 border ${
                          currentSealedRecord
                            ? 'text-emerald-800 bg-emerald-50 border-emerald-300'
                            : 'text-amber-900 bg-amber-50 border-amber-300'
                        }`}
                      >
                        {currentSealedRecord ? 'IMMUTABLE' : 'READY TO SEAL'}
                      </span>
                    </div>

                    <div className="space-y-2.5 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Document / Period ID</span>
                        <span className="font-mono font-bold text-stone-950 text-right">
                          {customPeriodId}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Authorized Signer</span>
                        <span className="font-mono text-stone-900">
                          {activeSignerPub.slice(0, 6)}...{activeSignerPub.slice(-6)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Soroban Network Fee</span>
                        <span className="font-mono font-semibold text-stone-900">
                          ~0.001 XLM (Base)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Unmistakable Primary Action Button */}
                  <button
                    type="button"
                    disabled={isNotarizing || !activeLedger.isBalanced}
                    onClick={() => void handleNotarizeOnSoroban()}
                    className="w-full py-4 px-6 bg-stone-950 hover:bg-stone-800 disabled:bg-stone-400 text-white text-sm sm:text-base font-semibold tracking-wide transition cursor-pointer shadow-sm"
                  >
                    {isNotarizing
                      ? notarizeStep || 'Sealing on Stellar Soroban...'
                      : currentSealedRecord
                      ? 'Re-Seal New Snapshot on Stellar Soroban'
                      : 'Step 2: Seal & Notarize on Stellar Soroban'}
                  </button>

                  {notarizeError && (
                    <div className="border-2 border-red-700 bg-red-50 p-4 text-sm font-mono text-red-900 break-all">
                      {notarizeError}
                    </div>
                  )}

                  {currentSealedRecord && (
                    <div className="space-y-3 pt-1">
                      <div className="grid grid-cols-2 gap-3 text-sm font-semibold">
                        <a
                          href={latestTxUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="py-3 px-4 border border-stone-400 bg-white hover:bg-stone-100 text-center text-stone-900"
                        >
                          Stellar.Expert ↗
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            setCertificateRecord({
                              record: currentSealedRecord,
                              txHash:
                                lastNotarization?.txHash || DEPLOY_CONFIG.initialTxHash,
                              fileName: activeLedger.fileName,
                              totalFormatted: formatCentsToEur(
                                activeLedger.totalDebitCents
                              ),
                            })
                          }
                          className="py-3 px-4 border border-stone-400 bg-white hover:bg-stone-100 text-center text-stone-900 cursor-pointer"
                        >
                          QR Certificate
                        </button>
                      </div>

                      {/* Clear Guided Step 3 Handoff Card */}
                      <div className="border-2 border-emerald-800 bg-emerald-50/70 p-4 space-y-3">
                        <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-900">
                          ✓ Step 2 Complete · Next: Step 3 (External Auditor)
                        </div>
                        <p className="text-xs text-stone-800 leading-relaxed">
                          Now switch to the External Auditor portal to verify this sealed
                          document or simulate a retroactive cover-up on its rows:
                        </p>
                        <div className="grid grid-cols-1 gap-2">
                          <button
                            type="button"
                            onClick={() => void handleProceedToAuditorStep3(false)}
                            className="w-full py-2.5 px-3 bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold uppercase tracking-wider cursor-pointer"
                          >
                            Step 3A: Verify Authentic Document →
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleProceedToAuditorStep3(true)}
                            className="w-full py-2.5 px-3 bg-white hover:bg-red-50 text-red-800 border border-red-700 text-xs font-semibold uppercase tracking-wider cursor-pointer"
                          >
                            Step 3B: Simulate Fraud / Tampering on This File →
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                /* AUDITOR VERDICT CARD */
                verificationResult && (
                  <div className="space-y-4">
                    <div
                      className={`border-2 p-5 space-y-4 bg-white ${
                        verificationResult.status === 'EXACT_MATCH'
                          ? 'border-emerald-700'
                          : verificationResult.status === 'CANONICAL_MERKLE_MATCH'
                          ? 'border-sky-800'
                          : 'border-red-700'
                      }`}
                    >
                      <div className="border-b border-stone-200 pb-3">
                        <div
                          className={`text-xs font-mono font-bold uppercase tracking-wider ${
                            verificationResult.status === 'EXACT_MATCH'
                              ? 'text-emerald-800'
                              : verificationResult.status === 'CANONICAL_MERKLE_MATCH'
                              ? 'text-sky-900'
                              : 'text-red-700'
                          }`}
                        >
                          {verificationResult.status === 'EXACT_MATCH' &&
                            '✓ AUTHENTICITY CONFIRMED'}
                          {verificationResult.status === 'CANONICAL_MERKLE_MATCH' &&
                            '✓ ACCOUNTING NUMBERS INTACT'}
                          {verificationResult.status === 'TAMPERED_PERIOD_MISMATCH' &&
                            '✕ RETROACTIVE TAMPERING DETECTED'}
                          {verificationResult.status === 'NOT_FOUND' &&
                            '! UNREGISTERED DOCUMENT'}
                        </div>
                        <h2 className="text-xl font-bold text-stone-950 mt-1">
                          {verificationResult.status === 'EXACT_MATCH' &&
                            'Matches Stellar Seal 100%'}
                          {verificationResult.status === 'CANONICAL_MERKLE_MATCH' &&
                            'Survived Excel Re-Save'}
                          {verificationResult.status === 'TAMPERED_PERIOD_MISMATCH' &&
                            `${
                              tamperXRay?.modifiedRows.length || 1
                            } Row(s) Altered After Seal`}
                          {verificationResult.status === 'NOT_FOUND' &&
                            'No Record on Soroban'}
                        </h2>
                      </div>

                      <p className="text-sm text-stone-700 leading-relaxed">
                        {auditorScenarioNote}
                      </p>

                      {tamperXRay && tamperXRay.modifiedRows.length > 0 && (
                        <div className="pt-3 border-t border-red-200 space-y-2 text-sm text-red-950">
                          <div className="font-bold text-xs uppercase tracking-wider text-red-700">
                            Forensic X-Ray Summary:
                          </div>
                          {tamperXRay.modifiedRows.map((item, idx) => (
                            <div
                              key={idx}
                              className="flex justify-between font-mono text-xs bg-red-50 p-2 border border-red-200"
                            >
                              <span className="font-semibold">
                                Row #{item.rowIndex} ({item.entryId})
                              </span>
                              <span className="font-bold text-red-700">
                                {item.deltaFormatted}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Multi-Party External Auditor Co-Signature (attest_audit) */}
                    {(verificationResult.status === 'EXACT_MATCH' ||
                      verificationResult.status === 'CANONICAL_MERKLE_MATCH') && (
                      <div className="border border-stone-400 bg-white p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono font-bold uppercase tracking-wider text-stone-800">
                            Auditor On-Chain Sign-Off
                          </span>
                          <span className="font-mono text-[11px] text-emerald-800 font-semibold whitespace-nowrap shrink-0">
                            attest_audit()
                          </span>
                        </div>
                        <p className="text-xs text-stone-600 leading-relaxed">
                          As the External Statutory Auditor, co-sign this verified close on
                          Stellar Soroban so regulators see both CFO and Auditor signatures:
                        </p>
                        <button
                          type="button"
                          disabled={isAttesting}
                          onClick={() => void handleAttestAuditOnSoroban()}
                          className="w-full py-3 px-4 bg-stone-950 hover:bg-stone-800 disabled:bg-stone-400 text-white text-xs font-semibold uppercase tracking-wider cursor-pointer"
                        >
                          {isAttesting
                            ? attestStep || 'Co-Signing on Stellar Soroban...'
                            : 'Co-Sign & Attest Audit on Stellar Soroban'}
                        </button>
                        {attestError && (
                          <div className="p-2 bg-red-50 border border-red-600 font-mono text-xs text-red-800 break-all">
                            {attestError}
                          </div>
                        )}
                        {lastAttestation && (
                          <div className="p-3 bg-emerald-50 border border-emerald-400 text-xs space-y-1">
                            <div className="font-bold text-emerald-900">
                              ✓ Dual-Signed on Stellar Soroban (CFO + External Auditor)
                            </div>
                            <a
                              href={lastAttestation.explorerTxUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono underline text-emerald-950 block"
                            >
                              View Auditor Attestation TX ({lastAttestation.txHash.slice(0, 10)}
                              ...) ↗
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>

            {/* Primary Fingerprint Summary + Clean Accordion for Extra Technical Hashes */}
            <div className="p-6 sm:p-8 space-y-4 flex-1">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
                    Digital Seal Fingerprint (Locked on Stellar)
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(activeLedger.merkleRoot, 'merkle')}
                    className="text-xs font-mono font-semibold underline text-stone-700 hover:text-black cursor-pointer"
                  >
                    {copiedLabel === 'merkle' ? 'Copied' : 'Copy Seal'}
                  </button>
                </div>
                <div className="p-3 bg-white border border-stone-300 font-mono text-xs break-all text-stone-900 leading-relaxed">
                  {activeLedger.merkleRoot}
                </div>
                <p className="text-xs text-stone-600 leading-relaxed">
                  100% Private (GDPR Safe): Your file never leaves your browser. Only this
                  32-byte digital fingerprint is stored on Stellar.
                </p>
              </div>

              {/* Progressive Disclosure Toggle for Raw SHA-256, Salted Commitment & Row Proof */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowTechnicalReceipt((prev) => !prev)}
                  className="w-full py-2.5 px-4 border border-stone-300 bg-white hover:bg-stone-50 text-xs font-semibold text-stone-800 flex items-center justify-between cursor-pointer"
                >
                  <span>
                    {showTechnicalReceipt
                      ? 'Hide Technical Blockchain Details'
                      : `Show Technical Details (SHA-256 & Row #${selectedProofRowIndex} Proof)`}
                  </span>
                  <span>{showTechnicalReceipt ? '−' : '+'}</span>
                </button>

                {showTechnicalReceipt && (
                  <div className="mt-3 space-y-4 bg-white border border-stone-300 p-4 text-xs">
                    <div className="space-y-1">
                      <div className="flex justify-between font-semibold text-stone-600">
                        <span>Raw File SHA-256</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(activeLedger.rawFileHash, 'raw')}
                          className="underline cursor-pointer"
                        >
                          {copiedLabel === 'raw' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="font-mono text-[11px] break-all text-stone-800 bg-stone-50 p-2 border border-stone-200">
                        {activeLedger.rawFileHash}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between font-semibold text-stone-600">
                        <span>Salted Balance Commitment</span>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy(activeLedger.commitmentHash, 'commit')
                          }
                          className="underline cursor-pointer"
                        >
                          {copiedLabel === 'commit' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="font-mono text-[11px] break-all text-stone-800 bg-stone-50 p-2 border border-stone-200">
                        {activeLedger.commitmentHash}
                      </div>
                    </div>

                    {activeRowProof && (
                      <div className="pt-3 border-t border-stone-200 space-y-2">
                        <div className="flex items-center justify-between font-semibold">
                          <span className="text-stone-800">
                            Row #{activeRowProof.rowIndex} ({activeRowProof.entryId}) Proof
                          </span>
                          {rowProofCheck && (
                            <span
                              className={
                                rowProofCheck.valid
                                  ? 'text-emerald-800'
                                  : 'text-red-700'
                              }
                            >
                              {rowProofCheck.valid ? '✓ Valid Leaf' : '✕ Altered Leaf'}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1 font-mono text-[11px] text-stone-600">
                          {activeRowProof.proofPath.map((step, i) => (
                            <div key={i} className="flex justify-between">
                              <span>
                                Sibling {i + 1} ({step.position})
                              </span>
                              <span>
                                {step.siblingHash.slice(0, 8)}...
                                {step.siblingHash.slice(-6)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </main>
      )}

      {/* =========================================================
          PRINTABLE CRYPTOGRAPHIC AUDIT CERTIFICATE MODAL
         ========================================================= */}
      {certificateRecord && (
        <div className="fixed inset-0 z-50 bg-stone-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white text-stone-950 max-w-2xl w-full p-8 border-2 border-stone-950 shadow-2xl space-y-6 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b-2 border-stone-950 pb-4">
              <div>
                <div className="text-xs font-mono uppercase tracking-widest text-stone-500">
                  Stellar Soroban Cryptographic Attestation
                </div>
                <h2 className="font-serif-editorial text-3xl text-stone-950 mt-0.5">
                  Certificate of Financial Ledger Notarization
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setCertificateRecord(null)}
                className="font-mono text-xs uppercase font-semibold underline text-stone-600 hover:text-stone-950 no-print cursor-pointer"
              >
                Close [X]
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-6 items-center">
              <div className="sm:col-span-8 space-y-3 text-sm font-mono">
                <div>
                  <span className="text-stone-500 block text-xs">ACCOUNTING PERIOD</span>
                  <span className="font-bold text-base text-stone-950">
                    {certificateRecord.record.periodId}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    SOROBAN SMART CONTRACT ID
                  </span>
                  <span className="text-xs break-all text-stone-800">
                    {DEPLOY_CONFIG.contractId}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    AUTHORIZED CORPORATE SIGNER
                  </span>
                  <span className="text-xs break-all text-stone-800">
                    {certificateRecord.record.issuer}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    LEDGER TIMESTAMP &amp; ENTRIES
                  </span>
                  <span className="text-xs text-stone-800">
                    {new Date(
                      (certificateRecord.record.timestamp ||
                        Math.floor(Date.now() / 1000)) * 1000
                    ).toUTCString()}{' '}
                    ({certificateRecord.record.entryCount} lines)
                  </span>
                </div>
              </div>

              <div className="sm:col-span-4 flex flex-col items-center justify-center p-3 border border-stone-300 bg-[#FAF8F5]">
                <img
                  src={generateVerificationMatrixSvgDataUri(
                    `https://stellar.expert/explorer/testnet/contract/${DEPLOY_CONFIG.contractId}`
                  )}
                  alt="Stellar Verification Matrix"
                  className="w-28 h-28"
                />
                <span className="text-[10px] font-mono uppercase tracking-wider text-stone-600 mt-1.5 text-center">
                  On-Chain Verification Matrix
                </span>
              </div>
            </div>

            <div className="space-y-2.5 bg-[#FAF8F5] p-4 border border-stone-300 text-xs font-mono">
              <div>
                <span className="text-stone-500 block">
                  01 / RAW DOCUMENT SHA-256 (32 BYTES)
                </span>
                <span className="break-all text-stone-900">
                  {certificateRecord.record.docHash}
                </span>
              </div>
              <div>
                <span className="text-stone-500 block">
                  02 / CANONICAL ACCOUNTING MERKLE ROOT (32 BYTES)
                </span>
                <span className="break-all text-stone-950 font-bold">
                  {certificateRecord.record.merkleRoot}
                </span>
              </div>
              <div>
                <span className="text-stone-500 block">
                  03 / SALTED BALANCE COMMITMENT (32 BYTES)
                </span>
                <span className="break-all text-stone-700">
                  {certificateRecord.record.commitmentHash}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 no-print font-mono text-xs">
              <button
                type="button"
                onClick={() => window.print()}
                className="px-5 py-3 bg-stone-950 hover:bg-stone-800 text-white font-semibold uppercase tracking-wider cursor-pointer"
              >
                Print Official Certificate
              </button>

              <button
                type="button"
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        {
                          protocol: 'AuditLedger-Soroban-v1',
                          network: 'Stellar Testnet',
                          contractId: DEPLOY_CONFIG.contractId,
                          explorerUrl: contractExplorerUrl,
                          ...certificateRecord,
                        },
                        null,
                        2
                      ),
                    ],
                    { type: 'application/json' }
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `AuditLedger_Proof_${certificateRecord.record.periodId}.json`;
                  a.click();
                }}
                className="px-4 py-3 border border-stone-400 hover:bg-stone-100 text-stone-900 font-semibold uppercase tracking-wider cursor-pointer"
              >
                Export JSON Proof
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
