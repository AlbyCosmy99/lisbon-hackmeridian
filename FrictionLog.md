# HackMeridian 2026 Lisbon - Stellar Developer Friction Log & Agent Feedback

* **Project**: **AuditLedger** - Trustless B2B Financial Audit, Canonical Merkle Notarization & Row-Level Tamper X-Ray on Stellar Soroban
* **Hackathon Track**: `Genesis (Idea -> MVP)` | `Stellar Unlocked`
* **Repository**: `https://github.com/AlbyCosmy99/lisbon-hackmeridian`
* **Live Testnet Smart Contract (v2)**: [`CDF4JHYPUJA67S62TVWFDLV7PDDGH4H7PGN4ANUUFLLCPZNCM76VLKED`](https://stellar.expert/explorer/testnet/contract/CDF4JHYPUJA67S62TVWFDLV7PDDGH4H7PGN4ANUUFLLCPZNCM76VLKED)
* **Contract Deployment TX**: [`bc3f7c540850c9e1e16d8a1d7a73c83fbaa473eb46bd91d7cae5ffb542cefb2b`](https://stellar.expert/explorer/testnet/tx/bc3f7c540850c9e1e16d8a1d7a73c83fbaa473eb46bd91d7cae5ffb542cefb2b)

---

## 1. What We Built at HackMeridian 2026

**AuditLedger** is a client-side, GDPR-safe B2B financial auditing and document sealing platform anchored on **Stellar Soroban**. It solves the corporate "retroactive cover-up" problem in ERP General Ledgers (`SAP`, `Oracle NetSuite`, `Holded`) and statutory audit workflows:

1. **Dual-Hashing Engine (`Raw Binary SHA-256` + `Canonical Accounting Merkle Root`)**: Normalizes regional CSV/JSON/PDF financial exports (`\r\n` vs `\n`, `;` vs `,`, `DD/MM/YYYY` vs `ISO-8601`, European vs US currency formatting) inside the browser via Web Crypto API so that re-saving a spreadsheet in Excel on macOS/Windows never breaks cryptographic verification on Stellar.
2. **Constant-Cost `O(1)` On-Chain Sealing on Soroban**: Whether a general ledger contains 10 rows or 10,000 rows, AuditLedger aggregates all row leaf hashes into a single 32-byte Merkle Root and anchors three 32-byte digests (`doc_hash`, `merkle_root`, `commitment_hash`) in a single Soroban transaction (`~0.00001 XLM`, 3-5 second finality, zero plaintext PII on-chain).
3. **Bilateral On-Chain Audit Attestation (`notarize` + `attest_audit`)**: The CFO freezes the monthly close (`notarize`), and the External Statutory Auditor independently verifies the file and co-signs the record on-chain (`attest_audit`).
4. **Merkle Tamper X-Ray & Single-Row Zero-Leakage Proofs (`O(log N)`)**: Pinpoints the exact manipulated row, account code, and EUR delta if a single number is altered post-close, and generates standalone `O(log N)` Merkle sibling proofs to prove a single invoice row without revealing the rest of the balance sheet.

---

## 2. Stellar Tools, SDKs & Infrastructure Used

| Tool / Component | Version / Endpoint | How We Used It in AuditLedger |
| :--- | :--- | :--- |
| **Soroban Rust SDK (`soroban-sdk`)** | `22.0.8` (`#![no_std]`) | Built `AuditLedgerContract` (`contracts/audit-ledger/src/lib.rs`) using `#[contract]`, `#[contractimpl]`, `#[contracttype]`, `#[contracterror]`, `issuer.require_auth()`, `auditor.require_auth()`, persistent triple-indexed storage (`ByHash`, `ByMerkle`, `ByPeriod`, `History`), `extend_ttl()`, native `env.crypto().sha256()`, and `env.events().publish()`. |
| **Stellar CLI (`stellar contract`)** | v22.x | Compiled optimized WASM (`stellar contract build`), ran unit tests with `soroban-sdk` `testutils`, deployed the contract to Stellar Testnet, and invoked initial test closes (`notarize`, `attest_audit`). |
| **JavaScript Stellar SDK (`@stellar/stellar-sdk`)** | `^13.1.0` | Built and prepared Soroban `InvokeHostFunctionOp` transactions (`Contract.call`, `TransactionBuilder`, `server.prepareTransaction`, `server.sendTransaction`), and converted parameters between JS types and XDR (`Address.fromString().toScVal()`, `nativeToScVal()`, `scValToNative()`, `xdr.ScVal.fromXDR()`). |
| **Freighter Wallet API (`@stellar/freighter-api`)** | `^3.0.0` | Integrated browser extension wallet detection (`isConnected`), account access (`requestAccess`), and user-approved XDR transaction signing (`signTransaction`) alongside our built-in pre-funded Testnet HSM signer. |
| **Soroban Testnet RPC** | `https://soroban-testnet.stellar.org` | Executed write transactions (`notarize`, `attest_audit`) and zero-gas, wallet-free read-only contract queries (`get_by_hash`, `get_by_merkle`, `get_by_period`, `get_history`) via `simulateTransaction`. |
| **Stellar Horizon Testnet API & Friendbot** | `https://horizon-testnet.stellar.org` & `https://friendbot.stellar.org` | Fetched live native XLM balances for the header wallet badge and implemented 1-click automatic Testnet wallet funding via Friendbot when a judge connects a fresh Freighter account. |
| **Stellar.Expert Explorer** | `stellar.expert/explorer/testnet` | Linked every on-chain seal, auditor co-signature, and printable QR Audit Certificate directly to live Testnet transaction and contract pages. |
| **AI Coding Assistants / Agentic Workflows** | Antigravity / AI Agent | Used for rapid Rust Soroban contract scaffolding, XDR debugging, client-side Merkle tree optimization, and automated test verification. |

---

## 3. Detailed Developer Friction Log (Issues, Impact & Workarounds)

### Friction #1: `TypeError: Bad union switch: 4` in `@stellar/stellar-sdk` When Parsing Protocol 23+ `TransactionMetaV4`
* **Severity**: **High (Blocker for Frontend Transaction Confirmation)**
* **Component**: `@stellar/stellar-sdk` (`^13.1.0`) `rpc.Server.getTransaction()` / `simulateTransaction()` XDR parser against `https://soroban-testnet.stellar.org`.
* **What Happened**:
  When polling `server.getTransaction(txHash)` after broadcasting a valid Soroban `notarize` or `attest_audit` transaction on Testnet (which runs Protocol 23+ returning `TransactionMetaV4`, union switch `4`), the JS SDK's internal `parseTransactionInfo(resultMetaXdr)` threw an unhandled exception:
  `TypeError: Bad union switch: 4`
  Even though the transaction succeeded on-chain in 4 seconds, the SDK threw an error while trying to decode `resultMetaXdr` / `diagnosticEventsXdr` before returning the status to our app.
* **How We Worked Around It (`src/lib/stellarSoroban.ts`, commit `8a0ac51`)**:
  We bypassed `server.getTransaction()` and `server.simulateTransaction()` XDR meta parsing by making direct `fetch()` JSON-RPC calls to `https://soroban-testnet.stellar.org` (`method: "getTransaction"` and `method: "simulateTransaction"`) and decoding **only** `result.returnValueXdr` (or `result.results[0].xdr`) via `xdr.ScVal.fromXDR(retvalXdr, 'base64')` + `scValToNative()`.
* **Recommendation for SDF**:
  1. Decouple `resultMetaXdr` / `diagnosticEventsXdr` decoding from the base `getTransaction()` status check in `@stellar/stellar-sdk`, or wrap XDR meta parsing in a lazy getter / safe fallback so minor protocol bumps on Testnet never break `status === 'SUCCESS'` polling on older minor versions of `@stellar/stellar-sdk`.
  2. Include `returnValueXdr` directly at the top level of the JSON-RPC response across all RPC versions so dApps do not need to unpack full `TransactionMeta` envelopes just to read a contract return value.

---

### Friction #2: `@stellar/freighter-api` Breaking Return Signatures Across v2 / v3 (`boolean` vs `{ isConnected: boolean }`, `string` vs `{ address: string }`)
* **Severity**: **Medium (UX & TypeScript Friction)**
* **Component**: `@stellar/freighter-api` (`^3.0.0`) + AI Agent code generation.
* **What Happened**:
  Across `@stellar/freighter-api` versions, methods like `isConnected()`, `requestAccess()`, and `signTransaction()` changed their return shapes from primitives (`boolean` / `string`) to objects (`{ isConnected: boolean }`, `{ address: string, error?: string }`, `{ signedTxXdr: string, error?: string }`). Documentation snippets and AI coding models frequently mix v1/v2 and v3 signatures, leading to silent truthiness bugs (e.g., `if (await isConnected())` evaluating to `true` even when `isConnected` is `{ isConnected: false }`).
* **How We Worked Around It (`src/lib/stellarSoroban.ts` lines 207-249 & 413-426)**:
  We wrote defensive dual-shape normalizers for every Freighter call:
  ```ts
  const conn = await freighterIsConnected();
  const isConn = typeof conn === 'boolean' ? conn : Boolean(conn && conn.isConnected);

  const access = await freighterRequestAccess();
  const address = typeof access === 'string' ? access : (access?.address ?? '');
  ```
* **Recommendation for SDF**:
  Publish a single canonical `@stellar/freighter-api` v3 cheat-sheet in the official Stellar docs (and MCP context packs) with explicit warnings about the object return types so developers and AI agents never treat `await isConnected()` as a raw boolean.

---

### Friction #3: Read-Only Contract Queries (`simulateTransaction`) Require Building a Dummy `Account` & `TransactionBuilder` Envelope
* **Severity**: **Medium (Boilerplate Overhead for Wallet-Free Read Portals)**
* **Component**: `@stellar/stellar-sdk` + Soroban RPC `simulateTransaction`.
* **What Happened**:
  In our External Auditor Portal, statutory auditors must verify a company's General Ledger CSV with **zero gas fees and no crypto wallet installed**. However, to call read-only Soroban getters (`get_by_hash`, `get_by_merkle`, `get_by_period`, `get_history`), Soroban RPC's `simulateTransaction` still requires constructing a full Stellar `Transaction` with a valid funded-format `G...` source `Account(DUMMY_PUBLIC_KEY, '0')`, `BASE_FEE`, `networkPassphrase`, and `TransactionBuilder`.
* **How We Worked Around It (`src/lib/stellarSoroban.ts` lines 67-68 & 638-686)**:
  We created a `simulateReadOnlyContractCall(method, args)` helper that instantiates a zero-sequence dummy `Account` (`new Account(READONLY_SIMULATION_PUBLIC_KEY, '0')`), builds the XDR envelope, posts it to `simulateTransaction`, and converts the `ScVal` return value via `scValToNative()`.
* **Recommendation for SDF**:
  Add a first-class `contract.read(server, method, ...args)` or JSON-RPC `callContractReadOnly` helper in `@stellar/stellar-sdk` that abstracts away the dummy `Account` and `TransactionBuilder` ceremony for view-only invocations.

---

### Friction #4: Rust `wasm32v1-none` vs `wasm32-unknown-unknown` Target & `Buffer` Polyfill in Vite + React 19
* **Severity**: **Low-Medium (Initial Setup Friction)**
* **Component**: `stellar contract build` + Vite 6 / Browser Bundling.
* **What Happened**:
  1. Newer Rust toolchains (`1.82+` / `1.84+`) enable WebAssembly reference-types/multivalue features on `wasm32-unknown-unknown` by default unless targeting `wasm32v1-none` via `stellar contract build`, which can confuse developers running raw `cargo build --target wasm32-unknown-unknown`.
  2. In Vite 6 + React 19, `@stellar/stellar-sdk` relies on Node's `Buffer` global for XDR byte serialization (`xdr.ScVal.scvBytes(Buffer.from(...))`), which is not polyfilled by default in modern browser bundlers.
* **How We Worked Around It**:
  1. Standardized on `stellar contract build` (`contracts/target/wasm32v1-none/release/audit_ledger.wasm`) with `[profile.release]` `opt-level = "z"`, `strip = "symbols"`, and `lto = true` in `contracts/Cargo.toml`.
  2. Explicitly installed `buffer` (`^6.0.3`) and imported `import { Buffer } from 'buffer'` in `src/lib/stellarSoroban.ts`.
* **Recommendation for SDF**:
  Migrate remaining `Buffer` parameters in `@stellar/stellar-sdk` browser builds to standard `Uint8Array` so Vite/esbuild apps work out-of-the-box with zero Node polyfills.

---

### Friction #5: Soroban State Archival (`extend_ttl`) Mental Model for Multi-Index B2B Registries
* **Severity**: **Low (Architecture Design Consideration)**
* **Component**: `soroban-sdk` Persistent Storage & State Archival.
* **What Happened**:
  Because AuditLedger indexes each notarized financial close across three lookup keys (`DataKey::ByHash`, `DataKey::ByMerkle`, `DataKey::ByPeriod`) plus an append-only `DataKey::History(issuer)` vector, every `notarize` and `attest_audit` call must explicitly call `env.storage().persistent().extend_ttl(&key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS)` on all four storage keys (`contracts/audit-ledger/src/lib.rs` lines 103-114 & 165-176) to keep all lookup indices synchronized in archival lifetime.
* **Recommendation for SDF**:
  Provide a batch helper such as `env.storage().persistent().extend_ttl_many(&[&k1, &k2, &k3], min, max)` or a macro attribute on `#[contracttype]` storage keys to reduce boilerplate when maintaining multi-indexed records.

---

## 4. What Worked Exceptionally Well on Stellar & Soroban

1. **Native Auth (`issuer.require_auth()` & `auditor.require_auth()`)**: Implementing bilateral CFO + Statutory Auditor authorization in `contracts/audit-ledger/src/lib.rs` took 2 lines of Rust and worked seamlessly with both Freighter and raw Ed25519 keypairs.
2. **Sub-5-Second Finality & Sub-Cent Fees for Live B2B Demos**: During live judging and testing, sealing a 2,500-row General Ledger on Stellar Testnet confirmed in ~4 seconds at `~0.00001 XLM`, making interactive step-by-step live demos effortless.
3. **`#[contracttype]` Automatic XDR Serialization + `scValToNative()`**: Returning a rich Rust struct (`AuditRecord` with `Option<Address>`, `BytesN<32>`, `String`, `u64`, `u32`) from Soroban and converting it directly into a native JS object via `scValToNative(retval)` saved hours of manual ABI/XDR decoding.
4. **Built-In `testutils` in `soroban-sdk`**: Running `cargo test` in `contracts/audit-ledger` with `env.mock_all_auths()` and ledger timestamp manipulation (`env.ledger().with_mut(...)`) executed all 5 contract test suites in `< 0.5s` without spinning up a local Docker node.
