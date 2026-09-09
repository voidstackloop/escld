# Authentication & Authorization

Cognito is the single identity provider for the whole system. This doc ties together the pieces that are otherwise scattered across `docs/FRONTEND.md`, `docs/BACKEND.md`, and `docs/WS_SFU.md`.

## Identity model

- **Cognito** owns credentials, email verification, and password policy. It is the *only* place a password ever exists.
- **Postgres `users`** owns the app-visible profile: `id` (the UUID every other service/table actually references), `username`, `display_name`, `bio`, avatar, follower counts, account status, etc. — linked to Cognito via a unique `cognito_sub` column.
- **Cognito User Pool Groups** (`admin`, `moderator`) are the *entire* authorization model. There is no roles table anywhere in Postgres or DynamoDB. Every authenticated user implicitly has a baseline "user" capability; `admin`/`moderator` are additive group memberships checked directly against the JWT's `cognito:groups` claim.

## Signup flow

1. Frontend `SignUp.tsx` calls Cognito's `signUp()` directly (via AWS Amplify) — email, password, a `preferred_username` attribute, and a generated DiceBear avatar URL as the `picture` attribute.
2. User confirms via a 6-digit code (`ConfirmSignUp.tsx` → `confirmSignUp()`).
3. Before Cognito ever creates the account, a **PreSignUp Lambda trigger** (`aws/lambda/preSignUp/index.mjs`) checks `preferred_username` against Postgres and rejects the signup outright (the one Cognito trigger where throwing is the intended behavior) if it's already taken or fails the format check — closing a real gap Cognito itself doesn't cover, since `preferred_username` isn't configured as a login alias and so isn't uniqueness-enforced at the Cognito level.
4. On confirmation, Cognito invokes a **PostConfirmation Lambda trigger** (`aws/lambda/postConfirmation/index.mjs`) that provisions the corresponding Postgres `users` row — deliberately fire-and-forget: it logs and swallows DB failures (including a genuine username/email conflict, logged distinctly) rather than blocking the user's signup on a database hiccup.
5. Both triggers are wired into `frontend/amplify/auth/resource.ts`'s `defineAuth({ triggers: {...} })` as real CDK-managed (`NodejsFunction`) Lambdas, VPC-attached in production so they can reach Postgres (which lives in a `PRIVATE_ISOLATED` subnet unreachable from a default Lambda execution environment) and reading DB credentials fresh from the same auto-rotating Secrets Manager secret RDS itself manages — see `aws/README.md` for the exact environment variables a real deploy needs. Locally (`ampx sandbox`), both build with no VPC attachment, matching local dev's directly-reachable docker-compose Postgres.

## Where a JWT is required and how it's validated

Two services independently validate Cognito access tokens — there is no shared "auth service" to call:

| Service | Where | What it checks |
|---|---|---|
| Backend (`backend/`) | `SecurityConfig` + `CognitoAccessTokenValidator` | Standard issuer/signature validation via Spring's OAuth2 resource server (`JwtDecoders.fromIssuerLocation`), **plus** a custom check that `token_use == "access"` (blocks ID tokens being used as bearer tokens — Cognito access tokens carry no `aud` claim, so this replaces that check) and that the `client_id` claim matches the configured app client. |
| `ws-sfu` (`ws-sfu/`) | `auth.rs`'s `CognitoVerifier` | The same two checks, reimplemented independently in Rust (JWKS fetched and cached, refreshed on an unknown `kid` or hourly) — see `docs/WS_SFU.md`. |

Both services expect the **access token**, not the ID token — the frontend attaches it via `fetchAuthSession()` in `src/lib/api.ts` (backend) and `src/lib/ws-sfu.ts` (ws-sfu).

Roles are read from `cognito:groups` in both cases, but from different token types by convention: the backend's `CognitoAccessTokenValidator` reads groups off the *access* token's claims; the frontend's own `useAuth()` reads `cognito:groups` off the **ID** token for UI-side role gating (`RequireRole`). Cognito includes `cognito:groups` in both token types by default, so this is consistent in practice, but it's worth knowing which token each layer actually reads if this ever needs debugging.

## Role mapping

| Cognito group | Backend role (Spring) | Effect |
|---|---|---|
| *(none — every authenticated user)* | `ROLE_USER` | Full normal-user access to every non-moderation endpoint. |
| `admin` | `ROLE_ADMIN` | Everything `ROLE_USER` has, plus every `ROLE_ADMIN`/`ROLE_MODERATOR`-gated action below. |
| `moderator` | `ROLE_MODERATOR` | Moderation queue access, resolve reports, suspend/reinstate users, remove posts/comments (`docs/BACKEND.md`'s `ModerationController`), and — in `ws-sfu` — starting/stopping a call recording (`docs/WS_SFU.md`). |

Both `admin` and `moderator` are checked via `hasAnyRole('ADMIN','MODERATOR')` everywhere in this codebase — there is currently no endpoint or action that distinguishes between the two (no admin-only action that a moderator can't also do).

## Frontend role gating (UI only, never a real boundary)

`RequireRole` (`src/components/route-guards.tsx`) hides the `/moderation` route from non-admin/moderator users, and `CallPanel` hides the recording control the same way. In both cases, the actual enforcement is server-side (`@PreAuthorize` in the backend, `identity.has_role(...)` in `ws-sfu`) — the frontend check exists purely so the wrong people never see a control they can't use, not as security.
