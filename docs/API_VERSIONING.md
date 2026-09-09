# API Versioning

## Current convention

Every backend REST endpoint is mounted under `/api/v1/...` — confirmed across all 11 controllers in `backend/src/main/java/com/escld/backend/controllers/` (`PostController`, `UserController`, `FollowController`, `ModerationController`, etc.), each declaring `@RequestMapping("/api/v1...")`. This is a **URI path version**, not a header- or content-negotiated one — the simplest scheme, and the only one this API has ever used. There is exactly one consumer of this API today (`frontend`), so nothing beyond "a version exists in the URL" has been needed.

`ws-sfu`'s Socket.IO surface is unversioned — it's a persistent bidirectional connection, not a request/response REST API, and versioning a socket protocol is a different (harder) problem not yet worth solving at this app's current single-client scale.

## When to bump to `/api/v2`

Bump the whole prefix, not individual endpoints, when a change is **breaking** for the existing frontend client — removing a field, changing a field's type or meaning, changing an endpoint's URL shape or HTTP method, or tightening validation in a way that rejects previously-valid requests. Do **not** bump for additive, backward-compatible changes: a new optional field, a new endpoint, a new optional query parameter, loosening validation. These ship straight into `v1`.

When a `v2` prefix is introduced, `v1` stays live and unmodified until the frontend has fully migrated off it — there is no deprecation-header or sunset-date tooling in this codebase, so a `v1` retirement is a manual, coordinated step (confirm via `grep -r "/api/v1" frontend/src` that nothing still calls it), not an automated one.

## Why nothing more elaborate exists yet

A schema registry, an API gateway product with built-in versioning/transformation, or contract-testing tooling (e.g., Pact) would be solving a many-consumers, many-teams problem this app doesn't have — one team, one API consumer. Revisit this decision if a second internal team or an external/third-party consumer starts depending on these APIs directly; at that point a real deprecation policy (sunset headers, a documented support window) becomes worth building, not before.
