# 0010 — Same-origin admin identity pages and permission-aware session shell

- Date: 2026-10-10
- Status: accepted
- Step(s): 37

## Context

Backend authentication/reset/invitations and fixed-role administration exist. The admin foundation page has no login or session state. UI must use the admin gateway cookie, reflect current backend permissions and recover from expired/revoked sessions without copying prototype credentials or browser persistence.

## Decision

- Provide `/login`, `/forgot`, `/reset` and `/invite/accept` using approved prototype form layout/tokens and actual backend contracts. No default email/password, demo actions or account-existence errors. Password confirmation and the real 12–128-character guidance replace prototype rules. Handle pending/invalid/missing-link, 400/401/403/429/503/network failures and generic forgot success. Show/hide password and accessible labels/status/focus styles; clear password inputs after failed submissions.
- Use same-origin `/api/v1/auth/*` requests with cookie credentials, no-store, JSON and ten-second timeout. Never expose the HttpOnly session cookie or store credentials/tokens in local/session storage. Reset/invite tokens come only from the email fragment, are consumed into a component ref on first load or same-page hash change and immediately removed by `history.replaceState`. Query tokens are not accepted. Successful reset/invite redirects to sign-in without auto-login.
- Dynamic no-store admin pages expose no protected data in HTML. The client session shell obtains strict `/me` profiles before displaying workspace content. Recheck on route, focus, visibility and a one-minute interval; abort superseded reads and ignore stale completion. Hide the workspace during verification/on failure; 401 redirects to sign-in with a static expired notice. Network/403/contract failures show a retry state. Logout calls the real endpoint before showing success; failure does not claim logout.
- Navigation uses individual permissions from `/me`, never a client role switch or wildcard. Direct section links check the same fresh grants. Operational section bodies are honest empty workspaces until their roadmap implementation, with no fake charts/orders/reports or financial data. Every future data/action still needs API authorization/403 handling; navigation is not the authorization boundary.
- Reuse self-hosted fonts and both theme token sets, with explicit initial light theme and an in-memory theme toggle. Responsive auth cards, sidebar/navigation, and workspace. No new environment variables/backend proxy; browser users open the configured gateway origin, not direct Next ports.
- Add contracts workspace dependency and admin auth/navigation tests; dependency versions do not change. Local HTTP smoke tests use synthetic identities in an isolated test schema, not real users/email. Visual/interactive browser QA remains unverified because no browser surface/Computer Use permission was available.

## Alternatives considered

- Next credential proxy or browser bearer-token storage — duplicates same-origin session authority or exposes credentials.
- Role-labelled client permissions/demo login — inconsistent with current backend grants.
- Copy prototype reset rules, deactivated-account messages or unsaved local persistence — conflicts with password policy, generic auth errors and privacy.

## Consequences

Real auth UI exists; step 38 starts settings schema/API. Reset/invite delivery still requires step 33–34 configuration and real-email prerequisites. Full browser interaction/mobile visual QA must be completed when Computer Use is enabled. This does not close M3, whose operational UI/business settings and gate evidence remain open.
