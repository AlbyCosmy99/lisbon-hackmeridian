export interface DemoCsvDataset {
  fileName: string;
  periodId: string;
  content: string;
}

export const OCT_2026_AUTHENTIC_CSV = [
  'entry_id,date,account_code,account_name,description,debit_eur,credit_eur,cost_center',
  'GL-2026-1001,2026-10-03,1100,Operating Cash - Millennium BCP,Enterprise SaaS Annual Licenses Collection,145000.00,0.00,TREASURY-PT',
  'GL-2026-1002,2026-10-03,4100,Recognized SaaS Subscription Revenue,Enterprise SaaS Annual Licenses Collection,0.00,145000.00,REV-EU',
  'GL-2026-1003,2026-10-11,5200,Engineering & Cryptography Payroll,October Senior Engineering & Security Payroll,68500.00,0.00,RND-LISBON',
  'GL-2026-1004,2026-10-15,6150,External IT Consulting & Cloud Infra,Dedicated Validator Nodes & HSM Hosting,42000.00,0.00,INFRA-EU',
  'GL-2026-1005,2026-10-15,1100,Operating Cash - Millennium BCP,Settlement of October Payroll & Cloud Infra,0.00,110500.00,TREASURY-PT',
  'GL-2026-1006,2026-10-21,1210,Accounts Receivable - Iberian Enterprise,Q4 Financial Compliance Module Milestone,19000.00,0.00,SALES-IB',
  'GL-2026-1007,2026-10-21,4150,Professional Implementation Revenue,Q4 Financial Compliance Module Milestone,0.00,19000.00,SALES-IB',
  'GL-2026-1008,2026-10-28,6400,External Statutory Audit & Legal Fees,Q4 Pre-Audit Regulatory Readiness Retainer,10000.00,0.00,GOV-LEGAL',
  'GL-2026-1009,2026-10-28,2110,Accounts Payable - Statutory Auditors,Accrued Statutory Audit & Legal Retainer,0.00,6500.00,GOV-LEGAL',
  'GL-2026-1010,2026-10-31,1100,Operating Cash - Millennium BCP,Immediate Settlement of Legal Retainer Portion,0.00,3500.00,TREASURY-PT',
].join('\n');

export const SEP_2026_AUTHENTIC_CSV = [
  'entry_id,date,account_code,account_name,description,debit_eur,credit_eur,cost_center',
  'GL-2026-0901,2026-09-04,1100,Operating Cash - Millennium BCP,September Institutional Subscription Settlement,132000.00,0.00,TREASURY-PT',
  'GL-2026-0902,2026-09-04,4100,Recognized SaaS Subscription Revenue,September Institutional Subscription Settlement,0.00,132000.00,REV-EU',
  'GL-2026-0903,2026-09-14,5200,Engineering & Cryptography Payroll,September Engineering & Operations Payroll,66400.00,0.00,RND-LISBON',
  'GL-2026-0904,2026-09-18,6150,External IT Consulting & Cloud Infra,Multi-Region Sovereign Cloud & Archive Nodes,39800.00,0.00,INFRA-EU',
  'GL-2026-0905,2026-09-18,1100,Operating Cash - Millennium BCP,September Payroll & Cloud Disbursement,0.00,106200.00,TREASURY-PT',
  'GL-2026-0906,2026-09-29,6310,Lisbon HQ Lease & Security Operations,Monthly Facility Lease & Biometric Vault Access,14500.00,0.00,HQ-LISBON',
  'GL-2026-0907,2026-09-29,1100,Operating Cash - Millennium BCP,Lisbon HQ Facility Settlement,0.00,14500.00,TREASURY-PT',
].join('\n');

export function getAuthenticOct2026Csv(): DemoCsvDataset {
  return {
    fileName: 'SAP_GL_2026_10_Monthly_Close.csv',
    periodId: '2026-10-SAP-GL',
    content: OCT_2026_AUTHENTIC_CSV,
  };
}

export function getAuthenticSep2026Csv(): DemoCsvDataset {
  return {
    fileName: 'SAP_GL_2026_09_Monthly_Close.csv',
    periodId: '2026-09-SAP-GL',
    content: SEP_2026_AUTHENTIC_CSV,
  };
}

export function getMacExcelResavedOct2026Csv(): DemoCsvDataset & {
  note: string;
} {
  const lines = OCT_2026_AUTHENTIC_CSV.split('\n').map((line, index) => {
    if (index === 0) {
      return line.replace(/,/g, ' , ');
    }
    const cells = line.split(',');
    cells[5] = `  ${Number.parseFloat(cells[5]).toFixed(2)} `;
    cells[6] = ` ${Number.parseFloat(cells[6]).toFixed(2)}  `;
    return `${cells.join(' , ')}   `;
  });

  return {
    fileName: 'SAP_GL_2026_10_Resaved_MacExcel.csv',
    periodId: '2026-10-SAP-GL',
    content: `${lines.join('\r\n')}\r\n\r\n`,
    note: 'CRLF line endings + padded cell whitespace injected by spreadsheet re-export. Raw file SHA-256 changes completely, while canonical accounting Merkle Root remains 100% identical.',
  };
}

