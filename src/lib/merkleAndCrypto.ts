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

function splitCsvLine(line: string, delimiter: ',' | ';' | '\t'): string[] {
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
  const cleanName = fileName.replace(
    /^(MODIFIED|ALTERED|TAMPERED|EDITED|COPY_OF)[-_ ]+/i,
    ''
  );
  const match = cleanName.match(/(20\d{2}[-_]\d{2})/);
  if (match) {
    return `${match[1].replace('_', '-')}-SAP-GL`;
  }
  const baseName = cleanName
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

  let delimiter: ',' | ';' | '\t' = ',';
  let isAccountingSchema = false;

  const isPdfFile =
    fileName.toLowerCase().endsWith('.pdf') ||
    textContent.slice(0, 16).includes('%PDF');
  const isJsonFile =
    fileName.toLowerCase().endsWith('.json') ||
    (textContent.trim().startsWith('[') && textContent.trim().includes('{'));

  if (!isPdfFile && !isJsonFile && nonEmptyLines.length >= 2) {
    const firstHeader = nonEmptyLines[0].toLowerCase();
    const tabCount = (firstHeader.match(/\t/g) || []).length;
    const semicolonCount = (firstHeader.match(/;/g) || []).length;
    const commaCount = (firstHeader.match(/,/g) || []).length;
    if (tabCount > commaCount && tabCount > semicolonCount) {
      delimiter = '\t';
    } else if (semicolonCount > commaCount) {
      delimiter = ';';
      normalizationLog.push(
        'Converted semicolon (;) regional ERP field delimiters to canonical schema'
      );
    }

    if (isCsvExtension || commaCount >= 1 || semicolonCount >= 1 || tabCount >= 1) {
      looksLikeCsv = true;
    }
  }

  const rows: LedgerRow[] = [];

  if (looksLikeCsv) {
    const rawHeaderCells = splitCsvLine(nonEmptyLines[0], delimiter);
    const headerCells = rawHeaderCells.map((h) =>
      h.toLowerCase().replace(/[^a-z0-9_]/g, '')
    );

    const findSmartCol = (
      exactMatches: string[],
      substringMatches: string[],
      excludeIndices: Set<number>
    ): number => {
      for (const candidate of exactMatches) {
        const idx = headerCells.findIndex(
          (h, i) => !excludeIndices.has(i) && h === candidate
        );
        if (idx !== -1) return idx;
      }
      for (const sub of substringMatches) {
        const idx = headerCells.findIndex(
          (h, i) => !excludeIndices.has(i) && h.includes(sub)
        );
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const usedCols = new Set<number>();

    const idxDebit = findSmartCol(
      [
        'debit_eur',
        'debit',
        'debit_amount',
        'debe_eur',
        'debe',
        'dare_eur',
        'dare',
        'outflow',
        'withdrawal',
        'expense',
      ],
      ['debit', 'debe', 'dare', 'outflow', 'withdrawal'],
      usedCols
    );
    if (idxDebit !== -1) usedCols.add(idxDebit);

    const idxCredit = findSmartCol(
      [
        'credit_eur',
        'credit',
        'credit_amount',
        'haber_eur',
        'haber',
        'avere_eur',
        'avere',
        'inflow',
        'deposit',
        'income',
        'revenue',
      ],
      ['credit', 'haber', 'avere', 'inflow', 'deposit'],
      usedCols
    );
    if (idxCredit !== -1) usedCols.add(idxCredit);

    // Single signed or unsigned Amount column (e.g. "date,description,amount")
    let idxSingleAmount = -1;
    if (idxDebit === -1 && idxCredit === -1) {
      idxSingleAmount = findSmartCol(
        [
          'amount',
          'amount_eur',
          'amount_usd',
          'total',
          'total_eur',
          'value',
          'price',
          'importe',
          'importo',
          'monto',
          'valor',
          'montant',
          'betrag',
          'sum',
          'net',
          'gross',
          'balance',
          'payment',
          'cost',
          'fee',
        ],
        ['amount', 'importe', 'importo', 'total', 'price', 'eur', 'usd', 'cost', 'sum', 'balance'],
        usedCols
      );

      // Even if header is unusual, auto-detect if a column contains signed/decimal currency numbers
      if (idxSingleAmount === -1 && nonEmptyLines.length >= 2) {
        const sampleRows = nonEmptyLines
          .slice(1, Math.min(8, nonEmptyLines.length))
          .map((l) => splitCsvLine(l, delimiter));
        for (let col = 0; col < rawHeaderCells.length; col += 1) {
          const h = headerCells[col] || '';
          if (h.includes('id') || h.includes('date') || h.includes('year') || h.includes('patent')) {
            continue;
          }
          const numericLookingCount = sampleRows.filter((r) => {
            const val = (r[col] ?? '').trim();
            return /^[+-]?[€$£]?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})$/.test(val);
          }).length;
          if (numericLookingCount >= Math.ceil(sampleRows.length * 0.6) && sampleRows.length > 0) {
            idxSingleAmount = col;
            break;
          }
        }
      }

      if (idxSingleAmount !== -1) {
        usedCols.add(idxSingleAmount);
      }
    }

    // It is an accounting/financial CSV if and only if it has Debit, Credit, or Amount column!
    if (idxDebit !== -1 || idxCredit !== -1 || idxSingleAmount !== -1) {
      isAccountingSchema = true;
    }

    if (isAccountingSchema) {
      const idxDate = findSmartCol(
        [
          'date',
          'posting_date',
          'postingdate',
          'transaction_date',
          'fecha',
          'fecha_contable',
          'data',
          'data_registrazione',
          'timestamp',
        ],
        ['date', 'fecha', 'data', 'time'],
        usedCols
      );
      if (idxDate !== -1) usedCols.add(idxDate);

      const idxEntryId = findSmartCol(
        [
          'entry_id',
          'entryid',
          'id',
          'tx_id',
          'transaction_id',
          'id_asiento',
          'asiento',
          'numero_registrazione',
          'doc_no',
          'invoice_id',
          'invoice',
          'reference',
          'ref',
        ],
        ['entry_id', 'tx_id', 'asiento', 'registrazione', 'invoice', 'ref'],
        usedCols
      );
      if (idxEntryId !== -1) usedCols.add(idxEntryId);

      const idxDescription = findSmartCol(
        [
          'description',
          'memo',
          'narrative',
          'concepto',
          'descripcion',
          'causale',
          'details',
          'item',
          'title',
          'note',
          'notes',
          'subject',
          'merchant',
          'payee',
        ],
        ['desc', 'memo', 'concept', 'causal', 'detail', 'title', 'note', 'merchant', 'item'],
        usedCols
      );
      if (idxDescription !== -1) usedCols.add(idxDescription);

      const idxAccountCode = findSmartCol(
        [
          'account_code',
          'accountcode',
          'account',
          'cuenta',
          'cod_cuenta',
          'conto',
          'codice_conto',
          'category',
          'type',
          'code',
          'gl_code',
        ],
        ['account_code', 'cod_cuenta', 'codice_conto', 'category', 'type', 'code'],
        usedCols
      );
      if (idxAccountCode !== -1) usedCols.add(idxAccountCode);

      const idxAccountName = findSmartCol(
        [
          'account_name',
          'accountname',
          'name',
          'nombre_cuenta',
          'denominacion',
          'nome_conto',
          'vendor',
          'client',
          'counterparty',
        ],
        ['account_name', 'nombre_cuenta', 'nome_conto', 'vendor', 'client', 'counterparty', 'name'],
        usedCols
      );
      if (idxAccountName !== -1) usedCols.add(idxAccountName);

      const idxCostCenter = findSmartCol(
        ['cost_center', 'costcenter', 'department', 'centro_coste', 'cdc', 'project'],
        ['cost_center', 'centro_coste', 'department', 'cdc'],
        usedCols
      );
      if (idxCostCenter !== -1) usedCols.add(idxCostCenter);

      // Check if single-amount column has both negative and positive values, or only positive values
      let singleAmountHasNegatives = false;
      if (idxSingleAmount !== -1) {
        for (let i = 1; i < nonEmptyLines.length; i += 1) {
          const c = splitCsvLine(nonEmptyLines[i], delimiter);
          const val = parseAmountToCents(c[idxSingleAmount] ?? '0');
          if (val < 0) {
            singleAmountHasNegatives = true;
            break;
          }
        }
      }

      let normalizedDateCount = 0;
      let normalizedEuroCurrencyCount = 0;
      let trimmedWhitespaceCount = 0;

      for (let i = 1; i < nonEmptyLines.length; i += 1) {
        if (nonEmptyLines[i].includes(' , ') || nonEmptyLines[i].includes(' ; ')) {
          trimmedWhitespaceCount += 1;
        }
        const cells = splitCsvLine(nonEmptyLines[i], delimiter);
        if (cells.length === 0 || cells.every((c) => !c.trim())) continue;

        const rowIndex = rows.length + 1;
        const rawDate =
          idxDate !== -1 && cells[idxDate]
            ? cells[idxDate].trim()
            : '2026-10-31';
        const { isoDate: date, wasNormalized: dateWasNormalized } =
          normalizeErpDate(rawDate);
        if (dateWasNormalized) {
          normalizedDateCount += 1;
        }

        const entryId =
          idxEntryId !== -1 && cells[idxEntryId]?.trim()
            ? cells[idxEntryId].trim()
            : `TXN-${String(rowIndex).padStart(4, '0')}`;

        let debitCents = 0;
        let creditCents = 0;

        if (idxSingleAmount !== -1) {
          const rawAmt = cells[idxSingleAmount] ?? '0';
          if (rawAmt.includes(',') || rawAmt.includes('€') || rawAmt.includes('$')) {
            normalizedEuroCurrencyCount += 1;
          }
          const signedCents = parseAmountToCents(rawAmt);
          const rowCategoryText =
            (idxAccountCode !== -1 ? cells[idxAccountCode] : '')?.toLowerCase() || '';

          if (singleAmountHasNegatives) {
            // Standard bank/cashflow CSV convention (e.g. date,description,amount):
            // Negative (-299.01) = Outflow / Expense (Debit)
            // Positive (+6500.00) = Inflow / Revenue (Credit)
            if (signedCents < 0) {
              debitCents = Math.abs(signedCents);
            } else {
              creditCents = signedCents;
            }
          } else if (
            rowCategoryText.includes('credit') ||
            rowCategoryText.includes('income') ||
            rowCategoryText.includes('revenue') ||
            rowCategoryText.includes('inflow') ||
            rowCategoryText === 'cr'
          ) {
            creditCents = Math.abs(signedCents);
          } else {
            debitCents = Math.abs(signedCents);
          }
        } else {
          const rawDebit = idxDebit !== -1 ? cells[idxDebit] ?? '0' : '0';
          const rawCredit = idxCredit !== -1 ? cells[idxCredit] ?? '0' : '0';
          if (
            rawDebit.includes(',') ||
            rawDebit.includes('€') ||
            rawCredit.includes(',') ||
            rawCredit.includes('€')
          ) {
            normalizedEuroCurrencyCount += 1;
          }
          debitCents = Math.abs(parseAmountToCents(rawDebit));
          creditCents = Math.abs(parseAmountToCents(rawCredit));
        }

        const rawDesc =
          idxDescription !== -1 && cells[idxDescription]?.trim()
            ? cells[idxDescription].trim()
            : '';

        const unmappedInfo = cells
          .map((val, cIdx) =>
            !usedCols.has(cIdx) && val.trim()
              ? `${rawHeaderCells[cIdx] || `Col ${cIdx + 1}`}: ${val.trim()}`
              : ''
          )
          .filter(Boolean)
          .join(' · ');

        const accountCode =
          idxAccountCode !== -1 && cells[idxAccountCode]?.trim()
            ? cells[idxAccountCode].trim().toUpperCase().slice(0, 14)
            : debitCents > 0 && creditCents === 0
            ? idxSingleAmount !== -1
              ? 'EXPENSE'
              : 'DEBIT'
            : creditCents > 0
            ? idxSingleAmount !== -1
              ? 'INFLOW'
              : 'CREDIT'
            : 'ENTRY';

        const accountName =
          idxAccountName !== -1 && cells[idxAccountName]?.trim()
            ? cells[idxAccountName].trim()
            : rawDesc || unmappedInfo || `Financial Entry #${rowIndex}`;

        const description =
          idxAccountName !== -1 && rawDesc
            ? rawDesc
            : unmappedInfo ||
              (debitCents > 0
                ? `Recorded Outflow / Debit (${formatCentsToEur(debitCents)})`
                : creditCents > 0
                ? `Recorded Inflow / Credit (${formatCentsToEur(creditCents)})`
                : `Recorded Entry on ${date}`);

        const costCenter =
          idxCostCenter !== -1 && cells[idxCostCenter]?.trim()
            ? cells[idxCostCenter].trim().toUpperCase()
            : 'GENERAL';

        const canonicalString = `${rowIndex}|${entryId}|${date}|${accountCode}|${accountName}|${description}|${debitCents}|${creditCents}`;
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
          `Converted ${normalizedDateCount} regional DD/MM/YYYY dates to ISO-8601 (YYYY-MM-DD)`
        );
      }
      if (normalizedEuroCurrencyCount > 0) {
        normalizationLog.push(
          `Parsed ${normalizedEuroCurrencyCount} formatted currency rows into exact integer cents`
        );
      }
      if (trimmedWhitespaceCount > 0) {
        normalizationLog.push(
          `Stripped padded spreadsheet whitespace across ${trimmedWhitespaceCount} rows`
        );
      }
    } else {
      // Generic CSV dataset (any non-financial CSV file like patents, inventory, logs, CRM)
      normalizationLog.push(
        `Ingested custom CSV schema (${rawHeaderCells.slice(0, 4).join(', ')}) into Merkle leaf tree`
      );

      const todayIso = new Date().toISOString().slice(0, 10);
      for (let i = 1; i < Math.min(nonEmptyLines.length, 61); i += 1) {
        const cells = splitCsvLine(nonEmptyLines[i], delimiter);
        if (cells.length === 0 || cells.every((c) => !c)) continue;

        const rowIndex = rows.length + 1;
        const col0 = (cells[0] ?? '').trim();
        const col1 = (cells[1] ?? '').trim();
        const col2 = (cells[2] ?? '').trim();

        const entryId =
          col0 && col0.length <= 24
            ? col0
            : `ROW-${String(rowIndex).padStart(4, '0')}`;
        const dateMatch = nonEmptyLines[i].match(/(20\d{2}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : todayIso;
        const accountCode = (rawHeaderCells[1] || rawHeaderCells[0] || 'RECORD')
          .toUpperCase()
          .replace(/[^A-Z0-9_-]/g, '')
          .slice(0, 14);
        const accountName =
          (col1 || col0 || `Dataset Record #${rowIndex}`).slice(0, 75);
        const description =
          cells
            .slice(2, 7)
            .map((c, idx) => {
              const val = c.trim();
              if (!val) return '';
              const hName = rawHeaderCells[idx + 2];
              return hName ? `${hName}: ${val}` : val;
            })
            .filter(Boolean)
            .join(' · ')
            .slice(0, 140) ||
          col2 ||
          `Custom CSV Row #${rowIndex}`;

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
  } else if (isJsonFile) {
    // Dynamic JSON array / object parser
    try {
      const parsedJson = JSON.parse(textContent);
      const items: Array<Record<string, unknown>> = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson.records || parsedJson.data || parsedJson.items || parsedJson.rows)
        ? (parsedJson.records || parsedJson.data || parsedJson.items || parsedJson.rows)
        : [parsedJson];

      const todayIso = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < Math.min(items.length, 60); i += 1) {
        const obj = items[i] || {};
        const keys = Object.keys(obj);
        const rowIndex = rows.length + 1;
        const entryId = String(
          obj.id ?? obj.entry_id ?? obj.tx_id ?? `JSON-${String(rowIndex).padStart(4, '0')}`
        ).slice(0, 24);
        const date = String(obj.date ?? obj.timestamp ?? todayIso).slice(0, 10);
        const rawAmt = obj.amount ?? obj.total ?? obj.price ?? obj.debit ?? 0;
        const cents = parseAmountToCents(String(rawAmt));
        if (cents !== 0) isAccountingSchema = true;
        const debitCents = cents < 0 ? Math.abs(cents) : cents > 0 && !obj.credit ? cents : 0;
        const creditCents = obj.credit ? Math.abs(parseAmountToCents(String(obj.credit))) : 0;
        const accountCode = String(obj.type ?? obj.category ?? obj.account ?? 'JSON').toUpperCase().slice(0, 12);
        const accountName = String(obj.description ?? obj.name ?? obj.title ?? keys.slice(0, 2).map((k) => `${k}: ${String(obj[k])}`).join(' · ')).slice(0, 75);
        const description = keys
          .slice(0, 5)
          .map((k) => `${k}: ${String(obj[k])}`)
          .join(' · ')
          .slice(0, 140);
        const canonicalString = `${rowIndex}|${entryId}|${date}|${accountCode}|${accountName}|${description}|${debitCents}|${creditCents}`;
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
          costCenter: 'JSON-DATA',
          canonicalString,
          leafHash,
        });
      }
      looksLikeCsv = true;
    } catch {
      // Fallback to binary/chunk mode below
    }
  } else if (isPdfFile) {
    // Dynamic Multi-Section PDF Document Extractor:
    // Extracts readable text clauses / page markers AND creates verifiable cryptographic sections
    const todayIso = new Date().toISOString().slice(0, 10);
    const extractedStrings: string[] = [];
    const literalRegex = /\(([^()\\]{6,120})\)/g;
    let match: RegExpExecArray | null = literalRegex.exec(textContent);
    while (match && extractedStrings.length < 30) {
      const cleaned = match[1].replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
      if (
        cleaned.length >= 6 &&
        !/^(Identity|Adobe|Mac OS|PDF| FlateDecode|Font|Type|Pages)/i.test(cleaned)
      ) {
        extractedStrings.push(cleaned);
      }
      match = literalRegex.exec(textContent);
    }

    // Divide the PDF into deterministic verifiable chunks (up to 16 sections) so every page/block has its own Merkle leaf!
    const targetChunkCount = Math.max(
      1,
      Math.min(16, Math.ceil(rawBytes.byteLength / 8192))
    );
    const chunkSize = Math.ceil(rawBytes.byteLength / targetChunkCount);

    for (let c = 0; c < targetChunkCount; c += 1) {
      const start = c * chunkSize;
      const end = Math.min(rawBytes.byteLength, start + chunkSize);
      const chunkBytes = rawBytes.subarray(start, end);
      const chunkHash = await sha256Hex(chunkBytes);
      const rowIndex = c + 1;
      const entryId = `PDF-SEC-${String(rowIndex).padStart(2, '0')}`;
      const snippet = extractedStrings[c]
        ? `Extracted Text: "${extractedStrings[c].slice(0, 85)}"`
        : `Cryptographic PDF Block (Bytes ${start.toLocaleString()} - ${end.toLocaleString()} · SHA-256: ${chunkHash.slice(0, 12)}...)`;
      const canonicalString = `${rowIndex}|${entryId}|${todayIso}|PDF-BLOCK|${chunkHash}|${start}-${end}`;
      const leafHash = await sha256Hex(`AUDITLEDGER_LEAF_V1:${canonicalString}`);

      rows.push({
        rowIndex,
        entryId,
        date: todayIso,
        accountCode: 'PDF-SECTION',
        accountName: `${fileName} - Section #${rowIndex} (${((end - start) / 1024).toFixed(1)} KB)`,
        description: snippet,
        debitCents: 0,
        creditCents: 0,
        costCenter: 'PDF-SEAL',
        canonicalString,
        leafHash,
      });
    }
    looksLikeCsv = true;
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
    modifiedRow.canonicalString = `${modifiedRow.rowIndex}|${modifiedRow.entryId}|${modifiedRow.date}|${modifiedRow.accountCode}|${modifiedRow.accountName}|${modifiedRow.description}|${modifiedRow.debitCents}|${modifiedRow.creditCents}`;
    note = `Simulated retroactive tampering on "${ledger.fileName}": Row #${modifiedRow.rowIndex} (${modifiedRow.entryId} - ${modifiedRow.accountName}) inflated by +EUR 15,000.00 after the document was sealed.`;
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
      fileName: `MODIFIED_${ledger.fileName}`,
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

export function exportTamperedCsvDownload(
  ledger: ParsedLedger
): { fileName: string; csvContent: string } {
  const targetIdx = Math.min(3, ledger.rows.length - 1);
  if (ledger.documentMode === 'accounting_gl') {
    const header =
      'entry_id,date,account_code,account_name,description,debit_eur,credit_eur,cost_center';
    const lines = ledger.rows.map((r, idx) => {
      const debit =
        idx === targetIdx && (r.debitCents > 0 || r.creditCents === 0)
          ? ((r.debitCents + 1500000) / 100).toFixed(2)
          : (r.debitCents / 100).toFixed(2);
      const credit = (r.creditCents / 100).toFixed(2);
      return `${r.entryId},${r.date},${r.accountCode},"${r.accountName.replace(
        /"/g,
        '""'
      )}","${r.description.replace(/"/g, '""')}",${debit},${credit},${r.costCenter}`;
    });
    return {
      fileName: `MODIFIED_${ledger.fileName.replace(/\.[^/.]+$/, '')}.csv`,
      csvContent: [header, ...lines].join('\n'),
    };
  }

  const header = `row_id,${ledger.rows[0]?.accountCode || 'record_key'},description`;
  const lines = ledger.rows.map((r, idx) => {
    const desc =
      idx === targetIdx ? `${r.description} [UNAUTHORIZED_EDIT]` : r.description;
    return `"${r.entryId.replace(/"/g, '""')}","${r.accountName.replace(
      /"/g,
      '""'
    )}","${desc.replace(/"/g, '""')}"`;
  });
  return {
    fileName: `MODIFIED_${ledger.fileName.replace(/\.[^/.]+$/, '')}.csv`,
    csvContent: [header, ...lines].join('\n'),
  };
}
