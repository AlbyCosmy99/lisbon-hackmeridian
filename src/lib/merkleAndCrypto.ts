export interface LedgerRow {
  rowIndex: number;
  entryId: string;
  date: string;
  accountCode: string;
  accountName: string;
  description: string;
  debitCents: number;
  creditCents: number;
  costCenter: string;
  canonicalString: string;
  leafHash: string;
}

export interface MerkleProofStep {
  position: 'left' | 'right';
  siblingHash: string;
}

export interface RowMerkleProof {
  periodId: string;
  rowIndex: number;
  entryId: string;
  date: string;
  accountCode: string;
  accountName: string;
  description: string;
  debitFormatted: string;
  creditFormatted: string;
  canonicalString: string;
  leafHash: string;
  merkleRoot: string;
  proofPath: MerkleProofStep[];
}

export type DocumentMode = 'accounting_gl' | 'generic_csv' | 'binary_artifact';

export interface ParsedLedger {
  fileName: string;
  fileSizeBytes: number;
  periodId: string;
  documentMode: DocumentMode;
  rawFileHash: string;
  merkleRoot: string;
  commitmentHash: string;
  rows: LedgerRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  isBalanced: boolean;
  balanceDeltaCents: number;
  merkleLayers: string[][];
  normalizationLog: string[];
  isDirtyInputNormalized: boolean;
}

export interface RowDiffItem {
  rowIndex: number;
  entryId: string;
  accountName: string;
  field: string;
  sealedValue: string;
  uploadedValue: string;
  deltaFormatted: string;
  sealedLeafHash: string;
  uploadedLeafHash: string;
}

export interface TamperXRayReport {
  hasRowCountMismatch: boolean;
  sealedRowCount: number;
  uploadedRowCount: number;
  modifiedRows: RowDiffItem[];
  intactRowCount: number;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatCentsToEur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absCents = Math.abs(Math.round(cents));
  const euros = Math.floor(absCents / 100);
  const remainderCents = absCents % 100;
  const formattedEuros = euros.toLocaleString('en-US');
  const formattedCents = remainderCents.toString().padStart(2, '0');
  return `${sign}EUR ${formattedEuros}.${formattedCents}`;
}

export function parseAmountToCents(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  // Keep only digits, comma, dot, and minus sign
  let numeric = trimmed.replace(/[^0-9.,-]/g, '');
  if (!numeric) return 0;

  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // European format: "145.000,00" -> remove dots, replace comma with dot
      numeric = numeric.replace(/\./g, '').replace(',', '.');
    } else {
      // US/UK format: "145,000.00" -> remove commas
      numeric = numeric.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only comma present: check if it looks like decimal separator (e.g. "0,00" or "145000,00")
    const parts = numeric.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      numeric = `${parts[0]}.${parts[1]}`;
    } else {
      numeric = numeric.replace(/,/g, '');
    }
  }

  const parsed = Number.parseFloat(numeric);
  if (Number.isNaN(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function normalizeErpDate(rawDate: string): {
  isoDate: string;
  wasNormalized: boolean;
} {
  const trimmed = rawDate.trim();
  // Match DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return {
      isoDate: `${year}-${month}-${day}`,
      wasNormalized: true,
    };
  }
  return {
    isoDate: trimmed || '2026-10-31',
    wasNormalized: false,
  };
}

