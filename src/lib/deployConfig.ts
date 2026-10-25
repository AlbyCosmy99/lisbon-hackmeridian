export interface DeployConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  cfoPrimaryPublic: string;
  cfoPrimarySecret: string;
  cfoBackupPublic: string;
  cfoBackupSecret: string;
  auditorDemoPublic: string;
  auditorDemoSecret: string;
  initialTxHash: string;
  initialPeriodId: string;
  sepTxHash: string;
  sepAttestTxHash: string;
}

export const DEPLOY_CONFIG: DeployConfig = {
  contractId: 'CDF4JHYPUJA67S62TVWFDLV7PDDGH4H7PGN4ANUUFLLCPZNCM76VLKED',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  cfoPrimaryPublic: 'GCRWKUA2JLX6SMWVN5DN7MGLZS473WLSC37N6F3OM6YUX2OETIU4NRNO',
  cfoPrimarySecret: 'SBBKFP2CYUDOBU4WFVSNXNF5BTVQFDGU4ESA3SH2XRCVC55HLGHHCZI7',
  cfoBackupPublic: 'GBAUL2SZ2G33EOEQ23NOBAJVL7JTNM2ZDAZ7H6RZOAIWPWLFYZRRAVVS',
  cfoBackupSecret: 'SBEAUM4SQIY4B5MJVODYF2L37LX55QUOCTCV52MNFX5Y2K52WY6RVEYP',
  auditorDemoPublic: 'GAPKNXMR5RDB3LE6HTDPATV5KB357EWNCULRYQ3NCS6M7JYPTXKPLGZG',
  auditorDemoSecret: 'SBRKDGGYWW2C4AOFZW4VLYSQZOUHPNWGO7IEC22KZIICHB6WTSWWXX7S',
  initialTxHash: 'c758ffaa31c32374139a58b75b3138b13dcd3fd70fcdbb75b9a47b8d46ef1fe1',
  initialPeriodId: '2026-10-SAP-GL',
  sepTxHash: 'd3780be9585007df8c2f2409e049dc31654b8f168191898e8e0fef356051a0ba',
  sepAttestTxHash: 'aeea5a20394f2ba3874405de4d2d552dea2172b501c7d4534becb64700a58e57',
};
