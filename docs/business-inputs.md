# Business inputs register

Claude: grep this file for `BLOCKS` before starting a step. Status values: OPEN / ASKED / ANSWERED / SIGNED-OFF.
When an answer arrives, write the decision in the Answer column and, if it shapes code, add an ADR.

| ID    | Input                                                                                      | Owner             | Status   | BLOCKS (steps)  | Answer / ref                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------ | ----------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BI-01 | Brand name, logo, final domain usage (iqoshaven.com), public contact copy                  | Client            | OPEN     | 38, 64, 100     | 2026-10-12 (Marina): keep demo/placeholder values for now; real values will be added later.                                                                                                                                                                                                                                                |
| BI-02 | VAT treatment + excise basis per product type; accountant-approved rounding examples       | Client accountant | ANSWERED | 67, 70, 72, 105 | 2026-10-12 (Marina): no separate tax calculation. The price the admin enters is the final price. Implemented: ADR 0036.                                                                                                                                                                                                                    |
| BI-03 | Dubai delivery areas list, flat fee, ETA text; free-delivery threshold (default off)       | Client            | ANSWERED | 39, 66, 70      | 2026-10-12 (Marina): delivery covers the whole UAE (seven emirates). Implemented: ADR 0036. Fee, ETA and the area list are entered by the Owner in the admin; nothing is seeded; free-delivery threshold stays off.                                                                                                                        |
| BI-04 | Age policy: minimum age, gate copy, re-check frequency, cookie lifetime                    | Client / legal    | ANSWERED | 55, 56, 57      | 2026-10-12 (Marina): minimum age 18. Choosing 18+ lets the visitor in; otherwise they cannot enter. This is what is built. Kept as built defaults: 30-day remembered acceptance, 15-minute restricted period, current gate wording. Production must set `AGE_POLICY_VERSION` to a real value ("unapproved" is refused).                    |
| BI-05 | Link preview & search indexing policy (products indexed or not, JSON-LD)                   | Client / legal    | OPEN     | 57, 113         | 2026-10-12: no decision given. Product indexing and product link previews stay off (safe default).                                                                                                                                                                                                                                         |
| BI-06 | Hosting provider + availability profile (budget vs replicated), UAE region                 | Apixel + Client   | ANSWERED | 16, 119, 122    | 2026-10-12 (Marina): Hostinger web hosting. RISK to confirm before step 119: this system needs four long-running Node processes, PostgreSQL 18, Redis and S3-compatible storage; a shared "web hosting" plan does not provide these. A Hostinger VPS (Docker) would. Budget (single-node) profile assumed. UAE region not confirmed.       |
| BI-07 | Email provider + sender domain; notification/daily-summary recipients                      | Client            | ANSWERED | 78, 92, 107     | Provider Resend (2026-10-09). 2026-10-12 (Marina): new-order notifications go to vapehaven.store24@gmail.com (the Owner enters it under Settings → Notifications; staging also needs it in `EMAIL_RECIPIENT_ALLOWLIST`). Still needed before sending: a verified sending domain and sender address (a Gmail address cannot be the sender). |
| BI-08 | Data retention periods (orders, customers, logs, events, reports)                          | Client / legal    | ANSWERED | 103, 111, 126   | 2026-10-12 (Marina delegated the choice to Apixel): defaults in "Retention defaults" below. The client can change them; not legal advice.                                                                                                                                                                                                  |
| BI-09 | WhatsApp number(s) and message templates wording                                           | Client            | OPEN     | 38, 64, 90      | 2026-10-12 (Marina): keep demo/placeholder values for now; real values will be added later.                                                                                                                                                                                                                                                |
| BI-10 | Real catalogue: brands, categories, products, variants/SKUs, prices, images, initial stock | Client            | ANSWERED | 124             | 2026-10-12 (Marina): entered later through the admin panel; no import.                                                                                                                                                                                                                                                                     |
| BI-11 | Owner account(s) for first bootstrap; staff list                                           | Client            | ANSWERED | 28, 124         | 2026-10-12 (Marina): staff are added later through the admin panel. The first Owner still needs `pnpm bootstrap:owner` with a real email at deployment.                                                                                                                                                                                    |

## Questions log

<!-- YYYY-MM-DD — question — asked via — answer -->

- 2026-10-09 — BI-07 email provider and scope — chat with Marina — Resend; domain verification pending; new-order email only at launch, others later. Still needed: verified sending domain, sender address (e.g. orders@…), who receives new-order email.

