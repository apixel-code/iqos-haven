# 0090 — Packing slip for the courier

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A6 (follows ADRs 0051 and 0055)

## Context

Staff had no printable view of an order to pack and hand to the courier. The prototype has an "Order summary" modal ("Packing slip layout for the courier") but no actual printing: its print button is a stub, and it writes "{area}, Dubai" for every address. Marina chose G-A6 for launch (2026-10-17).

## Decision

- **Where:** a **Packing slip** button in the order detail opens a preview dialog with **Print** and **Close**. Print uses the browser's own print dialog, so it can go to a printer or a PDF.
- **Contents:** the store name and order number.
  - **Deliver to:** name, building, unit and street, address type and Makani, the order's area and **its own emirate** (from the order snapshot), the phone, and the customer's delivery note.
  - **Order:** date, status, "Cash on Delivery".
  - **Items:** brand and product, options, SKU, quantity, line total.
  - **Totals:** subtotal, discount (with the code), delivery ("Free" at zero), and **Collect in cash**. That reads "Already collected" once cash is recorded, and "Cancelled: nothing to collect" for a cancelled order.
- **Not printed:** the internal operational note. It is for staff, not the courier.
- **Who:** the slip needs the contact and address, so it is offered only with `customers.read`; the API already hides the contact without it.
- **Print rules:** A5 portrait with 10 mm margins. Everything except the slip and the elements that contain it is `display: none`, so the slip prints alone on one page.

## Consequences

- Packers and couriers get one page with the address, the items and the cash to collect.
- No new route or data: the slip is built from the order detail already loaded, with the same permissions.
