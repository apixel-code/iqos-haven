# 0033 — Store shell, WhatsApp links and age-boundary verification

- Date: 2026-10-11
- Status: accepted (contact copy and WhatsApp wording pending BI-01, BI-09)
- Step(s): 64 (closes the steps of Milestone 5; content sections: 97; help pages: 100)

## Context

Roadmap step 64: navigation, home shell, WhatsApp links and verification that the age boundary holds while browsing: actual content sections come later, public contact copy must be approved, and direct API, RSC and warm-cache bypasses must be tested. BI-01 (public contact copy) and BI-09 (WhatsApp number and message wording) are OPEN and block this step. Marina's standing instruction for this milestone is to build what does not depend on missing input.

## Decision

**Shell.** One layout for every store page: skip link, header (name, search, primary navigation with the current section marked, saved items, cart count) and footer (shop links, policy links, payment line, nicotine warning). Navigation data lives in `lib/site.ts`, not in a client component file.

**Home shell.** `/` shows a plain heading block, the two product types, "New in" (newest eight products), up to six brands and the device's recently viewed products. It is the frame only: hero, promotions and editorial sections are managed content and arrive with the content module (step 97).

**WhatsApp links are configuration, not code.** `GET /v1/store/info` (age-gated, contract `{ whatsappNumber }`) returns the number from the Owner's `whatsapp` setting and nothing else from settings. The shell reads it once per request; if it cannot be read, or no valid number is configured, **no WhatsApp link is rendered anywhere**. With a number:

| Place        | Link text                                                           | Prepared message                                          |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Footer       | Chat on WhatsApp                                                    | "Hi Iqos Haven, I have a question."                       |
| Product page | Ask about this product on WhatsApp / Ask on WhatsApp when it's back | product name and lowest price, or a back-in-stock request |
| Cart         | Prefer to order on WhatsApp? Send this cart to our team             | quantities, names and options of the buyable lines        |

A link is a `wa.me` URL with an encoded message the shopper can read and edit; the site sends nothing, and no message contains anything the shopper typed. Wording is the prototype's until BI-09 supplies approved templates.

**Verification of the age boundary** is automated in three layers:

1. `pnpm test:gate` (new, in `pnpm verify -- --integration`): the real built API on an isolated schema with a seeded published product and a draft, the real built storefront, and the real gateway container. Through the gateway it checks eleven pages (plain and as RSC requests) and nine API routes for eight kinds of unverified request (no cookie, crawler and preview user agents, forged headers, junk cookie, ticket from another key, expired ticket, ticket for another policy), **before and after** a verified shopper has browsed and warmed the API cache. It also checks accept/reject through the gateway, a verified shopper's pages and API calls, that the draft product and SKUs never appear, and that admin, auth, internal and health routes are unreachable from the storefront origin.
2. `pnpm test:age-preview` (ADR 0026): the storefront alone against a stub API, including that unverified requests never reach the API.
3. API integration tests per route (ADR 0027 and later).

The seeded Owner settings include a WhatsApp number, a message template and a notification recipient: the number must reach only a verified shopper, and the other two must never appear anywhere.

**No redirect loop when the two checks disagree.** If the API refuses a ticket the storefront accepts (keys or policy out of step), a catalogue page redirects to `/age-check?recheck=1`, where the gate shows the question instead of bouncing the ticket back. The shell's own settings read never redirects; it just shows no WhatsApp links.

**Known limit (ADR 0024):** saying "under 18" clears the cookie in that browser; a copy of the ticket taken beforehand stays valid until it expires. Tickets cannot be revoked one by one.

`pnpm test:gate -- --serve` keeps the stack running for a manual or scripted browser pass.

## Waiting for business input

- **BI-09:** the WhatsApp number (set in admin settings; no deploy needed) and approved message wording.
- **BI-01:** public contact copy, logo and final domain usage; a contact page; the store name is a constant until then.
- **BI-04:** the required health-warning wording in the footer (prototype text for now).
- Trade licence line in the footer (omitted).

## Not built here

- Mobile menu sheet, cart sheet and promo ticker from the prototype; the header wraps on small screens instead.
- Delivery, FAQ and contact help pages (step 100 with BI-01/BI-03).
- Content-managed home sections (step 97).

## Alternatives considered

- **A hardcoded or environment WhatsApp number.** Rejected: the Owner already has a settings screen for it, and a wrong number in code would need a release to fix.
- **Hiding only the footer link when unconfigured.** Rejected: every WhatsApp entry point depends on the same number.
- **Testing the boundary only against stubs.** Rejected after this step's own run: the real-stack check found a shell bug (a constant imported from a client module) that the earlier stub run had not exercised.

## Consequences

- The Milestone 5 gate ("after age acceptance real products can be browsed, selected and added to a cart; before it no restricted product data is available") is demonstrated locally by `pnpm test:gate` and a browser pass through the gateway, with seeded data: products still cannot be published through the admin until BI-02.
- Every store page makes one extra cached API read for the shell settings.
- `test:gate` needs Docker and the local database, Redis and object storage; it is part of the integration tier only.
