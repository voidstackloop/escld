import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});

/**
 * Resolves real `pg` connection config for a Cognito trigger Lambda.
 *
 * Production: `DB_SECRET_ARN` points at the RDS-generated Secrets Manager
 * secret (`infra/lib/database-stack.ts`'s `DbSecretArn` output). Fetched
 * fresh on *every* invocation rather than read once from a static env var —
 * that secret auto-rotates every 30 days (the same stack's
 * `addRotationSingleUser`), so a value baked into a plain env var at deploy
 * time would silently go stale the moment the first rotation ran, with
 * every subsequent invocation failing to authenticate. A cold-start-only
 * fetch would have the identical problem for any invocation after the next
 * rotation on an already-warm execution environment.
 *
 * Local testing (`test-local.mjs`, no real AWS Secrets Manager reachable):
 * set `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` directly and
 * leave `DB_SECRET_ARN` unset.
 */
export async function resolveDbConfig() {
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined;

  if (process.env.DB_SECRET_ARN) {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
    const secret = JSON.parse(response.SecretString);
    return {
      host: secret.host,
      port: Number(secret.port ?? 5432),
      database: secret.dbname,
      user: secret.username,
      password: secret.password,
      ssl,
      connectionTimeoutMillis: 5000,
    };
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl,
    connectionTimeoutMillis: 5000,
  };
}

/** The same format Postgres's own `users_username_format_check` constraint
 * enforces (`backend/src/main/resources/db/migration/V1__create_users_table.sql`)
 * and the frontend's `isValidUsername` mirrors — kept here too so a
 * PreSignUp rejection and a PostConfirmation failure never disagree about
 * what's a valid username. */
export const USERNAME_FORMAT = /^[a-zA-Z0-9_]{3,30}$/;
