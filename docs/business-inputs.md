# Business inputs register

Claude: grep this file for `BLOCKS` before starting a step. Status values: OPEN / ASKED / ANSWERED / SIGNED-OFF.
When an answer arrives, write the decision in the Answer column and, if it shapes code, add an ADR.

| ID    | Input                                                                                      | Owner             | Status | BLOCKS (steps)  | Answer / ref |
| ----- | ------------------------------------------------------------------------------------------ | ----------------- | ------ | --------------- | ------------ |
| BI-01 | Brand name, logo, final domain usage (iqoshaven.com), public contact copy                  | Client            | OPEN   | 38, 64, 100     |              |
| BI-02 | VAT treatment + excise basis per product type; accountant-approved rounding examples       | Client accountant | OPEN   | 67, 70, 72, 105 |              |
| BI-03 | Dubai delivery areas list, flat fee, ETA text; free-delivery threshold (default off)       | Client            | OPEN   | 39, 66, 70      |              |
| BI-04 | Age policy: minimum age, gate copy, re-check frequency, cookie lifetime                    | Client / legal    | OPEN   | 55, 56, 57      |              |
| BI-05 | Link preview & search indexing policy (products indexed or not, JSON-LD)                   | Client / legal    | OPEN   | 57, 113         |              |
| BI-06 | Hosting provider + availability profile (budget vs replicated), UAE region                 | Apixel + Client   | OPEN   | 16, 119, 122    |              |
| BI-07 | Email provider + sender domain; notification/daily-summary recipients                      | Client            | OPEN   | 25, 78, 92, 107 |              |
| BI-08 | Data retention periods (orders, customers, logs, events, reports)                          | Client / legal    | OPEN   | 103, 111, 126   |              |
| BI-09 | WhatsApp number(s) and message templates wording                                           | Client            | OPEN   | 38, 64, 90      |              |
| BI-10 | Real catalogue: brands, categories, products, variants/SKUs, prices, images, initial stock | Client            | OPEN   | 124             |              |
| BI-11 | Owner account(s) for first bootstrap; staff list                                           | Client            | OPEN   | 28, 124         |              |

## Questions log

<!-- YYYY-MM-DD — question — asked via — answer -->
