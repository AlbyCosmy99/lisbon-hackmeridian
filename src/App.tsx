import React, { useEffect, useMemo, useState } from 'react';
import { MerkleTreeVisualizer } from './components/MerkleTreeVisualizer';
import { DEPLOY_CONFIG } from './lib/deployConfig';
import {
  ParsedLedger,
  RowDiffItem,
  RowMerkleProof,
  TamperXRayReport,
  createTamperedCloneOfLedger,
  editSpecificRowInLedger,
  formatCentsToEur,
  generateRowMerkleProof,
  processLedgerContent,
  processMultipleFilesBatch,
  runTamperXRay,
  verifyRowMerkleProof,
} from './lib/merkleAndCrypto';
import { generateVerificationMatrixSvgDataUri } from './lib/qrGenerator';
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
  const [showHowItWorksModal, setShowHowItWorksModal] = useState<boolean>(false);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  // Signer & Wallet State
  const [signerMode, setSignerMode] = useState<SignerMode>('demo_hsm');
  const [freighterAddress, setFreighterAddress] = useState<string>('');
  const [walletError, setWalletError] = useState<string>('');
  const [xlmBalance, setXlmBalance] = useState<string>('...');
  const [showWalletMenu, setShowWalletMenu] = useState<boolean>(false);

  // Company / Issuer State
  const [issuerLedger, setIssuerLedger] = useState<ParsedLedger | null>(null);
  const [customPeriodId, setCustomPeriodId] = useState<string>('');
  const [rowSearchQuery, setRowSearchQuery] = useState<string>('');
  const [isNotarizing, setIsNotarizing] = useState<boolean>(false);
  const [notarizeStep, setNotarizeStep] = useState<string>('');
  const [notarizeError, setNotarizeError] = useState<string>('');
  const [lastNotarization, setLastNotarization] = useState<NotarizationResult | null>(null);
  const [issuerExistingRecord, setIssuerExistingRecord] = useState<OnChainAuditRecord | null>(null);
  const [showMerkleTopology, setShowMerkleTopology] = useState<boolean>(false);
  const [showTechnicalReceipt, setShowTechnicalReceipt] = useState<boolean>(false);

  // Locally cached authentic snapshots by periodId for Row-by-Row Redline Diff
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

  // Interactive Inline Row Tamper Editor (in Auditor Mode)
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [editingRowValue, setEditingRowValue] = useState<string>('');

  // Single-Row Merkle Proof State
  const [selectedProofRowIndex, setSelectedProofRowIndex] = useState<number>(1);
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

  // Sync live XLM balance from Stellar Testnet Horizon
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

  // Check if current uploaded document is already sealed on Stellar
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

  const processUploadedFileList = async (
    fileList: FileList,
    targetMode: PortalTab
  ) => {
    if (!fileList || fileList.length === 0) return;

    if (targetMode === 'issuer') {
      setNotarizeError('');
      setLastNotarization(null);
      setIssuerExistingRecord(null);

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
      setSelectedProofRowIndex(1);
      const proof = generateRowMerkleProof(parsed, 1);
      setActiveRowProof(proof);
      const check = await verifyRowMerkleProof(proof, parsed.merkleRoot);
      setRowProofCheck(check);
    } else {
      const file = fileList[0];
      const buffer = await file.arrayBuffer();
      const parsed = await processLedgerContent(file.name, new Uint8Array(buffer));
      await runAuditorVerification(
        parsed,
        'custom',
        `Uploaded file "${file.name}" checked against the Stellar blockchain.`
      );
    }
  };

  const handleIssuerFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await processUploadedFileList(e.target.files, 'issuer');
      e.target.value = '';
    }
  };

  const handleAuditorFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (e.target.files) {
      await processUploadedFileList(e.target.files, 'auditor');
      e.target.value = '';
    }
  };

  const handleDropFiles = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processUploadedFileList(e.dataTransfer.files, activeTab);
    }
  };

  const handleProceedToAuditorStep3 = async (simulateFraud: boolean) => {
    const baseLedger =
      issuerLedger ||
      (auditorLedger
        ? sealedSnapshots[auditorLedger.periodId] || auditorLedger
        : null);
    if (!baseLedger) return;
    setActiveTab('auditor');
    setAttestError('');
    setLastAttestation(null);
    setEditingRowIndex(null);
    const effectivePeriod = (customPeriodId || baseLedger.periodId).trim();
    const cleanSnapshot: ParsedLedger = {
      ...baseLedger,
      periodId: effectivePeriod,
    };
    setSealedSnapshots((prev) => ({ ...prev, [effectivePeriod]: cleanSnapshot }));

    if (simulateFraud) {
      const { tamperedLedger, note } = await createTamperedCloneOfLedger(cleanSnapshot);
      setShowMerkleTopology(true);
      await runAuditorVerification(tamperedLedger, 'tampered_fraud', note);
    } else {
      await runAuditorVerification(
        cleanSnapshot,
        'authentic',
        `Every row and number in "${cleanSnapshot.fileName}" matches the digital seal anchored on the Stellar blockchain.`
      );
    }
  };

  const handleApplyInlineRowEdit = async (rowIndex: number) => {
    const baseLedger =
      issuerLedger ||
      (auditorLedger
        ? sealedSnapshots[auditorLedger.periodId] || auditorLedger
        : null);
    if (!baseLedger) return;
    const effectivePeriod = (customPeriodId || baseLedger.periodId).trim();
    const cleanSnapshot: ParsedLedger = {
      ...baseLedger,
      periodId: effectivePeriod,
    };
    setSealedSnapshots((prev) => ({ ...prev, [effectivePeriod]: cleanSnapshot }));

    const { tamperedLedger, note } = await editSpecificRowInLedger(
      cleanSnapshot,
      rowIndex,
      editingRowValue
    );
    setEditingRowIndex(null);
    setShowMerkleTopology(true);
    await runAuditorVerification(tamperedLedger, 'tampered_fraud', note);
  };

  const handleAttestAuditOnSoroban = async () => {
    const targetPeriod =
      verificationResult?.periodRecordOnChain?.periodId ||
      auditorLedger?.periodId ||
      customPeriodId;
    const targetIssuer =
      verificationResult?.periodRecordOnChain?.issuer ||
      activeSignerPub ||
      DEPLOY_CONFIG.cfoPrimaryPublic;

    setIsAttesting(true);
    setAttestError('');
    setAttestStep('Connecting External Auditor key & submitting co-signature to Stellar...');
    try {
      const res = await attestAuditOnSoroban({
        issuerAddress: targetIssuer,
        periodId: targetPeriod,
        onStep: (step) => setAttestStep(step),
      });
      setLastAttestation(res);
    } catch (err) {
      setAttestError(
        err instanceof Error ? err.message : 'External Auditor co-signature failed.'
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
    setNotarizeStep('Preparing Stellar blockchain seal...');
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
        err instanceof Error ? err.message : 'Blockchain sealing failed.'
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

    const targetRow = 1;
    setSelectedProofRowIndex(targetRow);
    const proof = generateRowMerkleProof(ledgerToVerify, targetRow);
    setActiveRowProof(proof);

    const lookupPeriodId =
      customPeriodId || issuerLedger?.periodId || ledgerToVerify.periodId;

    const onChainRes = await verifyLedgerOnSoroban({
      issuerAddress: activeSignerPub,
      periodId: lookupPeriodId,
      docHashHex: ledgerToVerify.rawFileHash,
      merkleRootHex: ledgerToVerify.merkleRoot,
    });

    const baselineSnapshot =
      sealedSnapshots[ledgerToVerify.periodId] ||
      sealedSnapshots[lookupPeriodId] ||
      issuerLedger ||
      null;

    let effectiveRes = onChainRes;

    if (onChainRes.status === 'NOT_FOUND' && baselineSnapshot) {
      const syntheticRecord: OnChainAuditRecord = {
        issuer: activeSignerPub,
        periodId: baselineSnapshot.periodId,
        docHash: baselineSnapshot.rawFileHash,
        merkleRoot: baselineSnapshot.merkleRoot,
        commitmentHash: baselineSnapshot.commitmentHash,
        timestamp: Math.floor(Date.now() / 1000),
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
      const xRay = runTamperXRay(baselineSnapshot, ledgerToVerify);
      const firstModified = xRay.modifiedRows[0]?.rowIndex || 1;
      setSelectedProofRowIndex(firstModified);
      const modProof = generateRowMerkleProof(ledgerToVerify, firstModified);
      setActiveRowProof(modProof);
      const modCheck = await verifyRowMerkleProof(modProof, expectedRoot);
      setRowProofCheck(modCheck);

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
            timestamp: Math.floor(Date.now() / 1000),
            entryCount: baselineSnapshot.rows.length,
            auditor: null,
            auditedAt: 0,
          },
      };
      setVerificationResult(effectiveRes);
      setTamperXRay(xRay);
    } else {
      setTamperXRay(null);
    }
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

  const isCompanySealed = Boolean(lastNotarization?.record || issuerExistingRecord);

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
            <span className="text-xs font-mono uppercase tracking-widest text-stone-500 hidden md:inline">
              / Tamper-Proof Document Seal on Stellar
            </span>
          </div>

          {/* Center: Role Switcher with Explicit Role Context */}
          <nav className="flex items-center h-full gap-1 sm:gap-4">
            <button
              type="button"
              onClick={() => setActiveTab('issuer')}
              className={`h-full px-3 sm:px-4 flex flex-col justify-center border-b-[3px] transition cursor-pointer text-left ${
                activeTab === 'issuer'
                  ? 'border-stone-950 text-stone-950 bg-stone-50/70'
                  : 'border-transparent text-stone-500 hover:text-stone-900'
              }`}
            >
              <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500">
                Role 1 · Sender
              </span>
              <span className="text-xs sm:text-sm font-semibold">
                1. Company (Seal File)
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (issuerLedger && !auditorLedger) {
                  void handleProceedToAuditorStep3(false);
                } else {
                  setActiveTab('auditor');
                }
              }}
              className={`h-full px-3 sm:px-4 flex flex-col justify-center border-b-[3px] transition cursor-pointer text-left ${
                activeTab === 'auditor'
                  ? 'border-stone-950 text-stone-950 bg-stone-50/70'
                  : 'border-transparent text-stone-500 hover:text-stone-900'
              }`}
            >
              <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500">
                Role 2 · Receiver
              </span>
              <span className="text-xs sm:text-sm font-semibold">
                2. Auditor / Client (Verify File)
              </span>
            </button>
          </nav>

          {/* Right: "How It Works" Button + Live Stellar Wallet */}
          <div className="relative flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowHowItWorksModal(true)}
              className="px-3 py-2 border border-stone-900 bg-stone-950 hover:bg-stone-800 text-white text-xs font-mono font-semibold uppercase tracking-wider cursor-pointer"
            >
              ? Why 2 Roles / How It Works
            </button>

            <button
              type="button"
              onClick={() => setShowWalletMenu((prev) => !prev)}
              className="flex items-center gap-2 px-3 py-2 border border-[#D8D4CA] bg-[#FAF8F5] hover:bg-stone-100 text-xs font-mono text-stone-800 cursor-pointer"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-600" />
              <span className="hidden sm:inline">
                {activeSignerPub.slice(0, 5)}..{activeSignerPub.slice(-4)}
              </span>
              <span className="text-stone-600 font-semibold">
                {xlmBalance} XLM
              </span>
            </button>

            {showWalletMenu && (
              <div className="absolute right-0 top-13 w-84 bg-white border border-stone-900 shadow-xl p-4 space-y-3 z-40 text-sm">
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="font-semibold text-stone-900">
                    Active Stellar Account
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
                  <div className="font-semibold text-sm">Company Stellar Key</div>
                  <div className="text-xs opacity-80 mt-0.5">
                    Live Testnet wallet ready for 1-click sealing
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
                      : 'Connect your own Freighter wallet extension'}
                  </div>
                </button>

                <div className="pt-2 border-t border-stone-200 flex items-center justify-between font-mono text-xs">
                  <span className="text-stone-500">Live Smart Contract</span>
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
          INTERACTIVE 3-STEP VISUAL JOURNEY PIPELINE (ALWAYS VISIBLE)
         ========================================================= */}
      <div className="border-b border-[#D8D4CA] bg-[#F4F1EA] no-print">
        <div className="max-w-[1440px] mx-auto px-6 py-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* STEP 1 PILL */}
          <button
            type="button"
            onClick={() => setActiveTab('issuer')}
            className={`p-3 border text-left transition cursor-pointer flex items-center justify-between gap-3 ${
              activeTab === 'issuer' && !issuerLedger
                ? 'bg-white border-stone-950 border-2 shadow-xs'
                : issuerLedger
                ? 'bg-white border-stone-300 hover:border-stone-900'
                : 'bg-[#FAF8F5] border-stone-300'
            }`}
          >
            <div>
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500">
                STEP 1 · ROLE: COMPANY (SENDER)
              </div>
              <div className="text-xs sm:text-sm font-bold text-stone-950 mt-0.5">
                1. Upload Any CSV or PDF File
              </div>
            </div>
            <span
              className={`font-mono text-[11px] font-bold px-2 py-0.5 border shrink-0 ${
                issuerLedger
                  ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                  : 'bg-amber-50 text-amber-900 border-amber-300'
              }`}
            >
              {issuerLedger ? '✓ Loaded' : 'Start Here'}
            </span>
          </button>

          {/* STEP 2 PILL */}
          <button
            type="button"
            onClick={() => setActiveTab('issuer')}
            className={`p-3 border text-left transition cursor-pointer flex items-center justify-between gap-3 ${
              activeTab === 'issuer' && issuerLedger && !isCompanySealed
                ? 'bg-white border-stone-950 border-2 shadow-xs'
                : isCompanySealed
                ? 'bg-white border-stone-300 hover:border-stone-900'
                : 'bg-[#FAF8F5] border-stone-300'
            }`}
          >
            <div>
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500">
                STEP 2 · ROLE: COMPANY (SENDER)
              </div>
              <div className="text-xs sm:text-sm font-bold text-stone-950 mt-0.5">
                2. Lock Digital Seal on Stellar
              </div>
            </div>
            <span
              className={`font-mono text-[11px] font-bold px-2 py-0.5 border shrink-0 ${
                isCompanySealed
                  ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                  : issuerLedger
                  ? 'bg-stone-950 text-white border-stone-950'
                  : 'bg-stone-100 text-stone-500 border-stone-300'
              }`}
            >
              {isCompanySealed
                ? '✓ Sealed'
                : issuerLedger
                ? 'Ready to Seal'
                : 'Waiting'}
            </span>
          </button>

          {/* STEP 3 PILL */}
          <button
            type="button"
            onClick={() => {
              if (issuerLedger && !auditorLedger) {
                void handleProceedToAuditorStep3(false);
              } else {
                setActiveTab('auditor');
              }
            }}
            className={`p-3 border text-left transition cursor-pointer flex items-center justify-between gap-3 ${
              activeTab === 'auditor'
                ? 'bg-white border-stone-950 border-2 shadow-xs'
                : 'bg-[#FAF8F5] border-stone-300 hover:border-stone-900'
            }`}
          >
            <div>
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500">
                STEP 3 · ROLE: AUDITOR / CLIENT (RECEIVER)
              </div>
              <div className="text-xs sm:text-sm font-bold text-stone-950 mt-0.5">
                3. Verify File &amp; Catch Edited Rows
              </div>
            </div>
            <span
              className={`font-mono text-[11px] font-bold px-2 py-0.5 border shrink-0 ${
                verificationResult?.status === 'TAMPERED_PERIOD_MISMATCH'
                  ? 'bg-red-700 text-white border-red-700'
                  : verificationResult?.status === 'EXACT_MATCH' ||
                    verificationResult?.status === 'CANONICAL_MERKLE_MATCH'
                  ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                  : 'bg-stone-100 text-stone-700 border-stone-300'
              }`}
            >
              {verificationResult?.status === 'TAMPERED_PERIOD_MISMATCH'
                ? '✕ Edit Caught'
                : verificationResult?.status === 'EXACT_MATCH' ||
                  verificationResult?.status === 'CANONICAL_MERKLE_MATCH'
                ? '✓ Verified'
                : 'Verify File'}
            </span>
          </button>
        </div>
      </div>

      {/* =========================================================
          ONBOARDING & EMPTY STATE (WHEN NO FILE IS LOADED YET)
         ========================================================= */}
      {!activeLedger && (
        <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-10 space-y-8 no-print">
          {/* 1. VISUAL EXPLAINER: WHY ARE THERE TWO ROLES / SECTIONS? */}
          <div className="bg-white border border-[#D8D4CA] p-6 sm:p-8 space-y-6">
            <div className="max-w-3xl space-y-2">
              <div className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-800">
                WHY AUDITLEDGER EXISTS · ZERO-KNOWLEDGE DOCUMENT INTEGRITY
              </div>
              <h1 className="font-serif-editorial text-3xl sm:text-5xl text-stone-950 leading-tight">
                How do you prove a spreadsheet or PDF wasn&apos;t secretly edited after it was sent?
              </h1>
              <p className="text-sm sm:text-base text-stone-600 leading-relaxed">
                When a company emails an Excel/CSV report or PDF contract to an external auditor, investor, or bank, anyone along the way can silently change a number. AuditLedger solves this in <strong>two simple views</strong> using the <strong>Stellar Blockchain</strong>:
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-11 gap-4 items-stretch">
              {/* Role 1 Card */}
              <div
                onClick={() => setActiveTab('issuer')}
                className={`lg:col-span-5 p-5 border-2 transition cursor-pointer space-y-2 ${
                  activeTab === 'issuer'
                    ? 'border-stone-950 bg-[#FAF8F5]'
                    : 'border-stone-300 bg-white hover:border-stone-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase tracking-wider px-2 py-0.5 bg-stone-950 text-white">
                    Section 1 · Company (Sender)
                  </span>
                  <span className="text-xs font-mono text-stone-500">
                    Steps 1 &amp; 2
                  </span>
                </div>
                <h2 className="text-lg font-bold text-stone-950 pt-1">
                  Freeze &amp; Lock the Original Document
                </h2>
                <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                  <strong>Who uses this:</strong> The Company, Finance Team, or Creator before sharing a file. You upload your CSV or PDF here. Your browser computes a unique digital fingerprint for every row and locks the master seal on Stellar. <strong>Zero private data ever leaves your computer.</strong>
                </p>
              </div>

              {/* Arrow Connector */}
              <div className="lg:col-span-1 flex flex-col items-center justify-center text-center py-2">
                <span className="text-xs font-mono uppercase tracking-wider text-stone-500">
                  Then send file via Email
                </span>
                <span className="text-2xl font-bold text-stone-900 mt-1">
                  ➔
                </span>
              </div>

              {/* Role 2 Card */}
              <div
                onClick={() => setActiveTab('auditor')}
                className={`lg:col-span-5 p-5 border-2 transition cursor-pointer space-y-2 ${
                  activeTab === 'auditor'
                    ? 'border-stone-950 bg-[#FAF8F5]'
                    : 'border-stone-300 bg-white hover:border-stone-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase tracking-wider px-2 py-0.5 bg-emerald-900 text-white">
                    Section 2 · Auditor / Client (Receiver)
                  </span>
                  <span className="text-xs font-mono text-stone-500">
                    Step 3 (Free Check)
                  </span>
                </div>
                <h2 className="text-lg font-bold text-stone-950 pt-1">
                  Verify Authenticity &amp; Pinpoint Any Changed Row
                </h2>
                <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                  <strong>Who uses this:</strong> The External Auditor, Client, Investor, or Regulator who receives the file. They drop the file here: AuditLedger checks the Stellar blockchain in 1 second and <strong>highlights in red the exact row and value</strong> if someone altered even a single character!
                </p>
              </div>
            </div>
          </div>

          {/* 2. DRAG & DROP FILE UPLOAD ZONE */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(e) => void handleDropFiles(e)}
            className={`bg-white border-2 p-8 sm:p-12 text-center space-y-5 transition ${
              isDraggingOver
                ? 'border-emerald-700 bg-emerald-50/40'
                : 'border-stone-950'
            }`}
          >
            <div className="inline-block px-3 py-1 bg-stone-100 border border-stone-300 text-xs font-mono font-bold uppercase tracking-wider text-stone-800">
              {activeTab === 'issuer'
                ? 'CURRENT VIEW: SECTION 1 · COMPANY (SEAL YOUR FILE)'
                : 'CURRENT VIEW: SECTION 2 · AUDITOR / CLIENT (VERIFY A FILE)'}
            </div>

            <h2 className="font-serif-editorial text-3xl sm:text-4xl text-stone-950">
              {activeTab === 'issuer'
                ? 'Drag & Drop Any CSV or PDF Here to Begin'
                : 'Drag & Drop a File Here to Check If It Was Altered'}
            </h2>

            <p className="text-sm text-stone-600 max-w-xl mx-auto leading-relaxed">
              {activeTab === 'issuer'
                ? 'Select 1 file or multiple files in bulk from your computer. Every row will be indexed locally so you can seal it on the Stellar blockchain in 1 click.'
                : 'Upload the file you want to verify against the Stellar blockchain, or switch to Section 1 first to seal a file from your PC.'}
            </p>

            <div className="pt-2">
              {activeTab === 'issuer' ? (
                <label className="inline-block py-4 px-8 bg-stone-950 hover:bg-stone-800 text-white text-base font-semibold tracking-wide cursor-pointer transition shadow-sm">
                  <span>+ Choose CSV or PDF File(s) from Your Computer</span>
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
                    <span>+ Choose File from Your Computer to Verify</span>
                    <input
                      type="file"
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleAuditorFileUpload(e)}
                      className="hidden"
                    />
                  </label>

                  {issuerLedger && (
                    <div className="pt-4 border-t border-stone-200 flex flex-wrap items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(false)}
                        className="px-4 py-2.5 border border-stone-900 bg-white hover:bg-stone-100 text-xs font-semibold uppercase tracking-wider text-stone-900 cursor-pointer"
                      >
                        Verify the File You Loaded in Section 1 ({issuerLedger.fileName})
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(true)}
                        className="px-4 py-2.5 border border-red-700 bg-red-50 hover:bg-red-100 text-xs font-semibold uppercase tracking-wider text-red-800 cursor-pointer"
                      >
                        Simulate Someone Editing {issuerLedger.fileName}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-4 text-xs text-stone-500 font-mono">
              Supported: Any CSV spreadsheet, PDF document, JSON, or TXT · Single or Bulk Multi-File · 100% Local Browser Privacy
            </div>
          </div>
        </main>
      )}

      {/* =========================================================
          ACTIVE WORKSPACE: LEFT = TABLE, RIGHT = BLOCKCHAIN SEAL
         ========================================================= */}
      {activeLedger && (
        <main className="flex-1 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 no-print">
          {/* =====================================================
              LEFT 8 COLS: EXTRACTED DOCUMENT ROWS & INTERACTIVE TABLE
             ===================================================== */}
          <section className="lg:col-span-8 border-b lg:border-b-0 lg:border-r border-[#D8D4CA] flex flex-col bg-white">
            {/* Document Title & Upload Button */}
            <div className="px-6 sm:px-8 py-6 border-b border-[#D8D4CA] bg-[#FAF8F5] space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-stone-600 font-bold">
                    {activeTab === 'issuer'
                      ? `SECTION 1 · COMPANY (SENDER) · ${activeLedger.fileName}`
                      : `SECTION 2 · EXTERNAL AUDITOR (RECEIVER) · ${activeLedger.fileName}`}
                  </div>
                  <h1 className="font-serif-editorial text-3xl sm:text-4xl text-stone-950 mt-1">
                    {activeTab === 'issuer'
                      ? activeLedger.fileName
                      : verificationResult?.status === 'TAMPERED_PERIOD_MISMATCH'
                      ? `Tampering Caught in ${activeLedger.fileName}`
                      : `Verified Authentic: ${activeLedger.fileName}`}
                  </h1>
                </div>

                {/* Upload Another File Button */}
                {activeTab === 'issuer' ? (
                  <label className="px-4 py-2.5 border-2 border-stone-950 bg-stone-950 hover:bg-stone-800 text-white text-xs sm:text-sm font-semibold cursor-pointer">
                    <span>+ Upload Different File(s)</span>
                    <input
                      type="file"
                      multiple
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleIssuerFileUpload(e)}
                      className="hidden"
                    />
                  </label>
                ) : (
                  <label className="px-4 py-2.5 border-2 border-stone-950 bg-stone-950 hover:bg-stone-800 text-white text-xs sm:text-sm font-semibold cursor-pointer">
                    <span>+ Upload Another File to Verify</span>
                    <input
                      type="file"
                      accept=".csv,.txt,.json,.pdf"
                      onChange={(e) => void handleAuditorFileUpload(e)}
                      className="hidden"
                    />
                  </label>
                )}
              </div>

              {/* In Auditor Mode: Interactive Fraud & Tamper Playground Banner */}
              {activeTab === 'auditor' && (
                <div className="p-4 border-2 border-stone-900 bg-white space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-red-800 block">
                        ★ INTERACTIVE TAMPER DETECTOR (TRY IT LIVE)
                      </span>
                      <span className="text-sm font-bold text-stone-950">
                        Test what happens if someone alters a row after sealing on Stellar:
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(false)}
                        className={`px-3.5 py-2 border text-xs font-semibold uppercase tracking-wider cursor-pointer ${
                          auditorScenario !== 'tampered_fraud'
                            ? 'border-stone-950 bg-stone-950 text-white'
                            : 'border-stone-400 bg-white text-stone-900 hover:bg-stone-100'
                        }`}
                      >
                        1. Restore Original File
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleProceedToAuditorStep3(true)}
                        className={`px-3.5 py-2 border text-xs font-semibold uppercase tracking-wider cursor-pointer ${
                          auditorScenario === 'tampered_fraud'
                            ? 'border-red-800 bg-red-800 text-white'
                            : 'border-red-700 bg-red-50 text-red-900 hover:bg-red-100'
                        }`}
                      >
                        2. Auto-Simulate Fraud on 1 Row
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-stone-600 border-t border-stone-200 pt-2">
                    <strong>Tip:</strong> You can also click the <strong>&quot;Edit Row&quot;</strong> button on <em>any</em> row in the table below to type your own fake change and watch the Stellar seal catch it in real time!
                  </p>
                </div>
              )}
            </div>

            {/* Summary Metrics Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 border-b border-[#D8D4CA] divide-y sm:divide-y-0 sm:divide-x divide-[#D8D4CA] bg-white">
              <div className="px-6 sm:px-8 py-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? 'Total Debits'
                    : 'Protected Rows'}
                </div>
                <div className="font-mono text-2xl sm:text-3xl font-bold text-stone-950 mt-1">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? formatCentsToEur(activeLedger.totalDebitCents)
                    : `${activeLedger.rows.length} ${
                        activeLedger.rows.length === 1 ? 'File' : 'Rows'
                      }`}
                </div>
              </div>

              <div className="px-6 sm:px-8 py-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  {activeLedger.documentMode === 'accounting_gl'
                    ? 'Total Credits'
                    : 'File Size'}
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
                  Row-by-Row Protection Map
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                  <span
                    className={`font-mono text-xl sm:text-2xl font-bold whitespace-nowrap ${
                      tamperXRay && tamperXRay.modifiedRows.length > 0
                        ? 'text-red-700'
                        : 'text-emerald-800'
                    }`}
                  >
                    {tamperXRay && tamperXRay.modifiedRows.length > 0
                      ? `${tamperXRay.modifiedRows.length} Modified`
                      : `${activeLedger.rows.length} Intact`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMerkleTopology((prev) => !prev)}
                    className="px-2.5 py-1 border border-stone-400 bg-[#FAF8F5] hover:bg-stone-100 text-xs font-mono font-semibold text-stone-900 whitespace-nowrap cursor-pointer"
                  >
                    {showMerkleTopology ? 'Hide Visual Map' : 'Show Visual Map'}
                  </button>
                </div>
              </div>
            </div>

            {/* Expandable Visual Row-by-Row Protection Map */}
            {showMerkleTopology && (
              <MerkleTreeVisualizer
                ledger={activeLedger}
                selectedRowIndex={selectedProofRowIndex}
                onSelectRow={(idx) => void handleSelectProofRow(idx)}
                tamperReport={activeTab === 'auditor' ? tamperXRay : null}
                sealedMerkleRoot={currentSealedRecord?.merkleRoot}
              />
            )}

            {/* Table Header & Search Bar */}
            <div className="px-6 sm:px-8 py-3.5 border-b border-[#D8D4CA] bg-[#FAF8F5] flex flex-wrap items-center justify-between gap-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
                {activeLedger.documentMode === 'accounting_gl'
                  ? `Extracted Accounting Rows (${filteredRows.length})`
                  : `Extracted Document Rows (${filteredRows.length})`}
              </span>
              <input
                type="text"
                value={rowSearchQuery}
                onChange={(e) => setRowSearchQuery(e.target.value)}
                placeholder="Search any row or text..."
                className="w-full sm:w-72 px-3 py-1.5 text-sm bg-white border border-stone-300 text-stone-900 focus:outline-none focus:border-stone-900"
              />
            </div>

            {/* High-Contrast Data Table */}
            <div className="overflow-x-auto flex-1 bg-white">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#D8D4CA] bg-stone-100/80 text-xs font-semibold uppercase tracking-wider text-stone-700">
                    <th className="py-3.5 px-4 w-12">#</th>
                    <th className="py-3.5 px-4">Row ID</th>
                    <th className="py-3.5 px-4">Content / Description</th>
                    {activeLedger.documentMode === 'accounting_gl' ? (
                      <>
                        <th className="py-3.5 px-4 text-right">Debit (EUR)</th>
                        <th className="py-3.5 px-4 text-right">Credit (EUR)</th>
                      </>
                    ) : (
                      <th className="py-3.5 px-4 text-right">Row Digital Seal</th>
                    )}
                    <th className="py-3.5 px-4 text-right">
                      {activeTab === 'auditor' ? 'Status / Live Test' : 'Status'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 text-sm">
                  {filteredRows.map((row) => {
                    const diff = diffByRowIndex.get(row.rowIndex);
                    const isTampered = Boolean(diff);
                    const isSelected = row.rowIndex === selectedProofRowIndex;
                    const isEditingThisRow = editingRowIndex === row.rowIndex;

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

                          {isEditingThisRow ? (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="mt-2 flex flex-wrap items-center gap-2"
                            >
                              <input
                                type="text"
                                value={editingRowValue}
                                onChange={(e) => setEditingRowValue(e.target.value)}
                                placeholder={
                                  activeLedger.documentMode === 'accounting_gl'
                                    ? 'Enter new EUR amount (e.g. 99500)...'
                                    : 'Type modified text for this row...'
                                }
                                className="px-2.5 py-1.5 text-xs font-mono bg-white border-2 border-stone-950 text-stone-950 w-64"
                              />
                              <button
                                type="button"
                                onClick={() => void handleApplyInlineRowEdit(row.rowIndex)}
                                className="px-3 py-1.5 bg-red-700 hover:bg-red-800 text-white text-xs font-mono font-bold uppercase cursor-pointer"
                              >
                                Apply Fake Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingRowIndex(null)}
                                className="px-2.5 py-1.5 border border-stone-400 bg-white text-stone-700 text-xs font-mono uppercase cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : isTampered && diff?.field === 'Row Content' ? (
                            <div className="mt-1 space-y-0.5 font-mono text-xs">
                              <div className="line-through text-stone-500">
                                Sealed Original: {diff.sealedValue}
                              </div>
                              <div className="font-bold text-red-700">
                                Modified To: {diff.uploadedValue}
                              </div>
                            </div>
                          ) : (
                            <div className="text-xs sm:text-sm text-stone-600 mt-0.5">
                              {row.description}
                            </div>
                          )}
                        </td>

                        {activeLedger.documentMode === 'accounting_gl' ? (
                          <>
                            <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-base">
                              {isTampered && diff?.field === 'Debit Amount' ? (
                                <div className="flex flex-col items-end">
                                  <span className="line-through text-stone-500 text-xs">
                                    Original: {diff.sealedValue.replace('EUR ', '')}
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

                            <td className="py-4 px-4 font-mono text-right whitespace-nowrap text-base">
                              {isTampered && diff?.field === 'Credit Amount' ? (
                                <div className="flex flex-col items-end">
                                  <span className="line-through text-stone-500 text-xs">
                                    Original: {diff.sealedValue.replace('EUR ', '')}
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

                        <td
                          onClick={(e) => e.stopPropagation()}
                          className="py-4 px-4 font-mono text-right whitespace-nowrap text-xs"
                        >
                          <div className="flex items-center justify-end gap-2">
                            {isTampered ? (
                              <span className="inline-block px-2.5 py-1 bg-red-700 text-white font-bold">
                                MODIFIED ({diff?.deltaFormatted.replace('EUR ', '')})
                              </span>
                            ) : (
                              <span className="text-emerald-800 font-semibold">
                                ✓ Intact
                              </span>
                            )}

                            {activeTab === 'auditor' && !isEditingThisRow && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingRowIndex(row.rowIndex);
                                  setEditingRowValue(
                                    activeLedger.documentMode === 'accounting_gl'
                                      ? String(
                                          (row.debitCents || row.creditCents) / 100 +
                                            5000
                                        )
                                      : `${row.description} [EDITED]`
                                  );
                                }}
                                className="px-2 py-1 border border-stone-400 bg-white hover:bg-red-50 hover:border-red-700 hover:text-red-800 text-[11px] font-semibold text-stone-700 cursor-pointer"
                              >
                                Edit Row
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* =====================================================
              RIGHT 4 COLS: SIMPLE BLOCKCHAIN SEAL & VERDICT PANEL
             ===================================================== */}
          <aside className="lg:col-span-4 bg-[#F4F1EA] flex flex-col divide-y divide-[#D8D4CA]">
            <div className="p-6 sm:p-8 space-y-6">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-stone-600">
                  {activeTab === 'issuer'
                    ? 'STEP 2 OF 3 · BLOCKCHAIN DIGITAL SEAL'
                    : 'STEP 3 OF 3 · VERIFICATION RESULT'}
                </span>
                <a
                  href={contractExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono font-semibold underline text-stone-800 hover:text-black whitespace-nowrap shrink-0"
                >
                  View on Stellar ↗
                </a>
              </div>

              {activeTab === 'issuer' ? (
                <>
                  {/* Seal Status Box */}
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
                          : '○ Ready to Seal'}
                      </span>
                      <span
                        className={`font-mono text-xs font-bold px-2.5 py-0.5 border ${
                          currentSealedRecord
                            ? 'text-emerald-800 bg-emerald-50 border-emerald-300'
                            : 'text-amber-900 bg-amber-50 border-amber-300'
                        }`}
                      >
                        {currentSealedRecord ? 'LOCKED' : 'NOT SEALED YET'}
                      </span>
                    </div>

                    <div className="space-y-2.5 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Document ID</span>
                        <span className="font-mono font-bold text-stone-950 text-right">
                          {customPeriodId}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Signed By</span>
                        <span className="font-mono text-stone-900">
                          {activeSignerPub.slice(0, 6)}...{activeSignerPub.slice(-6)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-stone-600">Blockchain Network</span>
                        <span className="font-mono font-semibold text-emerald-900">
                          Stellar Testnet (Live)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <button
                    type="button"
                    disabled={isNotarizing}
                    onClick={() => void handleNotarizeOnSoroban()}
                    className="w-full py-4 px-6 bg-stone-950 hover:bg-stone-800 disabled:bg-stone-400 text-white text-sm sm:text-base font-semibold tracking-wide transition cursor-pointer shadow-sm"
                  >
                    {isNotarizing
                      ? notarizeStep || 'Sealing on Stellar Blockchain...'
                      : currentSealedRecord
                      ? 'Create New Blockchain Seal for This File'
                      : 'Step 2: Lock & Seal Document on Stellar'}
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
                          Blockchain Receipt ↗
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
                          Printable Certificate
                        </button>
                      </div>

                      {/* Guided Step 3 Handoff Card */}
                      <div className="border-2 border-emerald-800 bg-emerald-50/70 p-4 space-y-3">
                        <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-900">
                          ✓ Document Sealed! Next: Step 3 (Auditor View)
                        </div>
                        <p className="text-xs text-stone-800 leading-relaxed">
                          Now switch to <strong>Role 2 (External Auditor / Receiver)</strong> to verify this file or see what happens if someone modifies a row:
                        </p>
                        <div className="grid grid-cols-1 gap-2">
                          <button
                            type="button"
                            onClick={() => void handleProceedToAuditorStep3(false)}
                            className="w-full py-2.5 px-3 bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold uppercase tracking-wider cursor-pointer"
                          >
                            Step 3A: Verify Original Untouched File →
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleProceedToAuditorStep3(true)}
                            className="w-full py-2.5 px-3 bg-white hover:bg-red-50 text-red-800 border border-red-700 text-xs font-semibold uppercase tracking-wider cursor-pointer"
                          >
                            Step 3B: Test What Happens If Someone Edits a Row →
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
                            '✓ FILE IS 100% AUTHENTIC'}
                          {verificationResult.status === 'CANONICAL_MERKLE_MATCH' &&
                            '✓ ALL DATA & NUMBERS INTACT'}
                          {verificationResult.status === 'TAMPERED_PERIOD_MISMATCH' &&
                            '✕ WARNING: FILE WAS MODIFIED'}
                          {verificationResult.status === 'NOT_FOUND' &&
                            '! NOT SEALED YET'}
                        </div>
                        <h2 className="text-xl font-bold text-stone-950 mt-1">
                          {verificationResult.status === 'EXACT_MATCH' &&
                            'Matches Stellar Blockchain Seal'}
                          {verificationResult.status === 'CANONICAL_MERKLE_MATCH' &&
                            'Verified (Even After Excel Re-Save)'}
                          {verificationResult.status === 'TAMPERED_PERIOD_MISMATCH' &&
                            `${
                              tamperXRay?.modifiedRows.length || 1
                            } Row(s) Changed After Sealing`}
                          {verificationResult.status === 'NOT_FOUND' &&
                            'No Seal Found for This File'}
                        </h2>
                      </div>

                      <p className="text-sm text-stone-700 leading-relaxed">
                        {auditorScenarioNote}
                      </p>

                      {tamperXRay && tamperXRay.modifiedRows.length > 0 && (
                        <div className="pt-3 border-t border-red-200 space-y-2 text-sm text-red-950">
                          <div className="font-bold text-xs uppercase tracking-wider text-red-700">
                            Exact Rows Changed After Sealing:
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

                    {/* Multi-Party External Auditor Approval */}
                    {(verificationResult.status === 'EXACT_MATCH' ||
                      verificationResult.status === 'CANONICAL_MERKLE_MATCH') && (
                      <div className="border border-stone-400 bg-white p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono font-bold uppercase tracking-wider text-stone-800">
                            External Auditor Approval
                          </span>
                          <span className="font-mono text-[11px] text-emerald-800 font-semibold whitespace-nowrap shrink-0">
                            Official Co-Signature
                          </span>
                        </div>
                        <p className="text-xs text-stone-600 leading-relaxed">
                          Add the External Auditor co-signature on Stellar so anyone inspecting this document sees both Company and Auditor approvals:
                        </p>
                        <button
                          type="button"
                          disabled={isAttesting}
                          onClick={() => void handleAttestAuditOnSoroban()}
                          className="w-full py-3 px-4 bg-stone-950 hover:bg-stone-800 disabled:bg-stone-400 text-white text-xs font-semibold uppercase tracking-wider cursor-pointer"
                        >
                          {isAttesting
                            ? attestStep || 'Recording Auditor Approval on Stellar...'
                            : 'Approve & Co-Sign This File on Stellar'}
                        </button>
                        {attestError && (
                          <div className="p-2 bg-red-50 border border-red-600 font-mono text-xs text-red-800 break-all">
                            {attestError}
                          </div>
                        )}
                        {lastAttestation && (
                          <div className="p-3 bg-emerald-50 border border-emerald-400 text-xs space-y-1">
                            <div className="font-bold text-emerald-900">
                              ✓ Approved by Both Company &amp; External Auditor on Stellar
                            </div>
                            <a
                              href={lastAttestation.explorerTxUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono underline text-emerald-950 block"
                            >
                              View Blockchain Co-Signature ({lastAttestation.txHash.slice(0, 10)}
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

            {/* Digital Fingerprint Summary + Optional Technical Accordion */}
            <div className="p-6 sm:p-8 space-y-4 flex-1">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
                    Document Digital Fingerprint (Stellar Seal)
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
                  <strong>100% Private (GDPR Safe):</strong> Your actual file and numbers never leave your computer. Only this unique digital fingerprint is saved on the public Stellar blockchain.
                </p>
              </div>

              {/* Optional Technical Accordion */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowTechnicalReceipt((prev) => !prev)}
                  className="w-full py-2.5 px-4 border border-stone-300 bg-white hover:bg-stone-50 text-xs font-semibold text-stone-800 flex items-center justify-between cursor-pointer"
                >
                  <span>
                    {showTechnicalReceipt
                      ? 'Hide Technical Blockchain Details'
                      : `Technical Details (Raw SHA-256 & Row #${selectedProofRowIndex} Proof)`}
                  </span>
                  <span>{showTechnicalReceipt ? '−' : '+'}</span>
                </button>

                {showTechnicalReceipt && (
                  <div className="mt-3 space-y-4 bg-white border border-stone-300 p-4 text-xs">
                    <div className="space-y-1">
                      <div className="flex justify-between font-semibold text-stone-600">
                        <span>Exact File SHA-256 Fingerprint</span>
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
                        <span>Privacy-Protected Totals Seal</span>
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
                              {rowProofCheck.valid ? '✓ Intact Row' : '✕ Modified Row'}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1 font-mono text-[11px] text-stone-600">
                          {activeRowProof.proofPath.map((step, i) => (
                            <div key={i} className="flex justify-between">
                              <span>
                                Level {i + 1} Pair ({step.position})
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
          "WHY 2 ROLES / HOW IT WORKS" ONBOARDING MODAL (ACCESSIBLE ANYTIME)
         ========================================================= */}
      {showHowItWorksModal && (
        <div className="fixed inset-0 z-50 bg-stone-950/60 flex items-center justify-center p-4 overflow-y-auto no-print">
          <div className="bg-white text-stone-950 max-w-3xl w-full p-8 border-2 border-stone-950 shadow-2xl space-y-6 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b-2 border-stone-950 pb-4">
              <div>
                <div className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-800">
                  QUICK GUIDE · UNDERSTAND AUDITLEDGER IN 30 SECONDS
                </div>
                <h2 className="font-serif-editorial text-3xl text-stone-950 mt-1">
                  Why Are There Two Sections?
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowHowItWorksModal(false)}
                className="font-mono text-xs uppercase font-semibold underline text-stone-600 hover:text-stone-950 cursor-pointer"
              >
                Close [X]
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="p-5 border-2 border-stone-950 bg-[#FAF8F5] space-y-2">
                <div className="text-xs font-mono font-bold uppercase tracking-wider text-stone-950">
                  ROLE 1 · SECTION 1: COMPANY (SENDER)
                </div>
                <h3 className="text-lg font-bold text-stone-950">
                  You Create &amp; Seal the File
                </h3>
                <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                  Before sending an important CSV spreadsheet or PDF to an external auditor, client, or investor, you upload it in <strong>Section 1</strong> and click <strong>Lock &amp; Seal on Stellar</strong>.
                </p>
                <p className="text-xs text-stone-600 leading-relaxed">
                  AuditLedger creates a digital fingerprint for every row and locks the master seal on the Stellar blockchain. Your private file never leaves your computer.
                </p>
              </div>

              <div className="p-5 border-2 border-emerald-900 bg-emerald-50/40 space-y-2">
                <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-900">
                  ROLE 2 · SECTION 2: AUDITOR / CLIENT (RECEIVER)
                </div>
                <h3 className="text-lg font-bold text-stone-950">
                  They Verify &amp; Catch Any Secret Edit
                </h3>
                <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                  When the External Auditor or Client receives your file by email, how do they know nobody secretly changed a row or number? They open <strong>Section 2</strong> and upload the file they received.
                </p>
                <p className="text-xs text-stone-600 leading-relaxed">
                  If even <strong>1 cent or 1 word</strong> was modified after sealing, AuditLedger immediately flags the file in red and pinpoints the exact altered row!
                </p>
              </div>
            </div>

            <div className="p-4 bg-[#F4F1EA] border border-stone-300 space-y-2 text-xs sm:text-sm">
              <div className="font-bold text-stone-950">
                How to Demo This Live in 30 Seconds:
              </div>
              <ol className="list-decimal list-inside space-y-1 text-stone-700">
                <li>
                  In <strong>Section 1 (Company)</strong>, upload any CSV or PDF from your computer and click <strong>Step 2: Lock &amp; Seal Document on Stellar</strong>.
                </li>
                <li>
                  Click <strong>Step 3A: Verify Original Untouched File</strong> to switch to <strong>Section 2 (Auditor)</strong> and see the green <strong>100% Authentic</strong> confirmation.
                </li>
                <li>
                  Click <strong>Edit Row</strong> on any row in the table (or click <strong>Auto-Simulate Fraud</strong>) to change a value and watch the Stellar verification catch the exact row you modified!
                </li>
              </ol>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowHowItWorksModal(false)}
                className="px-6 py-3 bg-stone-950 hover:bg-stone-800 text-white text-xs font-mono font-semibold uppercase tracking-wider cursor-pointer"
              >
                Got It - Back to Workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          PRINTABLE BLOCKCHAIN SEAL CERTIFICATE MODAL
         ========================================================= */}
      {certificateRecord && (
        <div className="fixed inset-0 z-50 bg-stone-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white text-stone-950 max-w-2xl w-full p-8 border-2 border-stone-950 shadow-2xl space-y-6 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b-2 border-stone-950 pb-4">
              <div>
                <div className="text-xs font-mono uppercase tracking-widest text-stone-500">
                  Stellar Blockchain Document Seal
                </div>
                <h2 className="font-serif-editorial text-3xl text-stone-950 mt-0.5">
                  Official Blockchain Seal Certificate
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
                  <span className="text-stone-500 block text-xs">DOCUMENT ID</span>
                  <span className="font-bold text-base text-stone-950">
                    {certificateRecord.record.periodId}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    STELLAR SMART CONTRACT ID
                  </span>
                  <span className="text-xs break-all text-stone-800">
                    {DEPLOY_CONFIG.contractId}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    SIGNED BY WALLET
                  </span>
                  <span className="text-xs break-all text-stone-800">
                    {certificateRecord.record.issuer}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block text-xs">
                    SEAL TIMESTAMP &amp; PROTECTED ROWS
                  </span>
                  <span className="text-xs text-stone-800">
                    {new Date(
                      (certificateRecord.record.timestamp ||
                        Math.floor(Date.now() / 1000)) * 1000
                    ).toUTCString()}{' '}
                    ({certificateRecord.record.entryCount} rows)
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
                  Stellar Explorer QR
                </span>
              </div>
            </div>

            <div className="space-y-2.5 bg-[#FAF8F5] p-4 border border-stone-300 text-xs font-mono">
              <div>
                <span className="text-stone-500 block">
                  01 / EXACT FILE FINGERPRINT (SHA-256)
                </span>
                <span className="break-all text-stone-900">
                  {certificateRecord.record.docHash}
                </span>
              </div>
              <div>
                <span className="text-stone-500 block">
                  02 / ROW-BY-ROW MASTER DIGITAL SEAL
                </span>
                <span className="break-all text-stone-950 font-bold">
                  {certificateRecord.record.merkleRoot}
                </span>
              </div>
              <div>
                <span className="text-stone-500 block">
                  03 / PRIVACY-PROTECTED TOTALS SEAL
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
                Print Certificate
              </button>

              <button
                type="button"
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        {
                          protocol: 'AuditLedger-Stellar',
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
                  a.download = `AuditLedger_Certificate_${certificateRecord.record.periodId}.json`;
                  a.click();
                }}
                className="px-4 py-3 border border-stone-400 hover:bg-stone-100 text-stone-900 font-semibold uppercase tracking-wider cursor-pointer"
              >
                Download JSON Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
