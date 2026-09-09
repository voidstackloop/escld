# Frontend (React SPA)

Located at `frontend/`. A Vite + React 19 single-page app.

## Tech stack

| Concern | Choice |
|---|---|
| Build tool | Vite 8, `@vitejs/plugin-react` (Oxc-based), React Compiler enabled |
| Language | TypeScript, `@` path alias → `src/` |
| Routing | React Router v7 (`react-router-dom`), `<BrowserRouter>` in `main.tsx` |
| Styling | Tailwind CSS v4, CSS-first config (theme lives in `src/index.css`, no `tailwind.config.js`), via `@tailwindcss/vite`. Class merging via `clsx` + `tailwind-merge` (`cn()` in `src/lib/utils.ts`) |
| UI components | shadcn/ui (`components.json`: style `radix-nova`, base color `neutral`) on Radix primitives + `class-variance-authority`. Only 6 primitives exist under `src/components/ui/`: `alert`, `button`, `card`, `input`, `label`, `textarea` — no dialog/dropdown/avatar, so overlays like the report form are hand-rolled inline UI, not shadcn dialogs |
| Data fetching | Plain **axios** instance (`src/lib/api.ts`) — no React Query/SWR. Each `lib/*.ts` file exports typed async functions per domain, called directly from components |
| Auth | AWS Amplify v6, Cognito-backed |
| Realtime/media | `socket.io-client` + `mediasoup-client` (the call feature — see `docs/WS_SFU.md`) |
| Testing | Vitest + `@testing-library/react` + jsdom. Only 2 test files exist: `post-card.test.tsx`, `trending-widget.test.tsx` |

`vite.config.ts` and `vitest.config.ts` are intentionally separate — this project's Vite (rolldown-based v8) has a TS-level Plugin type mismatch with vitest's bundled Vite, so tests run on esbuild's default TSX transform instead of the React plugin.

## Routes

The tree is wrapped `ThemeProvider` → `AuthProvider` → `Routes`.

| Path | Page | Guard | What it does |
|---|---|---|---|
| `/` | `Home.tsx` | `RequireAuth` | Composer (`CreatePostForm`) + infinite-scrolling home feed (`PostList` / `getFeed`), with a sidebar (`SearchBar` + `TrendingWidget`). Optimistically prepends just-created posts. |
| `/messages` | `Messages.tsx` | `RequireAuth` | Conversation list + chat thread + entry point into `CallPanel` for voice/video calls. |
| `/settings` | `Settings.tsx` | `RequireAuth` | Edit-own-profile form (username, display name, bio, avatar/cover upload, location, website, birthdate, private-account toggle), field-level validation errors from `ApiError.fieldErrors`. |
| `/profile/:username` | `Profile.tsx` | `RequireAuth` | Public profile: cover/avatar, verified/private badges, bio/location/website/join-date, follower/following/post counts, follow/unfollow (or "Requested" for private accounts), "Message" link, that user's paginated posts. Shows an edit button instead of follow controls on your own profile. |
| `/moderation` | `Moderation.tsx` | `RequireRole(["admin","moderator"])` | Suspend/reinstate a user by username; open-report queue with per-report "Remove content" and "Resolve" actions. |
| `/login` | `LogIn.tsx` | `RequireGuest` | Cognito `signIn()`; redirects to `/confirm-sign-up` if unconfirmed, else refreshes auth state and navigates home. |
| `/sign-up` | `SignUp.tsx` | `RequireGuest` | Client-side validates email/username/password strength (live checklist) before Cognito `signUp()`, generating a DiceBear avatar as the `picture` attribute. |
| `/confirm-sign-up` | `ConfirmSignUp.tsx` | `RequireGuest` | 6-digit code confirmation (`confirmSignUp()`), with a resend action. Redirects to `/sign-up` if no email was passed in router state. |
| `/forgot-password` | `ForgotPassword.tsx` | `RequireGuest` | Cognito `resetPassword()`. Deliberately treats "user not found" the same as success, to avoid leaking account existence. |
| `/reset-password` | `ResetPassword.tsx` | `RequireGuest` | Code + new password → `confirmResetPassword()`. |
| `*` | — | — | Redirects to `/`. No dedicated 404 page exists. |

