# APEX: Deliverables and Quick Start

- `APEX_Dashboard_Prototype.html`: standalone interactive desktop/mobile concept dashboard. Open in a browser. Optional injected wallet connection asks only for public account permission, if wallet extension is present. There is no private key, seed phrase, signing or live trade connection. All balances and P&L are fake demo values.
- `APEX_Claude_Code_Master_Build_Prompt.md`: comprehensive repository build prompt; attach this and optionally the HTML design reference to Claude Code. It covers all major chain families, wallet/bucket architecture, deterministic quant engines, risk, performance, UI pages, QA, security, rollout and go-live gates.
- `APEX_QA_Assessment_and_Acceptance.md`: detailed architectural gap analysis and release readiness matrix.
- `dashboard_screenshot.png`, `dashboard_390.png`: inspected desktop and mobile screenshots.

## Prototype interaction guide
1. Open HTML in a browser, select **Buckets & Wallets**.
2. Create an additional bucket, add watch-only public addresses to it, or authorise public account discovery through a supported injected EVM/Solana wallet browser extension.
3. Open **Compounding Studio** and set a monthly tracking target and reinvest/protected-vault/reserve waterfall totaling exactly 100%.
4. Open **Chains & Execution** to inspect the planned adapter registry. The adapters are not running in this HTML.
5. Use **Start paper simulation** and then **Activity Ledger -> Simulate paper result**; inspect the events and use the emergency stop.

Do not use this prototype to hold keys, connect trading API credentials, execute trades or measure investment returns. Real production use requires implementing the separately documented backend, security and go-live checks.
