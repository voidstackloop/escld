import { Client } from "pg";
import { resolveDbConfig } from "../shared/db.mjs";

/**
 * Cognito PostConfirmation trigger — provisions the Postgres `users` row for a
 * newly-confirmed account. Cognito is the source of truth for identity; this
 * just mirrors the minimal profile fields Postgres needs.
 *
 * Cognito discards whatever this function returns as long as it returns the
 * event object without throwing — a failure here must NOT block the user's
 * signup. If the DB insert fails, we log it and let confirmation succeed
 * anyway; the row can be backfilled later (via the backend's own
 * `UserServiceImpl.getOrProvisionByCognitoSub` fallback, which every
 * authenticated request already goes through, or manually via `bin/db`)
 * rather than leaving the user stuck mid-signup because of an infra hiccup
 * on our side.
 *
 * The one case this deliberately does NOT paper over: a username collision.
 * `preSignUp/index.mjs` already checks availability before Cognito ever
 * lets the signup proceed, so reaching a UNIQUE-constraint violation here
 * means that check was raced (two signups for the same username landing
 * within the same window) or bypassed — logged distinctly from a generic
 * infra failure so it's easy to tell apart in CloudWatch.
 */
export const handler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
    return event;
  }

  const attributes = event.request.userAttributes;
  const cognitoSub = attributes.sub;
  const email = attributes.email;
  const username = attributes.preferred_username;
  const avatarUrl = attributes.picture;

  if (!cognitoSub || !email || !username) {
    console.error("PostConfirmation: missing required attributes", {
      hasSub: Boolean(cognitoSub),
      hasEmail: Boolean(email),
      hasUsername: Boolean(username),
    });
    return event;
  }

  const client = new Client(await resolveDbConfig());

  try {
    await client.connect();
    const result = await client.query(
      `INSERT INTO users (cognito_sub, username, email, display_name, avatar_url, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       ON CONFLICT (cognito_sub) DO NOTHING
       RETURNING id`,
      [cognitoSub, username, email, username, avatarUrl ?? null]
    );
    if (result.rowCount === 0) {
      // Either this cognito_sub already has a row (a harmless re-invocation —
      // Cognito can call PostConfirmation more than once for the same
      // signup), or a real UNIQUE-constraint conflict on username/email was
      // itself caught below as an error, not here — a plain `DO NOTHING` on
      // cognito_sub alone doesn't silently swallow the other two.
      console.info("PostConfirmation: row already existed for this cognito_sub, no-op", { cognitoSub });
    }
  } catch (error) {
    const isUsernameOrEmailConflict = error?.code === "23505"; // unique_violation
    console.error(
      isUsernameOrEmailConflict
        ? "PostConfirmation: username or email conflicted at insert time (preSignUp's own check was raced or bypassed)"
        : "PostConfirmation: failed to provision users row",
      { cognitoSub, username, error: error instanceof Error ? error.message : error }
    );
  } finally {
    await client.end().catch(() => {});
  }

  return event;
};
