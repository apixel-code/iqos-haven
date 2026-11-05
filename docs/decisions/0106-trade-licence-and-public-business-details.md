# 0106 — Trade licence number and public business details

- Status: Accepted
- Date: 2026-11-04
- Decided by: Marina

## Context

The client must show its UAE trade licence number on the store. Settings had a "Business name" (`legalName`), but nothing on the storefront read it. There was also no field for the licence number. The shop footer and the terms named only the trading name, Iqos Haven.

The policy pages are served without an age ticket. Every `/v1/store/*` route needs one, so the details cannot come through `GET /v1/store/info`.

## Decision

- **Field:** the store setting gains `tradeLicence`, nullable, up to 100 characters. The Owner edits it under Admin → Settings → General, below "Business name". It defaults to null, so values saved before the field existed still read, and no migration is needed.
- **Route:** `GET /v1/public/business` is public, like `/v1/public/seo`. It returns only `{ legalName, tradeLicence }` and is cached for 60 s. Nothing else in `settings` leaves through it: no domain, contact data, recipients or templates. These are business facts, not catalogue data, so the age boundary is unchanged.
- **Storefront:** the storefront reads the route once a minute per server process. A failed or unexpected answer shows nothing and never breaks a page.
  - **Footer:** the bottom row adds "Legal name · Trade licence no. X", with whichever parts are set.
  - **Terms:** a sentence after the independent-retailer paragraph: "The store is operated by <legal name>, UAE trade licence no. <X>."
  - Both stay hidden until the Owner enters a value.

## Consequences

- An admin still open from before the deploy saves the store group without the field, which clears a licence number entered in the meantime. The Owner should re-enter it once after the deploy if that happens.
- Contact email, phone, address, opening hours and footer note are still not shown on the storefront, which has only WhatsApp and social links. Showing them is a separate decision.