**Guards** (`src/components/route-guards.tsx`): `RequireAuth` (redirects to `/login` if signed out), `RequireGuest` (redirects signed-in users away), `RequireRole({anyOf})` (requires auth *and* at least one matching Cognito group — unauthenticated → `/login`, authenticated-but-unauthorized → `/`).

## Auth flow

- **Configuration**: `Amplify.configure(amplify_outputs.json)` in `main.tsx` — a static, generated file wiring the app to a specific Cognito User Pool/Client in `eu-central-1`.
- **Backend definition** (`amplify/auth/resource.ts`): email-based login, two Cognito User Pool Groups — `admin` and `moderator` — used directly as the app's RBAC tiers (no separate roles table anywhere), required+mutable `preferredUsername`/`profilePicture` attributes, and a `postConfirmation` Lambda trigger (`aws/lambda/postConfirmation/`, see `docs/INFRASTRUCTURE.md`) that provisions the Postgres `users` row.
- **Not used**: `amplify/backend.ts` only registers `auth` — the AppSync/GraphQL `data` resource present in `amplify_outputs.json` is unused Amplify scaffold (a default `Todo` model). All real data access is REST, not GraphQL.
- **Context** (`src/lib/auth-context.tsx`): `useAuth()` exposes `user`, `roles` (from the ID token's `cognito:groups` claim), `loading`, `refresh()`, `signOut()`.
- **Pages call Amplify directly** (`signIn`, `signUp`, `confirmSignUp`, `resendSignUpCode`, `resetPassword`, `confirmResetPassword`) rather than through a custom backend auth API.
- **Session → API bridge**: `src/lib/api.ts`'s request interceptor calls `fetchAuthSession()` on every request and attaches the Cognito **access token** as `Authorization: Bearer <token>`.

## API client layer (`src/lib/api.ts`)

A single shared axios instance (`api`, base URL `VITE_API_URL`) with a request interceptor that attaches the bearer token, and a response interceptor that normalizes errors into a custom `ApiError` (`status`, `message`, optional per-field `fieldErrors`).

Two deliberate exceptions to using this shared client:
- **`media.ts`** uses a bare `axios.put()` (not `api`) to PUT files directly to a presigned S3 URL — it must *not* carry the app's own bearer token, since the presigned URL is self-authenticating.
- **`analytics.ts`** uses raw `fetch` against a wholly separate service base URL (`VITE_ANALYTICS_URL`) — a different backend microservice, not the main API.

## `src/lib/` reference

| File | Purpose |
|---|---|
| `api.ts` | Shared axios client, auth interceptor, `ApiError`. |
| `feed.ts` | `getFeed(cursor?, limit?)` — home feed. |
| `post.ts` | Post CRUD + like/unlike; `Post`/`PostPage`/`CreatePostPayload` types. |
| `comment.ts` | Comment CRUD. |
| `follow.ts` | Follow/unfollow, follow status, and follow-*request* management (`getPendingFollowRequests`, `accept`/`rejectFollowRequest`) — supports private accounts' approval flow. |
| `media.ts` | Presigned-S3-upload flow: `requestPresignedUpload`, `uploadMedia` (avatar/cover), `uploadPostMedia` (post attachments). |
| `moderation.ts` | `Report` type, `fileReport`, `getOpenReports`, `resolveReport`, `suspendUser`/`reinstateUser`, `removePost`/`removeComment`. |
| `search.ts` | `searchUsers(query)`. |
| `analytics.ts` | Trending posts/hashtags from the separate analytics service — explicitly best-effort, swallows failures. |
| `theme-context.tsx` | `ThemeProvider`/`useTheme()` — light/dark/system, persisted to `localStorage`, resolves `system` via a `prefers-color-scheme` listener. |
| `validators.ts` | Email format + password strength checks (mirrors the Cognito password policy). |
| `utils.ts` | `cn()` class merging, `formatRelativeTime()`. |
| `auth-context.tsx` | See "Auth flow" above. |
| `user.ts` | `UserProfile`/`PublicUserProfile` types, `getCurrentUser`, `getPublicUser`, `updateCurrentUser`. |
| `ws-sfu.ts` | Call/messaging Socket.IO client — see `docs/WS_SFU.md`. |

## Notable components (`src/components/`)

| Component | Purpose |
|---|---|
| `app-layout.tsx` | Authenticated shell — desktop sidebar (nav, theme toggle, account card) / mobile header + bottom nav, optional right-sidebar slot and sticky sub-header. Every authenticated page wraps its content in this. |
| `auth-layout.tsx` | Shared card-centered shell for every guest/auth page. |
| `post-card.tsx` | A single post: author header, text, media (`PostMedia` handles `IMAGE`/`VIDEO`/`AUDIO` and `PROCESSING`/`FAILED`/`READY` states — video/audio plays via an HLS playlist produced by `worker`), hashtags, action bar (optimistic like, comments toggle, share, report toggle). Embeds `CommentSection` and `ReportForm` inline. `React.memo`-wrapped. |
| `post-list.tsx` | Generic paginated feed renderer (parameterized by a `fetchPage` function, reused for both the home feed and a profile's posts) — `IntersectionObserver`-based infinite scroll via `usePaginatedPosts`. |
| `post-card-skeleton.tsx` | Loading placeholder matching `post-card.tsx`'s layout. |
| `comment-section.tsx` | Inline expandable comment thread — reply input, comment list, per-comment report toggle. |
| `create-post-form.tsx` | Post composer — 500-char text with a progress ring, optional single image, optional hashtags (up to 10, parsed client-side). |
| `trending-widget.tsx` | Sidebar widget: trending hashtags + "hot" posts from the analytics service, hydrated to full `Post` objects. Renders nothing on failure/empty. |
| `search-bar.tsx` | Debounced (300ms) user search-as-you-type. |
| `report-form.tsx` | Reusable inline report form (`POST`/`COMMENT`/`USER`), shared by `post-card.tsx` and `comment-section.tsx`. |
| `logo.tsx` | The escld wordmark/icon. |
| `call-panel.tsx`, `call-chat.tsx` | The call feature UI — see `docs/WS_SFU.md`. |

## Hooks (`src/hooks/`)

- **`use-paginated-posts.ts`** — cursor-pagination engine behind `PostList`. Loads page 1 on mount, `loadMore()` guarded against duplicate in-flight loads. Deliberately does *not* react to a changed `fetchPage` identity after mount — callers remount via a `key` prop instead (e.g. `Profile.tsx` keys `PostList` by username) to avoid cascading-render issues.
- **`use-call.ts`** — the call feature's state machine. See `docs/WS_SFU.md`.

## Environment variables

| Variable | Default | Used for |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8080` | Main backend REST API. |
| `VITE_WS_SFU_URL` | `http://localhost:4000` | Call/messaging service. |
| `VITE_ANALYTICS_URL` | `http://localhost:4100` | Trending/analytics service. |

Amplify/Cognito config comes from the static `amplify_outputs.json` file, not env vars.

## Known gaps

- **No 404 page** — the catch-all route silently redirects to `/`.
- **Follow-request management has no UI.** `lib/follow.ts` exports `getPendingFollowRequests`/`accept`/`rejectFollowRequest`, and the backend fully implements the corresponding endpoints, but no page or component in `src/pages`/`src/components` renders them — a private account has no way to actually see or act on pending follow requests today.
