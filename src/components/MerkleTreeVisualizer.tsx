import React, { useMemo } from 'react';
import { ParsedLedger, TamperXRayReport, formatCentsToEur } from '../lib/merkleAndCrypto';

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
  onSelectRow,
  tamperReport,
  sealedMerkleRoot,
}) => {
  const tamperedRowSet = useMemo(() => {
    const set = new Set<number>();
    if (tamperReport?.modifiedRows) {
      for (const item of tamperReport.modifiedRows) {
        set.add(item.rowIndex - 1);
      }
    }
    return set;
  }, [tamperReport]);

  const treeMetadata = useMemo(() => {
    const layers = ledger.merkleLayers;
    const activeLeafIdx = Math.max(0, Math.min(ledger.rows.length - 1, selectedRowIndex - 1));

    const pathNodeByLevel: number[] = [];
    const siblingNodeByLevel: number[] = [];

    let curr = activeLeafIdx;
    for (let lvl = 0; lvl < layers.length; lvl += 1) {
      pathNodeByLevel[lvl] = curr;
      if (lvl < layers.length - 1) {
        const isRight = curr % 2 === 1;
        const sib = isRight ? curr - 1 : curr + 1;
        const maxIdx = layers[lvl].length - 1;
        siblingNodeByLevel[lvl] = sib <= maxIdx ? sib : curr;
      }
      curr = Math.floor(curr / 2);
    }

    const corruptedByLevel: Array<Set<number>> = layers.map(() => new Set<number>());
    for (const leafIdx of tamperedRowSet) {
      let c = leafIdx;
      for (let lvl = 0; lvl < layers.length; lvl += 1) {
        corruptedByLevel[lvl].add(c);
        c = Math.floor(c / 2);
      }
    }

    return {
      pathNodeByLevel,
      siblingNodeByLevel,
      corruptedByLevel,
    };
  }, [ledger, selectedRowIndex, tamperedRowSet]);

  const layersTopDown = useMemo(() => {
    return ledger.merkleLayers
      .map((nodes, levelIndex) => ({
        levelIndex,
        nodes,
      }))
      .reverse();
  }, [ledger.merkleLayers]);

  const hasTampering = tamperedRowSet.size > 0;

  return (
    <div className="border-t border-[#E2DFD7] bg-[#F5F2EB] px-6 py-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#E2DFD7] pb-3">
        <div>
          <span className="text-[11px] font-mono uppercase tracking-widest text-stone-500">
            Row-by-Row Protection Map (Merkle Tree)
          </span>
          <p className="text-xs text-stone-600 mt-0.5">
            Click any row box below to see how its individual digital fingerprint connects to the master seal on Stellar.
          </p>
        </div>

        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-stone-900">
            <span className="w-2 h-2 bg-stone-900 inline-block" />
            <span>SELECTED ROW PATH</span>
          </span>
          <span className="flex items-center gap-1.5 text-amber-800">
            <span className="w-2 h-2 bg-amber-600 inline-block" />
            <span>PAIRED NEIGHBOR</span>
          </span>
          {hasTampering && (
            <span className="flex items-center gap-1.5 text-red-700 font-semibold">
              <span className="w-2 h-2 bg-red-600 inline-block" />
              <span>MODIFIED ROW</span>
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2.5">
        {layersTopDown.map(({ levelIndex, nodes }) => {
          const isRootLevel = levelIndex === ledger.merkleLayers.length - 1;
          const isLeafLevel = levelIndex === 0;

          if (isRootLevel) {
            const rootHash = nodes[0];
            const isRootCorrupted =
              hasTampering ||
              (sealedMerkleRoot &&
                sealedMerkleRoot.toLowerCase() !== rootHash.toLowerCase());

            return (
              <div
                key={`lvl-${levelIndex}`}
                className={`border p-3 font-mono text-xs ${
                  isRootCorrupted
                    ? 'border-red-700 bg-red-50/70 text-red-950'
                    : 'border-stone-900 bg-white text-stone-900'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-stone-500 mb-1">
                  <span className={isRootCorrupted ? 'text-red-700 font-semibold' : 'text-stone-700 font-semibold'}>
                    {isRootCorrupted
                      ? 'SEAL MISMATCH - THIS FILE DIFFERS FROM THE STELLAR BLOCKCHAIN RECORD'
                      : 'MASTER DIGITAL FINGERPRINT - LOCKED ON STELLAR BLOCKCHAIN'}
                  </span>
                  <span>256-BIT SEAL</span>
                </div>
                <div className="break-all text-[11px]">{rootHash}</div>
              </div>
            );
          }

          if (!isLeafLevel) {
            return (
              <div
                key={`lvl-${levelIndex}`}
                className="grid grid-cols-2 sm:grid-cols-5 border-t border-l border-[#D8D4CA]"
              >
                {nodes.map((nodeHash, nodeIdx) => {
                  const isCorrupted =
                    treeMetadata.corruptedByLevel[levelIndex]?.has(nodeIdx);
                  const isOnPath =
                    treeMetadata.pathNodeByLevel[levelIndex] === nodeIdx;
                  const isSibling =
                    treeMetadata.siblingNodeByLevel[levelIndex] === nodeIdx &&
                    !isOnPath;

                  return (
                    <div
                      key={`n-${levelIndex}-${nodeIdx}`}
                      className={`p-2 border-r border-b border-[#D8D4CA] text-[11px] font-mono ${
                        isCorrupted
                          ? 'bg-red-50 text-red-900 font-semibold'
                          : isOnPath
                          ? 'bg-stone-900 text-white'
                          : isSibling
                          ? 'bg-amber-50/90 text-amber-950'
                          : 'bg-[#FAF8F5] text-stone-400'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider mb-0.5">
                        <span>
                          N{levelIndex}.{nodeIdx + 1}
                        </span>
                        {isCorrupted ? (
                          <span className="text-red-700 font-bold">INVALID</span>
                        ) : isSibling ? (
                          <span className="text-amber-800 font-semibold">SIBLING</span>
                        ) : isOnPath ? (
                          <span className="text-stone-300">PATH</span>
                        ) : null}
                      </div>
                      <div className="truncate">
                        {nodeHash.slice(0, 8)}..{nodeHash.slice(-6)}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          }

          return (
            <div
              key={`lvl-0`}
              className="grid grid-cols-2 sm:grid-cols-5 border-t border-l border-[#D8D4CA]"
            >
              {ledger.rows.map((row, leafIdx) => {
                const isCorrupted = tamperedRowSet.has(leafIdx);
                const isSelected = row.rowIndex === selectedRowIndex;

                return (
                  <button
                    key={`leaf-${row.rowIndex}`}
                    type="button"
                    onClick={() => onSelectRow(row.rowIndex)}
                    className={`p-2.5 border-r border-b border-[#D8D4CA] text-left transition cursor-pointer ${
                      isCorrupted
                        ? 'bg-red-50/90 text-red-950 border-l-2 border-l-red-700'
                        : isSelected
                        ? 'bg-stone-900 text-white'
                        : 'bg-white hover:bg-stone-100/80 text-stone-800'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="font-semibold">
                        L{String(row.rowIndex).padStart(2, '0')} · {row.entryId.replace('GL-2026-', '')}
                      </span>
                      {isCorrupted && (
                        <span className="text-[9px] font-bold text-red-700 uppercase">
                          ALTERED
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-[11px] truncate mt-0.5 ${
                        isSelected ? 'text-stone-300' : 'text-stone-600'
                      }`}
                    >
                      {row.accountName}
                    </div>
                    <div
                      className={`text-[10px] font-mono mt-0.5 truncate ${
                        isCorrupted
                          ? 'text-red-700 font-bold'
                          : isSelected
                          ? 'text-white'
                          : 'text-stone-900'
                      }`}
                    >
                      {row.debitCents > 0
                        ? formatCentsToEur(row.debitCents)
                        : formatCentsToEur(row.creditCents)}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