- 2026-10-10 — Step 38 schema/API implemented with all settings initially unconfigured; BI-01/BI-09 and remaining BI-07 are still unanswered. No prototype contact, WhatsApp wording, recipients or provider secrets seeded; real configuration/communications activation awaits existing client decisions (ADR 0011).

Step 39 implements the Dubai area/flat-fee/ETA schema and Owner-only API with no seeded areas or business values. BI-03 remains OPEN: obtain the approved coverage/exclusions, exact integer-fils flat fee and ETA before activating real areas/configuration. Free threshold remains disabled; approval alone needs a later reviewed enabling policy/UI change. Backend selection fails closed for unconfigured fees and inactive areas.

- 2026-10-10 — Step 44 (ADR 0015): products keep a read-only, null VAT/excise treatment reference until BI-02 provides approved treatments (step 67). Because publication requires that reference (step-41 CHECK), BI-02 also gates product publication (step 51) and therefore the M4 gate. Drafts can be prepared meanwhile.
- 2026-10-11 — Step 55 (ADR 0024): built without BI-04 on Marina's decision. Waiting on BI-04: approved `AGE_POLICY_VERSION` (production refuses `unapproved`), approved remembered-acceptance lifetime (`AGE_TICKET_TTL_DAYS`, 30 proposed, hard cap 30), minimum age and gate copy (step 56 UI), re-check frequency.
- 2026-10-11 — Step 56 (ADR 0025): gate built with prototype wording and 18 as the minimum age. Waiting on BI-04: confirmed minimum age, final gate/restricted copy, rejection duration (`AGE_RESTRICTED_MINUTES`, 15 placeholder). Also needed from the client: the trade licence number shown in the prototype gate footer (omitted for now).
- 2026-10-11 — Step 57 (ADR 0026): generic preview and crawler policy built with indexing and product previews off. Waiting on BI-05: any decision to index or preview products. Waiting on BI-04/legal: final text for `/responsible-use`, `/terms`, `/privacy`, required health-warning wording, a logo for the link-preview image.
- 2026-10-11 — Step 63 (ADR 0032): the privacy policy text (BI-04/legal) should say that the age confirmation, cart, saved items, comparison and recently viewed products are kept on the customer's device and not sent to the store.
- 2026-10-11 — Step 64 (ADR 0033): built without BI-01/BI-09. WhatsApp links appear only when the Owner sets the number in admin settings; message wording is the prototype's until BI-09. Waiting on BI-01: contact copy/page, logo, trade licence line; BI-04: footer health-warning wording.

- 2026-10-11 — Step 65 (ADR 0034): which phone numbers may place an order? Built: UAE mobiles and landlines in any common spelling, and foreign numbers only with a country code; toll-free/service numbers refused. To ask the client (affects step 66 validation and checkout copy): UAE mobile only, or also landlines and foreign numbers? — not asked yet — no answer.

- 2026-10-11 — Which phone numbers may place an order (step 65 question) — chat with Marina — UAE mobile numbers only. Landlines and foreign numbers are refused; applied in step 66.

- 2026-10-11 — How to proceed while BI-02 and BI-03 are open — chat with Marina — build what they do not block: no real areas or fees are seeded (the Owner enters them later) and no tax rate is assumed. BI-02 and BI-03 stay OPEN.

- 2026-10-11 — M5 gate — chat with Marina — passed on the seeded-data evidence of step 64.

- 2026-10-12 — All open inputs — chat with Marina — answers recorded in the table above. BI-01, BI-05 and BI-09 stay open (demo values / no decision). BI-06 carries a hosting risk that must be confirmed.

## Retention defaults (BI-08, chosen by Apixel on 2026-10-12)

Not implemented yet (steps 103, 111, 126). Nothing below deletes an order.

| Data                                                         | Kept for                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Orders, order items, status history, stock movements         | Never deleted                                                     |
| Audit log                                                    | 5 years                                                           |
| Customer name, phone and addresses (including on old orders) | Anonymized 5 years after the customer's last order, or on request |
| Raw analytics events                                         | 90 days; daily totals are kept                                    |
| Application logs                                             | 30 days                                                           |
| Generated CSV report files                                   | 7 days (download links 15 minutes)                                |
| Completed outbox events and effects                          | 90 days                                                           |
| Expired sessions, reset links and invitations                | 30 days after expiry                                              |
| Database backups                                             | 30 days                                                           |
