import React from 'react';
import { ParsedLedger, TamperXRayReport } from '../lib/merkleAndCrypto';

interface MerkleTreeVisualizerProps {
  ledger: ParsedLedger;
  selectedRowIndex: number;
  onSelectRow: (rowIndex: number) => void;
  tamperReport?: TamperXRayReport | null;
  sealedMerkleRoot?: string | null;
}

export const MerkleTreeVisualizer: React.FC<MerkleTreeVisualizerProps> = ({
  ledger,
  selectedRowIndex,
  tamperReport,
  sealedMerkleRoot,
}) => {
  const activeRow =
    ledger.rows.find((r) => r.rowIndex === selectedRowIndex) || ledger.rows[0];
  const hasTampering = Boolean(
    tamperReport && tamperReport.modifiedRows.length > 0
  );
  const isRootMismatch =
    hasTampering ||
    Boolean(
      sealedMerkleRoot &&
        sealedMerkleRoot.toLowerCase() !== ledger.merkleRoot.toLowerCase()
    );

  return (
    <div className="border-t border-[#E2DFD7] bg-[#F5F2EB] px-6 sm:px-8 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2DFD7] pb-3">
        <div>
          <span className="text-xs font-mono uppercase tracking-wider text-stone-700 font-bold">
            How Privacy &amp; Row-by-Row Protection Work
          </span>
          <p className="text-xs text-stone-600 mt-0.5">
            Why your confidential data stays 100% private on your computer while the Stellar blockchain guarantees zero rows were altered:
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Step 1 Card */}
        <div className="bg-white border border-stone-300 p-4 space-y-2">
          <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-stone-500">
            1. LOCAL ROW LOCKS (ON YOUR PC)
          </div>
          <div className="text-sm font-bold text-stone-950">
            Each of your {ledger.rows.length} rows gets its own digital lock
          </div>
          <p className="text-xs text-stone-600 leading-relaxed">
            Your browser calculates a unique mathematical code for every row. None of your actual text or numbers ever leave your computer.
          </p>
          {activeRow && (
            <div className="pt-2 border-t border-stone-200 font-mono text-[11px] text-stone-800">
              <span className="text-stone-500 block">
                Selected Row #{activeRow.rowIndex} ({activeRow.accountName.slice(0, 22)}):
              </span>
              <span className="font-semibold">
                {activeRow.leafHash.slice(0, 16)}...{activeRow.leafHash.slice(-8)}
              </span>
            </div>
          )}
        </div>

        {/* Step 2 Card */}
        <div className="bg-white border border-stone-300 p-4 space-y-2">
          <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-stone-500">
            2. ONE COMBINED MASTER FINGERPRINT
          </div>
          <div className="text-sm font-bold text-stone-950">
            All {ledger.rows.length} rows combine into 1 Master Seal
          </div>
          <p className="text-xs text-stone-600 leading-relaxed">
            If someone changes even a single letter or number in any row later on, this combined Master Fingerprint changes completely.
          </p>
          <div className="pt-2 border-t border-stone-200 font-mono text-[11px] text-stone-800">
            <span className="text-stone-500 block">Current File Master Fingerprint:</span>
            <span className="font-semibold">
              {ledger.merkleRoot.slice(0, 16)}...{ledger.merkleRoot.slice(-8)}
            </span>
          </div>
        </div>

        {/* Step 3 Card */}
        <div
          className={`p-4 space-y-2 border-2 ${
            isRootMismatch
              ? 'bg-red-50/80 border-red-700'
              : 'bg-white border-emerald-800'
          }`}
        >
          <div
            className={`text-[11px] font-mono font-bold uppercase tracking-wider ${
              isRootMismatch ? 'text-red-700' : 'text-emerald-800'
            }`}
          >
            3. STELLAR BLOCKCHAIN CHECK
          </div>
          <div className="text-sm font-bold text-stone-950">
            {isRootMismatch
              ? 'Mismatch! A row was altered after sealing'
              : '100% GDPR Safe & Tamper-Proof'}
          </div>
          <p className="text-xs text-stone-600 leading-relaxed">
            {isRootMismatch
              ? 'The Master Fingerprint of this file no longer matches the original Stellar seal. The exact modified row is highlighted in red below.'
              : 'Only the 32-byte Master Fingerprint is saved on Stellar. Anyone receiving your file can verify in 1 second that every row is untouched.'}
          </p>
          {sealedMerkleRoot && (
            <div className="pt-2 border-t border-stone-200 font-mono text-[11px] text-stone-800">
              <span className="text-stone-500 block">Original Seal on Stellar:</span>
              <span className="font-semibold">
                {sealedMerkleRoot.slice(0, 16)}...{sealedMerkleRoot.slice(-8)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
