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
    <div className="border-t border-[#E2DFD7] bg-[#F5F2EB] px-6 py-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Card 1 */}
        <div className="bg-white border border-stone-300 p-3.5 space-y-1">
          <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500">
            1. PRIVATE ON YOUR PC
          </div>
          <div className="text-sm font-bold text-stone-950">
            {ledger.rows.length} rows locked locally
          </div>
          <p className="text-xs text-stone-600">
            Your file never leaves your browser. Each row gets a local lock code.
          </p>
          {activeRow && (
            <div className="pt-1.5 font-mono text-[11px] text-stone-500 truncate">
              Row #{activeRow.rowIndex}: {activeRow.leafHash.slice(0, 14)}...
            </div>
          )}
        </div>

        {/* Card 2 */}
        <div className="bg-white border border-stone-300 p-3.5 space-y-1">
          <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500">
            2. AUTOMATIC MERKLE TREE (1 SEAL)
          </div>
          <div className="text-sm font-bold text-stone-950">
            10 or 10,000 rows = 1 single Stellar TX
          </div>
          <p className="text-xs text-stone-600">
            All rows combine into 1 Master Seal (32 bytes), so sealing 10,000 rows costs the exact same 1 transaction (~0.00001 XLM) as 10 rows.
          </p>
          <div className="pt-1.5 font-mono text-[11px] text-stone-500 truncate">
            Seal: {ledger.merkleRoot.slice(0, 18)}...
          </div>
        </div>

        {/* Card 3 */}
        <div
          className={`p-3.5 space-y-1 border-2 ${
            isRootMismatch
              ? 'bg-red-50/80 border-red-700'
              : 'bg-white border-emerald-800'
          }`}
        >
          <div
            className={`text-[10px] font-mono font-bold uppercase tracking-wider ${
              isRootMismatch ? 'text-red-700' : 'text-emerald-800'
            }`}
          >
            3. STELLAR BLOCKCHAIN
          </div>
          <div className="text-sm font-bold text-stone-950">
            {isRootMismatch ? 'Mismatch Detected!' : '100% GDPR Safe'}
          </div>
          <p className="text-xs text-stone-600">
            {isRootMismatch
              ? 'This file differs from the Stellar seal. Modified row is highlighted in red.'
              : 'Only the 32-byte seal is stored on Stellar. Zero private data on-chain.'}
          </p>
        </div>
      </div>
    </div>
  );
};
