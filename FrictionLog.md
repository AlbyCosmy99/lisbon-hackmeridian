# HackMeridian 2026 Lisbon - Stellar Developer Friction Log (`FrictionLog.md`)

* **Project**: **AuditLedger** - Trustless B2B Financial Audit, Canonical Merkle Notarization & Row-Level Tamper X-Ray on Stellar Soroban
* **Hackathon Path & Track**: `Genesis (Idea -> MVP)` | `Stellar Unlocked`
* **Repository**: `https://github.com/AlbyCosmy99/lisbon-hackmeridian`
* **Live Testnet Smart Contract (v2)**: [`CDF4JHYPUJA67S62TVWFDLV7PDDGH4H7PGN4ANUUFLLCPZNCM76VLKED`](https://stellar.expert/explorer/testnet/contract/CDF4JHYPUJA67S62TVWFDLV7PDDGH4H7PGN4ANUUFLLCPZNCM76VLKED)
* **Contract Deployment TX**: [`bc3f7c540850c9e1e16d8a1d7a73c83fbaa473eb46bd91d7cae5ffb542cefb2b`](https://stellar.expert/explorer/testnet/tx/bc3f7c540850c9e1e16d8a1d7a73c83fbaa473eb46bd91d7cae5ffb542cefb2b)

---

## 1. What We Built & Which Stellar Tools We Used

### Summary of What We Built
At HackMeridian 2026 in Lisbon, we built **AuditLedger**, a client-side, GDPR-safe B2B financial auditing and document sealing platform anchored on **Stellar Soroban**. It solves the corporate "retroactive cover-up" problem in ERP General Ledgers (`SAP`, `Oracle NetSuite`, `Holded`) and statutory audit workflows:

1. **Dual-Hashing Engine (`Raw Binary SHA-256` + `Canonical Accounting Merkle Root`)**: Normalizes regional CSV, JSON, and PDF financial exports (`\r\n` vs `\n`, `;` vs `,`, `DD/MM/YYYY` vs `ISO-8601`, European vs US currency formatting) inside the browser via the Web Crypto API so that re-saving a spreadsheet in Excel on macOS or Windows never breaks cryptographic verification against the Stellar blockchain.
2. **Constant-Cost `O(1)` On-Chain Sealing on Soroban**: Whether a general ledger contains 10 rows or 10,000 rows, AuditLedger aggregates all row leaf hashes into a single 32-byte Merkle Root and anchors three 32-byte digests (`doc_hash`, `merkle_root`, `commitment_hash`) in a single Soroban transaction (`~0.00001 XLM`, 3-5 second finality, zero plaintext PII on-chain).
3. **Bilateral On-Chain Audit Attestation (`notarize` + `attest_audit`)**: The company CFO freezes the monthly close (`notarize`), and the External Statutory Auditor independently verifies the file and co-signs the record on-chain (`attest_audit`).
4. **Merkle Tamper X-Ray & Single-Row Zero-Leakage Proofs (`O(log N)`)**: Pinpoints the exact manipulated row, account code, and EUR delta if a single number is altered after closing, and generates standalone `O(log N)` Merkle sibling proofs to verify a single invoice row without exposing the rest of the balance sheet.

### Stellar Tools We Used & How We Used Each One

| Stellar Tool / Component | Version / Endpoint | How We Used It in AuditLedger |
| :--- | :--- | :--- |
| **Soroban Smart Contracts (`soroban-sdk`)** | `22.0.8` (`#![no_std]` Rust) | Built `AuditLedgerContract` (`contracts/audit-ledger/src/lib.rs`) using `#[contract]`, `#[contractimpl]`, `#[contracttype]`, `#[contracterror]`, `issuer.require_auth()`, `auditor.require_auth()`, persistent triple-indexed storage (`ByHash`, `ByMerkle`, `ByPeriod`, `History`), `extend_ttl()`, native `env.crypto().sha256()`, and `env.events().publish()`. |
| **Stellar CLI (`stellar contract`)** | `v22.x` | Compiled optimized WASM (`stellar contract build` targeting `wasm32v1-none`), ran unit tests (`cargo test`), deployed the smart contract to Stellar Testnet, and invoked test closes (`notarize`, `attest_audit`). |
| **JavaScript Stellar SDK (`@stellar/stellar-sdk`)** | `^13.1.0` | Built and prepared Soroban `InvokeHostFunctionOp` transactions (`Contract.call`, `TransactionBuilder`, `server.prepareTransaction`, `server.sendTransaction`), and converted parameters between JS types and XDR (`Address.fromString().toScVal()`, `nativeToScVal()`, `scValToNative()`, `xdr.ScVal.fromXDR()`). |
| **Freighter Wallet (`@stellar/freighter-api`)** | `^3.0.0` | Integrated browser extension wallet detection (`isConnected`), account access (`requestAccess`), and user-approved XDR transaction signing (`signTransaction`) alongside a fallback Testnet signer for judges without the extension installed. |
| **Soroban Testnet RPC** | `https://soroban-testnet.stellar.org` | Executed write transactions (`notarize`, `attest_audit`) and zero-gas, wallet-free read-only contract queries (`get_by_hash`, `get_by_merkle`, `get_by_period`, `get_history`) via JSON-RPC `simulateTransaction` and `getTransaction`. |
| **Stellar Horizon Testnet API & Friendbot** | `https://horizon-testnet.stellar.org` & `https://friendbot.stellar.org` | Fetched live native XLM balances for the header wallet badge and implemented 1-click automatic Testnet wallet funding via Friendbot when a user connects a fresh Freighter account. |
| **Stellar.Expert Explorer** | `stellar.expert/explorer/testnet` | Linked every on-chain seal, auditor co-signature, and printable QR Audit Certificate directly to live Testnet transaction and contract pages. |
| **AI Coding Tools / Agent Workflow (without Raven MCP)** | AI Coding Agent | Used for Rust Soroban contract scaffolding, XDR debugging, client-side Merkle tree parallelization, and UI iteration. We did not have the Raven MCP connected initially, which meant the AI agent initially relied on training-cutoff knowledge for `@stellar/stellar-sdk` XDR parsing and `@stellar/freighter-api` signatures before we inspected live RPC payloads directly. |

---

## 2. Main Points of Friction (What Happened, Time Cost & Workarounds)

### Friction #1: `TypeError: Bad union switch: 4` in `@stellar/stellar-sdk` on Protocol 23+ `TransactionMetaV4`
* **What Happened**:
  After broadcasting a valid Soroban `notarize` or `attest_audit` transaction to `https://soroban-testnet.stellar.org`, calling `server.getTransaction(txHash)` in `@stellar/stellar-sdk` (`^13.1.0`) threw an unhandled runtime exception:
  `TypeError: Bad union switch: 4`
  Even though the transaction succeeded on-chain in ~4 seconds, Testnet was running Protocol 23+ which returns `TransactionMetaV4` (`union switch: 4`). The SDK's internal `parseTransactionInfo(resultMetaXdr)` crashed while trying to decode `resultMetaXdr` / `diagnosticEventsXdr` before returning the transaction status to our frontend.
* **How Long It Roughly Cost Us**: **~2.5 hours** of debugging during the hackathon (initially suspecting our Rust `#[contracttype]` return struct before isolating the XDR union switch inside `@stellar/stellar-sdk`).
* **How We Worked Around It (`src/lib/stellarSoroban.ts`, commit `8a0ac51`)**:
  We bypassed `server.getTransaction()` and `server.simulateTransaction()` XDR meta parsing by making direct `fetch()` JSON-RPC calls to `https://soroban-testnet.stellar.org` (`method: "getTransaction"` and `method: "simulateTransaction"`) and decoding **only** `result.returnValueXdr` (or `result.results[0].xdr`) via `xdr.ScVal.fromXDR(retvalXdr, 'base64')` and `scValToNative(scVal)`.

---

### Friction #2: `@stellar/freighter-api` v2 vs v3 Return Shape Changes & AI Agent Hallucinations
* **What Happened**:
  Across `@stellar/freighter-api` v1/v2 and v3 (`^3.0.0`), methods like `isConnected()`, `requestAccess()`, and `signTransaction()` changed their return values from primitives (`boolean` / `string`) to objects (`{ isConnected: boolean }`, `{ address: string, error?: string }`, `{ signedTxXdr: string, error?: string }`). Existing community examples and AI coding models frequently mix v2 and v3 signatures, causing silent bugs where `if (await isConnected())` evaluates to `true` even when `{ isConnected: false }` is returned.
* **How Long It Roughly Cost Us**: **~1 hour** to test both extension-installed and extension-missing states and normalize all return types.
* **How We Worked Around It (`src/lib/stellarSoroban.ts`, lines 207-249 & 413-426)**:
  We wrote defensive dual-shape normalizers around every Freighter API call:
  ```ts
  const conn = await freighterIsConnected();
  const isConn = typeof conn === 'boolean' ? conn : Boolean(conn && conn.isConnected);

  const access = await freighterRequestAccess();
  const address = typeof access === 'string' ? access : (access?.address ?? '');
  ```

---

### Friction #3: Read-Only Contract Calls (`simulateTransaction`) Require a Dummy Funded-Format `Account` & Full `TransactionBuilder` Envelope
* **What Happened**:
  In our External Auditor Portal, statutory auditors must verify a company's General Ledger CSV with **zero gas fees and no crypto wallet installed**. However, to call read-only Soroban view functions (`get_by_hash`, `get_by_merkle`, `get_by_period`, `get_history`), Soroban RPC's `simulateTransaction` still requires constructing a full Stellar `Transaction` with a valid `G...` source `Account`, `BASE_FEE`, `networkPassphrase`, and `TransactionBuilder`. Missing examples for wallet-free read-only dApp portals slowed down our initial frontend integration.
* **How Long It Roughly Cost Us**: **~1 hour** to build a clean, reusable wallet-free read wrapper.
* **How We Worked Around It (`src/lib/stellarSoroban.ts`, lines 67-68 & 638-686)**:
  We created a `simulateReadOnlyContractCall(method, args)` helper that instantiates a zero-sequence dummy `Account` (`new Account(READONLY_SIMULATION_PUBLIC_KEY, '0')`), builds the XDR operation, posts it directly to `simulateTransaction`, and converts the `ScVal` return value via `scValToNative()`.

---

### Friction #4: Rust `wasm32v1-none` vs `wasm32-unknown-unknown` Target & Missing `Buffer` Global in Vite 6 + React 19
* **What Happened**:
  1. Newer Rust toolchains (`1.82+` / `1.84+`) emit WebAssembly reference-types/multivalue opcodes on `wasm32-unknown-unknown` by default unless targeting `wasm32v1-none` via `stellar contract build`, which breaks raw `cargo build --target wasm32-unknown-unknown` workflows.
  2. In Vite 6 + React 19, `@stellar/stellar-sdk` relies on Node's `Buffer` for XDR byte serialization (`xdr.ScVal.scvBytes(Buffer.from(...))`), which throws `ReferenceError: Buffer is not defined` in modern browser bundlers unless manually polyfilled.
* **How Long It Roughly Cost Us**: **~45 minutes** during initial project setup.
* **How We Worked Around It**:
  1. Standardized on `stellar contract build` (`contracts/target/wasm32v1-none/release/audit_ledger.wasm`) with `[profile.release]` `opt-level = "z"`, `strip = "symbols"`, and `lto = true` in `contracts/Cargo.toml`.
  2. Installed `buffer` (`^6.0.3`) and explicitly imported `import { Buffer } from 'buffer'` in `src/lib/stellarSoroban.ts`.

---

### Friction #5: Sequence Number Collisions When Multiple Judges Test a Shared Demo Account & Verbose Multi-Key TTL Extension
* **What Happened**:
  1. When two judges or teammates clicked "Seal on Stellar" at the exact same second using the built-in demo corporate signer, Stellar RPC rejected the second transaction due to an account sequence number collision.
  2. Because AuditLedger indexes each notarized financial close across four persistent keys (`ByHash`, `ByMerkle`, `ByPeriod`, `History`), we had to manually repeat `env.storage().persistent().extend_ttl(&key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS)` four times in both `notarize` and `attest_audit` (`contracts/audit-ledger/src/lib.rs`, lines 103-114 & 165-176).
* **How Long It Roughly Cost Us**: **~45 minutes** to implement automatic sequence-collision failover and verify TTL extension behavior.
* **How We Worked Around It (`src/lib/stellarSoroban.ts`, lines 454-488)**:
  We added automatic failover to a secondary backup Testnet keypair whenever `sendTransaction` returns a sequence/submission error in demo mode, plus automatic Friendbot funding when a user connects an unfunded Freighter wallet.

---

## 3. What Worked Well & What Would Have Made Building on Stellar Easier

### What Worked Well
1. **Native Authorization (`issuer.require_auth()` & `auditor.require_auth()`)**: Implementing bilateral CFO + Statutory Auditor cryptographic co-signing in `contracts/audit-ledger/src/lib.rs` required only two lines of Rust and worked seamlessly across both Freighter and raw Ed25519 keypairs.
2. **Sub-5-Second Finality & Sub-Cent Fees (`~0.00001 XLM`)**: During live demos and testing at ONE16 Lisbon, sealing a 2,500-row General Ledger on Stellar Testnet confirmed in ~4 seconds, making real on-chain interactions feel instantaneous.
3. **`#[contracttype]` Automatic XDR Serialization + `scValToNative()`**: Returning a rich Rust struct (`AuditRecord` containing `Address`, `Option<Address>`, `BytesN<32>`, `String`, `u64`, `u32`) from Soroban and converting it directly into a typed JS object via `scValToNative()` saved hours of manual ABI/XDR decoding.
4. **Fast In-Memory Rust Unit Testing (`soroban-sdk` `testutils`)**: Running `cargo test` in `contracts/audit-ledger` with `env.mock_all_auths()` and ledger timestamp mocking (`env.ledger().with_mut(...)`) executed all 5 contract test suites (including duplicate hash/period rejection and native `env.crypto().sha256` Merkle pairing) in under `0.5s` with zero Docker overhead.

### What Would Have Made Building on Stellar Easier
1. **Fault-Tolerant XDR Meta Parsing in `@stellar/stellar-sdk`**: Decouple `resultMetaXdr` / `diagnosticEventsXdr` decoding from the base `server.getTransaction()` status check (or wrap it in a lazy getter) so that Testnet protocol upgrades (`TransactionMetaV4` on Protocol 23+) never throw `TypeError: Bad union switch: 4` on slightly older minor versions of `@stellar/stellar-sdk`.
2. **First-Class Read-Only Helper (`contract.read()`)**: Add a one-line wallet-free read helper in `@stellar/stellar-sdk` (e.g., `server.readContract(contractId, method, args)`) that eliminates the boilerplate of instantiating a dummy `Account(G..., '0')` and `TransactionBuilder` just to call `simulateTransaction` on view methods.
3. **Native `Uint8Array` Support Instead of Node `Buffer` in Browser Builds**: Accepting standard `Uint8Array` everywhere in `@stellar/stellar-sdk` XDR builders would allow Vite, Next.js, and modern browser apps to work out-of-the-box without adding Node `buffer` polyfills.
4. **Pre-Configured Stellar / Raven MCP in the Hackathon Starter Kit**: Providing a 1-command `.cursor/mcp.json` or AI agent rules file at check-in with up-to-date `@stellar/stellar-sdk` v13+ and `@stellar/freighter-api` v3+ TypeScript signatures would prevent AI coding assistants from generating outdated v1/v2 wallet and XDR boilerplate.
5. **Batch `extend_ttl` Helper in `soroban-sdk`**: A convenience method like `env.storage().persistent().extend_ttl_many(&[&k1, &k2, &k3], min, max)` would clean up smart contracts that maintain multiple secondary lookup indices.
