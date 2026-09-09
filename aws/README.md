# aws/

Manually-managed AWS artifacts, separate from the CDK-provisioned infra in `infra/`.

## json/

IAM policy documents, meant to be attached to roles via the AWS Console (or `aws iam put-role-policy`) rather than through CDK. Replace the placeholder tokens (`AWS_REGION`, `AWS_ID`, `BUCKET_NANE`, `CLOUDFRONT_ID`) with real values before applying.

- `postconfirmation-lambda-execution-policy.json` — **superseded, kept for reference only.** Both Cognito trigger Lambdas below are now built via `frontend/amplify/auth/resource.ts`'s CDK "provider function" form (`NodejsFunction`), which auto-generates its own execution role (CloudWatch Logs, plus VPC ENI permissions and a Secrets Manager read grant when `AUTH_LAMBDA_VPC_ID`/`DB_SECRET_ARN` are configured — see below) — there is no manual role to attach this JSON to anymore. This file predates that wiring, when the Lambda was still deployed via Amplify's plain declarative `defineFunction`, which can't attach a VPC at all.
- `s3-media-access-policy.json` — least-privilege access to the media bucket for presigned upload/read.
- `cloudfront-invalidation-policy.json` — permissions to invalidate the media CloudFront distribution's cache (not yet called from app code — here for when that's needed).

## lambda/

Two Cognito trigger Lambdas, both wired into `frontend/amplify/auth/resource.ts`'s `defineAuth({ triggers: { preSignUp, postConfirmation } })` and deployed as real CDK-managed (`aws-cdk-lib/aws-lambda-nodejs`) functions — not Amplify's plain declarative `defineFunction`, which has no way to attach a VPC. Both are real-VPC-attached in production so they can reach Postgres, which lives in a `PRIVATE_ISOLATED` subnet (`infra/lib/database-stack.ts`) unreachable from a default (non-VPC) Lambda execution environment.

Cross-app values (VPC id, private-isolated subnet ids, the dedicated Lambda security group, the RDS-managed Secrets Manager secret ARN) come in as environment variables set on whatever runs `ampx pipeline-deploy` in production — printed by `infra/lib/database-stack.ts`'s own `VpcIdForAuthLambdas`/`PrivateIsolatedSubnetIdsForAuthLambdas`/`AuthLambdaSecurityGroupId`/`DbSecretArn` CfnOutputs after deploying that stack:

```
AUTH_LAMBDA_VPC_ID=<VpcIdForAuthLambdas>
AUTH_LAMBDA_SUBNET_IDS=<PrivateIsolatedSubnetIdsForAuthLambdas, comma-separated>
AUTH_LAMBDA_SECURITY_GROUP_ID=<AuthLambdaSecurityGroupId>
DB_SECRET_ARN=<DbSecretArn>
```

All four are optional and absent by default — without them, `resource.ts` builds both functions with no VPC attachment at all, which is what a local `ampx sandbox` run needs (no real VPC to attach to, and no need for one: local dev's docker-compose Postgres is reachable directly). `DB_SSL`/`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` remain as a local-testing-only fallback (see `shared/db.mjs`'s `resolveDbConfig`), ignored entirely once `DB_SECRET_ARN` is set.

### lambda/shared/

`db.mjs`'s `resolveDbConfig()` — fetches real `pg` connection config from the RDS-managed Secrets Manager secret on *every* invocation (not cached, not read once at cold start), since that secret auto-rotates every 30 days (`infra/lib/database-stack.ts`'s `addRotationSingleUser`) and a value read once would silently go stale after the first rotation. Also exports `USERNAME_FORMAT`, the same regex Postgres's own `users_username_format_check` constraint and the frontend's `isValidUsername` both enforce.

Needs its own `npm install` (a Node ESM sibling-directory import doesn't resolve through `postConfirmation/`'s or `preSignUp/`'s own `node_modules`) — done automatically by `NodejsFunction`'s Docker-forced bundling at deploy time; run manually only for local `test-local.mjs` runs.

### lambda/postConfirmation/

Provisions the Postgres `users` row when a signup is confirmed — fire-and-forget: a DB failure here logs and lets the confirmation succeed regardless (see `index.mjs`'s header comment), since the row can be backfilled later via the backend's own `getOrProvisionByCognitoSub` fallback. Distinguishes a genuine username/email UNIQUE-constraint conflict (logged distinctly, `error.code === '23505'`) from every other kind of failure.

`npm install` in this directory before running `test-local.mjs` locally (bundles `pg` + `@aws-sdk/client-secrets-manager`) — not needed for a real deploy, `NodejsFunction` bundles fresh via Docker.

### lambda/preSignUp/

Rejects a signup outright — the one Cognito trigger where throwing is the intended way to fail a signup — if `preferred_username` is already taken in Postgres or fails the format check. Exists because Cognito's own User Pool config (`loginWith: { email: true }` only) does not treat `preferred_username` as a login alias, so nothing at the Cognito level stops two signups from picking the same username; without this check, the second signup's Postgres insert would silently fail deep inside `postConfirmation`'s fire-and-forget handler, permanently orphaning that account (confirmed, not assumed — this account is real and unrecoverable once the username is claimed, since `postConfirmation` never surfaces the failure back to the client). Deliberately fails *open* (logs and allows the signup) if Postgres itself is unreachable — see `index.mjs`'s header comment for why.

`npm install` in this directory before running `test-local.mjs` locally — same as `postConfirmation/`.