function splitCsvLine(line: string, delimiter: ',' | ';'): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export async function buildMerkleLayers(leafHashes: string[]): Promise<string[][]> {
  if (leafHashes.length === 0) {
    const emptyRoot = await sha256Hex('AUDITLEDGER_EMPTY_TREE_V1');
    return [[emptyRoot]];
  }

  const layers: string[][] = [leafHashes.slice()];
  let currentLayer = leafHashes.slice();

  while (currentLayer.length > 1) {
    const workingLayer = currentLayer.slice();
    if (workingLayer.length % 2 === 1) {
      workingLayer.push(workingLayer[workingLayer.length - 1]);
    }
    const nextLayer: string[] = [];
    for (let i = 0; i < workingLayer.length; i += 2) {
      const left = workingLayer[i];
      const right = workingLayer[i + 1];
      const parentHash = await sha256Hex(
        `AUDITLEDGER_NODE_V1:${left}:${right}`
      );
      nextLayer.push(parentHash);
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return layers;
}

function inferPeriodId(fileName: string, override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const match = fileName.match(/(20\d{2}[-_]\d{2})/);
  if (match) {
    return `${match[1].replace('_', '-')}-SAP-GL`;
  }
  const baseName = fileName
    .replace(/\.[^/.]+$/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return baseName ? `DOC-${baseName}` : '2026-10-SAP-GL';
}

export async function processLedgerContent(
  fileName: string,
  content: string | Uint8Array,
  periodIdOverride?: string
): Promise<ParsedLedger> {
  const rawBytes =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const rawFileHash = await sha256Hex(rawBytes);
  const periodId = inferPeriodId(fileName, periodIdOverride);
  const normalizationLog: string[] = [];

  let textContent = '';
  let looksLikeCsv = false;
  const isCsvExtension = fileName.toLowerCase().endsWith('.csv');

  if (typeof content === 'string') {
    textContent = content;
  } else {
    try {
      // Slice to first 256 KB for fast tabular row extraction on huge files (e.g. 15 MB CSVs)
      // while rawFileHash above still hashes 100% of rawBytes!
      const previewSlice =
        content.byteLength > 262144 ? content.subarray(0, 262144) : content;
      textContent = new TextDecoder('utf-8', { fatal: false }).decode(previewSlice);
    } catch {
      textContent = '';
    }
  }

  if (textContent.includes('\r\n')) {
    normalizationLog.push(
      'Normalized CRLF (\\r\\n) spreadsheet line endings to canonical LF'
    );
  }

  const allNonEmptyLines = textContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Cap at header + 100 rows for instant UI and Merkle tree rendering on massive CSV dumps
  const nonEmptyLines = allNonEmptyLines.slice(0, 101);

  let delimiter: ',' | ';' = ',';
  let isAccountingSchema = false;

  if (nonEmptyLines.length >= 2) {
    const firstHeader = nonEmptyLines[0].toLowerCase();
    const semicolonCount = (firstHeader.match(/;/g) || []).length;
    const commaCount = (firstHeader.match(/,/g) || []).length;
    if (semicolonCount > commaCount) {
      delimiter = ';';
      normalizationLog.push(
        'Converted semicolon (;) regional ERP field delimiters to canonical schema'
      );
    }

    if (
      firstHeader.includes('entry_id') ||
      firstHeader.includes('date') ||
      firstHeader.includes('debit') ||
      firstHeader.includes('account') ||
      firstHeader.includes('id_asiento') ||
      firstHeader.includes('fecha') ||
      firstHeader.includes('debe') ||
      firstHeader.includes('cuenta') ||
      firstHeader.includes('registrazione') ||
      firstHeader.includes('dare')
    ) {
      looksLikeCsv = true;
      isAccountingSchema = true;
    } else if (isCsvExtension || commaCount >= 1 || semicolonCount >= 1) {
      looksLikeCsv = true;
    }
  }

  const rows: LedgerRow[] = [];

  if (looksLikeCsv && isAccountingSchema) {
    const rawHeaderCells = splitCsvLine(nonEmptyLines[0], delimiter);
    const headerCells = rawHeaderCells.map((h) =>
      h.toLowerCase().replace(/[^a-z0-9_]/g, '')
    );

    const nonEnglishHeaders = headerCells.filter((h) =>
      [
        'id_asiento',
        'asiento',
        'fecha',
        'fecha_contable',
        'cuenta',
        'cod_cuenta',
        'nombre_cuenta',
        'concepto',
        'debe_eur',
        'debe',
        'haber_eur',
        'haber',
        'centro_coste',
        'numero_registrazione',
        'data_registrazione',
        'codice_conto',
        'dare_eur',
        'avere_eur',
      ].includes(h)
    );

    if (nonEnglishHeaders.length > 0) {
      normalizationLog.push(
        `Mapped localized ERP column headers (${rawHeaderCells.slice(0, 4).join(', ')}...) to canonical AuditLedger schema`
      );
    }

    const findColIndex = (candidates: string[], fallbackIndex: number): number => {
      for (const candidate of candidates) {
        const idx = headerCells.indexOf(candidate);
        if (idx !== -1) return idx;
      }
      return fallbackIndex;
    };

    const idxEntryId = findColIndex(
      [
        'entry_id',
        'entryid',
        'id',
        'id_asiento',
        'asiento',
        'numero_registrazione',
        'doc_no',
      ],
      0
    );
    const idxDate = findColIndex(
      [
        'date',
        'posting_date',
        'postingdate',
        'fecha',
        'fecha_contable',
        'data',
        'data_registrazione',
      ],
      1
    );
    const idxAccountCode = findColIndex(
      [
        'account_code',
        'accountcode',
        'account',
        'cuenta',
        'cod_cuenta',
        'conto',
        'codice_conto',
      ],
      2
    );
    const idxAccountName = findColIndex(
      [
        'account_name',
        'accountname',
        'name',
        'nombre_cuenta',
        'denominacion',
        'nome_conto',
      ],
      3
    );
    const idxDescription = findColIndex(
      [
        'description',
        'memo',
        'narrative',
        'concepto',
        'descripcion',
        'causale',
      ],
      4
    );
    const idxDebit = findColIndex(
      [
        'debit_eur',
        'debit',
        'debit_amount',
        'debe_eur',
        'debe',
        'dare_eur',
        'dare',
      ],
      5
    );
    const idxCredit = findColIndex(
      [
        'credit_eur',
        'credit',
        'credit_amount',
        'haber_eur',
        'haber',
        'avere_eur',
        'avere',
      ],
      6
    );
    const idxCostCenter = findColIndex(
      ['cost_center', 'costcenter', 'department', 'centro_coste', 'cdc'],
      7
    );

    let normalizedDateCount = 0;
    let normalizedEuroCurrencyCount = 0;
    let trimmedWhitespaceCount = 0;

    for (let i = 1; i < nonEmptyLines.length; i += 1) {
      if (nonEmptyLines[i].includes(' , ') || nonEmptyLines[i].includes(' ; ')) {
        trimmedWhitespaceCount += 1;
      }
      const cells = splitCsvLine(nonEmptyLines[i], delimiter);
      if (cells.length < 3) continue;

      const rowIndex = rows.length + 1;
      const entryId = (cells[idxEntryId] ?? `GL-${rowIndex}`).trim();
      const rawDate = (cells[idxDate] ?? '2026-10-31').trim();
      const { isoDate: date, wasNormalized: dateWasNormalized } =
        normalizeErpDate(rawDate);
      if (dateWasNormalized) {
        normalizedDateCount += 1;
      }

      const accountCode = (cells[idxAccountCode] ?? '0000').trim().toUpperCase();
      const accountName = (cells[idxAccountName] ?? 'General Account').trim();
      const description = (cells[idxDescription] ?? '').trim();

      const rawDebit = cells[idxDebit] ?? '0';
      const rawCredit = cells[idxCredit] ?? '0';
      if (
        rawDebit.includes(',') ||
        rawDebit.includes('€') ||
        rawCredit.includes(',') ||
        rawCredit.includes('€')
      ) {
        normalizedEuroCurrencyCount += 1;
      }

      const debitCents = parseAmountToCents(rawDebit);
      const creditCents = parseAmountToCents(rawCredit);
      const costCenter = (cells[idxCostCenter] ?? 'HQ-LISBON').trim().toUpperCase();

      const canonicalString = `${rowIndex}|${entryId}|${date}|${accountCode}|${debitCents}|${creditCents}`;
      const leafHash = await sha256Hex(`AUDITLEDGER_LEAF_V1:${canonicalString}`);

      rows.push({
        rowIndex,
        entryId,
        date,
        accountCode,
        accountName,
        description,
        debitCents,
        creditCents,
        costCenter,
        canonicalString,
        leafHash,
      });
    }

    if (normalizedDateCount > 0) {
      normalizationLog.push(
        `Converted ${normalizedDateCount} regional DD/MM/YYYY posting dates to ISO-8601 (YYYY-MM-DD)`
      );
    }
    if (normalizedEuroCurrencyCount > 0) {
      normalizationLog.push(
        `Parsed ${normalizedEuroCurrencyCount} formatted European currency rows (e.g. 145.000,00 EUR) into exact integer cents`
      );
    }
    if (trimmedWhitespaceCount > 0) {
      normalizationLog.push(
        `Stripped padded spreadsheet whitespace across ${trimmedWhitespaceCount} rows`
      );
    }
  } else if (looksLikeCsv) {
    // Generic CSV dataset (any custom uploaded CSV file)
    const rawHeaderCells = splitCsvLine(nonEmptyLines[0], delimiter);
    normalizationLog.push(
      `Ingested custom CSV schema (${rawHeaderCells.slice(0, 4).join(', ')}) into Merkle leaf tree`
    );

    const todayIso = new Date().toISOString().slice(0, 10);
    for (let i = 1; i < Math.min(nonEmptyLines.length, 51); i += 1) {
      const cells = splitCsvLine(nonEmptyLines[i], delimiter);
      if (cells.length === 0 || cells.every((c) => !c)) continue;

      const rowIndex = rows.length + 1;
      const col0 = (cells[0] ?? '').trim();
      const col1 = (cells[1] ?? '').trim();
      const col2 = (cells[2] ?? '').trim();
      const col3 = (cells[3] ?? '').trim();

      const entryId =
        col0 && col0.length <= 24
          ? col0
          : `ROW-${String(rowIndex).padStart(4, '0')}`;
      const dateMatch = nonEmptyLines[i].match(/(20\d{2}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : todayIso;
      const accountCode = (rawHeaderCells[1] || 'CSV-COL1')
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 12);
      const accountName =
        (col1 || col0 || `Dataset Record #${rowIndex}`).slice(0, 65);
      const description =
        cells
          .slice(2, 6)
          .filter(Boolean)
          .join(' · ')
          .slice(0, 110) ||
        col2 ||
        col3 ||
        `Custom CSV Row #${rowIndex}`;

      // Deterministic balanced value or parsed numeric column so the dataset reconciles cleanly
      const canonicalString = `${rowIndex}|${entryId}|${date}|${accountCode}|${accountName}|${description}`;
      const leafHash = await sha256Hex(`AUDITLEDGER_LEAF_V1:${canonicalString}`);

      rows.push({
        rowIndex,
        entryId,
        date,
        accountCode,
        accountName,
        description,
        debitCents: 0,
        creditCents: 0,
        costCenter: 'CUSTOM-CSV',
        canonicalString,
        leafHash,
      });
    }
  }

  if (rows.length === 0) {
    const rowIndex = 1;
    const entryId = 'BIN-PAYLOAD-0001';
    const date = new Date().toISOString().slice(0, 10);
    const accountCode = 'BIN-DOC';
    const accountName = 'Binary Audit Artifact Payload';
    const description = `Binary document (${fileName}, ${rawBytes.byteLength} bytes, sha256=${rawFileHash.slice(0, 16)}...)`;
    const debitCents = 0;
    const creditCents = 0;
    const costCenter = 'BINARY-SEAL';
    const canonicalString = `${rowIndex}|${entryId}|${date}|${accountCode}|${debitCents}|${creditCents}|${rawFileHash}`;
    const leafHash = await sha256Hex(`AUDITLEDGER_LEAF_V1:${canonicalString}`);

    rows.push({
      rowIndex,
      entryId,
      date,
      accountCode,
      accountName,
      description,
      debitCents,
      creditCents,
      costCenter,
      canonicalString,
      leafHash,
    });
  }

  const totalDebitCents = rows.reduce((sum, r) => sum + r.debitCents, 0);
  const totalCreditCents = rows.reduce((sum, r) => sum + r.creditCents, 0);
  const balanceDeltaCents = totalDebitCents - totalCreditCents;
  const isBalanced = balanceDeltaCents === 0;

  let documentMode: DocumentMode = 'binary_artifact';
  if (looksLikeCsv && isAccountingSchema) {
    documentMode = 'accounting_gl';
  } else if (looksLikeCsv && rows.length > 0 && rows[0].entryId !== 'BIN-PAYLOAD-0001') {
    documentMode = 'generic_csv';
  }

  const merkleLayers = await buildMerkleLayers(rows.map((r) => r.leafHash));
  const merkleRoot = merkleLayers[merkleLayers.length - 1][0];
  const commitmentHash = await sha256Hex(
    `AUDITLEDGER_COMMIT_V1:${periodId}:${totalDebitCents}:${totalCreditCents}`
  );

  return {
    fileName,
    fileSizeBytes: rawBytes.byteLength,
    periodId,
    documentMode,
    rawFileHash,
    merkleRoot,
    commitmentHash,
    rows,
    totalDebitCents,
    totalCreditCents,
    isBalanced,
    balanceDeltaCents,
    merkleLayers,
    normalizationLog,
    isDirtyInputNormalized: normalizationLog.length > 0,
  };
}

export function generateRowMerkleProof(
  ledger: ParsedLedger,
  rowIndex: number
): RowMerkleProof {
  const zeroBasedIndex = Math.max(
    0,
    Math.min(ledger.rows.length - 1, rowIndex - 1)
  );
  const row = ledger.rows[zeroBasedIndex];
  const proofPath: MerkleProofStep[] = [];

  let idx = zeroBasedIndex;
  for (let level = 0; level < ledger.merkleLayers.length - 1; level += 1) {
    const layer = ledger.merkleLayers[level];
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;
    const siblingHash =
      siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];

    proofPath.push({
      position: isRightNode ? 'left' : 'right',
      siblingHash,
    });

    idx = Math.floor(idx / 2);
  }

  return {
    periodId: ledger.periodId,
    rowIndex: row.rowIndex,
    entryId: row.entryId,
    date: row.date,
    accountCode: row.accountCode,
    accountName: row.accountName,
    description: row.description,
    debitFormatted: formatCentsToEur(row.debitCents),
    creditFormatted: formatCentsToEur(row.creditCents),
    canonicalString: row.canonicalString,
    leafHash: row.leafHash,
    merkleRoot: ledger.merkleRoot,
    proofPath,
  };
}

export async function verifyRowMerkleProof(
  proof: RowMerkleProof,
  expectedMerkleRoot?: string
): Promise<{
  valid: boolean;
  computedRoot: string;
  recalculatedLeafHash: string;
}> {
  const recalculatedLeafHash = await sha256Hex(
    `AUDITLEDGER_LEAF_V1:${proof.canonicalString}`
  );
  let currentHash = recalculatedLeafHash;

  for (const step of proof.proofPath) {
    if (step.position === 'left') {
      currentHash = await sha256Hex(
        `AUDITLEDGER_NODE_V1:${step.siblingHash}:${currentHash}`
      );
    } else {
      currentHash = await sha256Hex(
        `AUDITLEDGER_NODE_V1:${currentHash}:${step.siblingHash}`
      );
    }
  }

  const targetRoot = (expectedMerkleRoot ?? proof.merkleRoot).toLowerCase();
  const valid =
    recalculatedLeafHash === proof.leafHash.toLowerCase() &&
    currentHash.toLowerCase() === targetRoot;

  return {
    valid,
    computedRoot: currentHash,
    recalculatedLeafHash,
  };
}

export function runTamperXRay(
  sealedLedger: ParsedLedger,
  uploadedLedger: ParsedLedger
): TamperXRayReport {
  const maxRows = Math.max(sealedLedger.rows.length, uploadedLedger.rows.length);
  const modifiedRows: RowDiffItem[] = [];
  let intactRowCount = 0;

  for (let i = 0; i < maxRows; i += 1) {
    const sealedRow = sealedLedger.rows[i];
    const uploadedRow = uploadedLedger.rows[i];

    if (!sealedRow && uploadedRow) {
      modifiedRows.push({
        rowIndex: uploadedRow.rowIndex,
        entryId: uploadedRow.entryId,
        accountName: uploadedRow.accountName,
        field: 'Unsealed Extra Row Injected',
        sealedValue: 'NOT PRESENT',
        uploadedValue: `${formatCentsToEur(uploadedRow.debitCents)} Dr / ${formatCentsToEur(uploadedRow.creditCents)} Cr`,
        deltaFormatted: `+${formatCentsToEur(uploadedRow.debitCents - uploadedRow.creditCents)}`,
        sealedLeafHash: 'NONE',
        uploadedLeafHash: uploadedRow.leafHash,
      });
      continue;
    }

    if (sealedRow && !uploadedRow) {
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: sealedRow.accountName,
        field: 'Sealed Row Deleted',
        sealedValue: `${formatCentsToEur(sealedRow.debitCents)} Dr / ${formatCentsToEur(sealedRow.creditCents)} Cr`,
        uploadedValue: 'DELETED',
        deltaFormatted: `-${formatCentsToEur(sealedRow.debitCents - sealedRow.creditCents)}`,
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: 'NONE',
      });
      continue;
    }

    if (sealedRow.leafHash === uploadedRow.leafHash) {
      intactRowCount += 1;
      continue;
    }

    if (sealedRow.debitCents !== uploadedRow.debitCents) {
      const diffCents = uploadedRow.debitCents - sealedRow.debitCents;
      const sign = diffCents >= 0 ? '+' : '';
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: uploadedRow.accountName || sealedRow.accountName,
        field: 'Debit Amount',
        sealedValue: formatCentsToEur(sealedRow.debitCents),
        uploadedValue: formatCentsToEur(uploadedRow.debitCents),
        deltaFormatted: `${sign}${formatCentsToEur(diffCents)}`,
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: uploadedRow.leafHash,
      });
    }

    if (sealedRow.creditCents !== uploadedRow.creditCents) {
      const diffCents = uploadedRow.creditCents - sealedRow.creditCents;
      const sign = diffCents >= 0 ? '+' : '';
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: uploadedRow.accountName || sealedRow.accountName,
        field: 'Credit Amount',
        sealedValue: formatCentsToEur(sealedRow.creditCents),
        uploadedValue: formatCentsToEur(uploadedRow.creditCents),
        deltaFormatted: `${sign}${formatCentsToEur(diffCents)}`,
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: uploadedRow.leafHash,
      });
    }

    if (sealedRow.accountCode !== uploadedRow.accountCode) {
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: uploadedRow.accountName || sealedRow.accountName,
        field: 'Account Code',
        sealedValue: sealedRow.accountCode,
        uploadedValue: uploadedRow.accountCode,
        deltaFormatted: 'Account Reclassified',
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: uploadedRow.leafHash,
      });
    }

    if (sealedRow.date !== uploadedRow.date) {
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: uploadedRow.accountName || sealedRow.accountName,
        field: 'Posting Date',
        sealedValue: sealedRow.date,
        uploadedValue: uploadedRow.date,
        deltaFormatted: 'Backdated / Shifted',
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: uploadedRow.leafHash,
      });
    }

    if (
      sealedRow.debitCents === uploadedRow.debitCents &&
      sealedRow.creditCents === uploadedRow.creditCents &&
      sealedRow.accountCode === uploadedRow.accountCode &&
      sealedRow.date === uploadedRow.date
    ) {
      modifiedRows.push({
        rowIndex: sealedRow.rowIndex,
        entryId: sealedRow.entryId,
        accountName: uploadedRow.accountName || sealedRow.accountName,
        field: 'Row Content',
        sealedValue: sealedRow.description,
        uploadedValue: uploadedRow.description,
        deltaFormatted: 'Content Modified',
        sealedLeafHash: sealedRow.leafHash,
        uploadedLeafHash: uploadedRow.leafHash,
      });
    }
  }

  return {
    hasRowCountMismatch: sealedLedger.rows.length !== uploadedLedger.rows.length,
    sealedRowCount: sealedLedger.rows.length,
    uploadedRowCount: uploadedLedger.rows.length,
    modifiedRows,
    intactRowCount,
  };
}

