# Security boundaries and implementation controls

Architecture sections 3, 9 and 11 are authoritative. Current code fixes cover foundation validation/logging/lifecycle only. Authentication, age tickets, gateways, storage authorization and commerce enforcement are pending milestones.

| Boundary                         | Required enforcement                                                                                  | Release evidence                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Browser → same-origin gateway    | Origin/content-type checks; host-only cookies; strip client trust/age headers                         | Actual admin/store origins and CSRF tests                         |
| Gateway → private API            | Network allowlist + service identity; no public internal routes                                       | Origin-bypass/forged-header denial                                |
| Service → internal route         | HMAC service auth (`@InternalService`): key id, ±30 s window, nonce, body hash; never cookies         | Implemented step 26 (guard tests); private network still required |
| Service → object storage         | Private buckets, least-privilege service identity, presigned URLs ≤ 15 min, POST policy size/key/type | Implemented step 26 (MinIO tests); provider IAM per BI-06         |
| Store → restricted content       | Ticket signature/audience/policy; HTML/RSC/API/metadata/media cache safety                            | AGE-01–06                                                         |
| API → database                   | Runtime role separate from owner; parameterized SQL; explicit locks/constraints                       | Commerce races and FK/deletion tests                              |
| Worker → DB/Redis/providers      | Durable effects and idempotency; bounded leases/retries; no network in DB tx                          | Crash/loss/provider acceptance drills                             |
| Upload → quarantine → derivative | Permission/byte/type/dimension checks; no executable original exposure                                | Upload attack samples                                             |
| Staff → Owner fields/reports     | Action/field/requester scope rechecked server-side                                                    | Direct endpoint/ID/field denial                                   |
| Logs/telemetry/export            | Allowlisted IDs/codes/static messages; no body/query/URL/PII/SQL/raw errors                           | Recursive logger tests plus real telemetry review                 |
| Release/restore → customer sends | Separate credentials/state; sends disabled in drills/staging                                          | Recipient routing and isolated restore evidence                   |

Structured logging removes sensitive keys/URL/body/headers and exception text recursively with bounded depth. It cannot discover a secret placed inside an arbitrary static-message argument or an innocently named string field; log call sites must use only approved fields/static messages. Extend checks when payload shapes change. No API serializer logs raw URLs.

API request body limit is 32KiB for the current JSON foundation. New bounded schemas must be strict at nested object boundaries too. Gateway/upload/media limits are separate and must be implemented with those features. Missing body/query DTO contracts fail rather than permitting unchecked input. Future route parameters and controlled business error codes must use shared contracts.

Production credentials and key purposes remain separate. Secrets are never copied into this ZIP, docker build context, browser bundle or build cache. Provider/profile, CSP/TLS/WAF, retention, IAM and production grants still require actual selected infrastructure and tests.