export function getMessyErpOct2026Csv(): DemoCsvDataset & {
  rawPreview: string;
} {
  const messyLines = [
    'Id_Asiento;Fecha_Contable;Cod_Cuenta;Nombre_Cuenta;Concepto;Debe_EUR;Haber_EUR;Centro_Coste',
    'GL-2026-1001;03/10/2026;1100;Operating Cash - Millennium BCP;Enterprise SaaS Annual Licenses Collection;145.000,00 €;0,00 €;TREASURY-PT',
    'GL-2026-1002;03/10/2026;4100;Recognized SaaS Subscription Revenue;Enterprise SaaS Annual Licenses Collection;0,00 €;145.000,00 €;REV-EU',
    'GL-2026-1003;11/10/2026;5200;Engineering & Cryptography Payroll;October Senior Engineering & Security Payroll;68.500,00 €;0,00 €;RND-LISBON',
    'GL-2026-1004;15/10/2026;6150;External IT Consulting & Cloud Infra;Dedicated Validator Nodes & HSM Hosting;42.000,00 €;0,00 €;INFRA-EU',
    'GL-2026-1005;15/10/2026;1100;Operating Cash - Millennium BCP;Settlement of October Payroll & Cloud Infra;0,00 €;110.500,00 €;TREASURY-PT',
    'GL-2026-1006;21/10/2026;1210;Accounts Receivable - Iberian Enterprise;Q4 Financial Compliance Module Milestone;19.000,00 €;0,00 €;SALES-IB',
    'GL-2026-1007;21/10/2026;4150;Professional Implementation Revenue;Q4 Financial Compliance Module Milestone;0,00 €;19.000,00 €;SALES-IB',
    'GL-2026-1008;28/10/2026;6400;External Statutory Audit & Legal Fees;Q4 Pre-Audit Regulatory Readiness Retainer;10.000,00 €;0,00 €;GOV-LEGAL',
    'GL-2026-1009;28/10/2026;2110;Accounts Payable - Statutory Auditors;Accrued Statutory Audit & Legal Retainer;0,00 €;6.500,00 €;GOV-LEGAL',
    'GL-2026-1010;31/10/2026;1100;Operating Cash - Millennium BCP;Immediate Settlement of Legal Retainer Portion;0,00 €;3.500,00 €;TREASURY-PT',
  ].join('\r\n');

  return {
    fileName: 'SAP_Iberia_Diario_2026_10_RawExport.csv',
    periodId: '2026-10-SAP-GL',
    content: messyLines,
    rawPreview: messyLines.split('\r\n').slice(0, 4).join('\n'),
  };
}

export function getTamperedOct2026Csv(): DemoCsvDataset & {
  fraudDescription: string;
} {
  const tamperedLines = [
    'entry_id,date,account_code,account_name,description,debit_eur,credit_eur,cost_center',
    'GL-2026-1001,2026-10-03,1100,Operating Cash - Millennium BCP,Enterprise SaaS Annual Licenses Collection,145000.00,0.00,TREASURY-PT',
    'GL-2026-1002,2026-10-03,4100,Recognized SaaS Subscription Revenue,Enterprise SaaS Annual Licenses Collection,0.00,145000.00,REV-EU',
    'GL-2026-1003,2026-10-11,5200,Engineering & Cryptography Payroll,October Senior Engineering & Security Payroll,68500.00,0.00,RND-LISBON',
    'GL-2026-1004,2026-10-15,6150,External IT Consulting & Cloud Infra,Dedicated Validator Nodes & HSM Hosting,57000.00,0.00,INFRA-EU',
    'GL-2026-1005,2026-10-15,1100,Operating Cash - Millennium BCP,Settlement of October Payroll & Cloud Infra,0.00,125500.00,TREASURY-PT',
    'GL-2026-1006,2026-10-21,1210,Accounts Receivable - Iberian Enterprise,Q4 Financial Compliance Module Milestone,19000.00,0.00,SALES-IB',
    'GL-2026-1007,2026-10-21,4150,Professional Implementation Revenue,Q4 Financial Compliance Module Milestone,0.00,19000.00,SALES-IB',
    'GL-2026-1008,2026-10-28,6400,External Statutory Audit & Legal Fees,Q4 Pre-Audit Regulatory Readiness Retainer,10000.00,0.00,GOV-LEGAL',
    'GL-2026-1009,2026-10-28,2110,Accounts Payable - Statutory Auditors,Accrued Statutory Audit & Legal Retainer,0.00,6500.00,GOV-LEGAL',
    'GL-2026-1010,2026-10-31,1100,Operating Cash - Millennium BCP,Immediate Settlement of Legal Retainer Portion,0.00,3500.00,TREASURY-PT',
  ].join('\n');

  return {
    fileName: 'SAP_GL_2026_10_Altered_Consulting.csv',
    periodId: '2026-10-SAP-GL',
    content: tamperedLines,
    fraudDescription:
      'Row #4 (GL-2026-1004 External IT Consulting) inflated by +EUR 15,000.00 (from EUR 42,000.00 to EUR 57,000.00) and offset on Row #5 (GL-2026-1005 Operating Cash Credit) to disguise an unauthorized EUR 15,000.00 disbursement.',
  };
}