export async function editSpecificRowInLedger(
  ledger: ParsedLedger,
  targetRowIndex: number,
  customInput: string
): Promise<{ tamperedLedger: ParsedLedger; note: string }> {
  const clonedRows: LedgerRow[] = ledger.rows.map((r) => ({ ...r }));
  const targetIdx = clonedRows.findIndex((r) => r.rowIndex === targetRowIndex);
  const idx = targetIdx >= 0 ? targetIdx : 0;
  const modifiedRow = { ...clonedRows[idx] };
  let note = '';

  const trimmed = customInput.trim();
  const parsedNum = Number(trimmed.replace(/[^0-9.-]/g, ''));

  if (
    ledger.documentMode === 'accounting_gl' &&
    !Number.isNaN(parsedNum) &&
    trimmed !== '' &&
    /^[0-9.,+-]+$/.test(trimmed)
  ) {
    const newCents = Math.round(Math.abs(parsedNum) * 100);
    if (modifiedRow.creditCents > 0 && modifiedRow.debitCents === 0) {
      modifiedRow.creditCents = newCents;
    } else {
      modifiedRow.debitCents = newCents;
    }
    modifiedRow.canonicalString = `${modifiedRow.rowIndex}|${modifiedRow.entryId}|${modifiedRow.date}|${modifiedRow.accountCode}|${modifiedRow.debitCents}|${modifiedRow.creditCents}`;
    note = `Live Tamper Test on "${ledger.fileName}": Row #${modifiedRow.rowIndex} (${modifiedRow.entryId}) amount was changed to ${formatCentsToEur(newCents)} after the document was sealed on Stellar.`;
  } else {
    modifiedRow.description = trimmed || `${modifiedRow.description} [EDITED]`;
    modifiedRow.canonicalString = `${modifiedRow.canonicalString}|EDITED:${modifiedRow.description}`;
    note = `Live Tamper Test on "${ledger.fileName}": Row #${modifiedRow.rowIndex} (${modifiedRow.entryId}) text was changed to "${modifiedRow.description}" after the document was sealed on Stellar.`;
  }

  modifiedRow.leafHash = await sha256Hex(
    `AUDITLEDGER_LEAF_V1:${modifiedRow.canonicalString}`
  );
  clonedRows[idx] = modifiedRow;

  const merkleLayers = await buildMerkleLayers(clonedRows.map((r) => r.leafHash));
  const merkleRoot = merkleLayers[merkleLayers.length - 1][0];
  const rawFileHash = await sha256Hex(`${ledger.rawFileHash}:LIVE_EDIT:${targetRowIndex}:${trimmed}`);
  const totalDebitCents = clonedRows.reduce((sum, r) => sum + r.debitCents, 0);
  const totalCreditCents = clonedRows.reduce((sum, r) => sum + r.creditCents, 0);

  return {
    tamperedLedger: {
      ...ledger,
      rawFileHash,
      merkleRoot,
      rows: clonedRows,
      totalDebitCents,
      totalCreditCents,
      merkleLayers,
    },
    note,
  };
}

export async function processMultipleFilesBatch(
  files: Array<{ name: string; bytes: Uint8Array }>
): Promise<ParsedLedger> {
  if (files.length === 1) {
    return processLedgerContent(files[0].name, files[0].bytes);
  }

  const parsedList = await Promise.all(
    files.map((f) => processLedgerContent(f.name, f.bytes))
  );

  const combinedRows: LedgerRow[] = [];
  for (const item of parsedList) {
    for (const r of item.rows.slice(0, 25)) {
      const rowIndex = combinedRows.length + 1;
      const entryId = `${item.fileName.slice(0, 12)}#${r.rowIndex}`;
      const canonicalString = `${rowIndex}|${item.fileName}|${r.canonicalString}`;
      const leafHash = await sha256Hex(`AUDITLEDGER_LEAF_V1:${canonicalString}`);
      combinedRows.push({
        ...r,
        rowIndex,
        entryId,
        accountName: `[${item.fileName}] ${r.accountName}`,
        canonicalString,
        leafHash,
      });
    }
  }

  const totalSize = files.reduce((acc, f) => acc + f.bytes.byteLength, 0);
  const batchHashInput = parsedList.map((p) => p.rawFileHash).join(':');
  const rawFileHash = await sha256Hex(`AUDITLEDGER_BATCH_V1:${batchHashInput}`);
  const merkleLayers = await buildMerkleLayers(combinedRows.map((r) => r.leafHash));
  const merkleRoot = merkleLayers[merkleLayers.length - 1][0];
  const periodId = `BATCH-${files.length}-FILES`;
  const totalDebitCents = combinedRows.reduce((s, r) => s + r.debitCents, 0);
  const totalCreditCents = combinedRows.reduce((s, r) => s + r.creditCents, 0);
  const commitmentHash = await sha256Hex(
    `AUDITLEDGER_COMMIT_V1:${periodId}:${totalDebitCents}:${totalCreditCents}`
  );
  const allAccounting = parsedList.every((p) => p.documentMode === 'accounting_gl');

  return {
    fileName: `Bulk Batch (${files.length} Files: ${files
      .map((f) => f.name)
      .slice(0, 2)
      .join(', ')}${files.length > 2 ? '...' : ''})`,
    fileSizeBytes: totalSize,
    periodId,
    documentMode: allAccounting ? 'accounting_gl' : 'generic_csv',
    rawFileHash,
    merkleRoot,
    commitmentHash,
    rows: combinedRows,
    totalDebitCents,
    totalCreditCents,
    isBalanced: totalDebitCents === totalCreditCents,
    balanceDeltaCents: totalDebitCents - totalCreditCents,
    merkleLayers,
    normalizationLog: [
      `Combined ${files.length} files (${combinedRows.length} total records) into a single Bulk Merkle Root for 1-click Soroban sealing`,
    ],
    isDirtyInputNormalized: true,
  };
}

export async function createTamperedCloneOfLedger(
  ledger: ParsedLedger
): Promise<{ tamperedLedger: ParsedLedger; note: string }> {
  const clonedRows: LedgerRow[] = ledger.rows.map((r) => ({ ...r }));
  const targetIdx = Math.min(3, clonedRows.length - 1);
  const row = clonedRows[targetIdx];

  const modifiedRow = { ...row };
  let note = '';

  if (modifiedRow.debitCents > 0 || modifiedRow.creditCents > 0) {
    modifiedRow.debitCents += 1500000;
    modifiedRow.canonicalString = `${modifiedRow.rowIndex}|${modifiedRow.entryId}|${modifiedRow.date}|${modifiedRow.accountCode}|${modifiedRow.debitCents}|${modifiedRow.creditCents}`;
    note = `Simulated retroactive tampering on "${ledger.fileName}": Row #${modifiedRow.rowIndex} (${modifiedRow.entryId}) inflated by +EUR 15,000.00 after the document was sealed.`;
  } else {
    modifiedRow.description = `${modifiedRow.description} [UNAUTHORIZED_EDIT]`;
    modifiedRow.canonicalString = `${modifiedRow.canonicalString}|TAMPERED`;
    note = `Simulated retroactive tampering on "${ledger.fileName}": Row #${modifiedRow.rowIndex} (${modifiedRow.entryId} - ${modifiedRow.accountName}) payload altered after the document was sealed.`;
  }

  modifiedRow.leafHash = await sha256Hex(
    `AUDITLEDGER_LEAF_V1:${modifiedRow.canonicalString}`
  );
  clonedRows[targetIdx] = modifiedRow;

  const merkleLayers = await buildMerkleLayers(clonedRows.map((r) => r.leafHash));
  const merkleRoot = merkleLayers[merkleLayers.length - 1][0];
  const rawFileHash = await sha256Hex(`${ledger.rawFileHash}:TAMPERED`);
  const totalDebitCents = clonedRows.reduce((sum, r) => sum + r.debitCents, 0);
  const totalCreditCents = clonedRows.reduce((sum, r) => sum + r.creditCents, 0);

  return {
    tamperedLedger: {
      ...ledger,
      fileName: `ALTERED_${ledger.fileName}`,
      rawFileHash,
      merkleRoot,
      rows: clonedRows,
      totalDebitCents,
      totalCreditCents,
      merkleLayers,
    },
    note,
  };
}
