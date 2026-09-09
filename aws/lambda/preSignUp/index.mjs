import { Client } from "pg";
import { resolveDbConfig, USERNAME_FORMAT } from "../shared/db.mjs";

/**
 * Cognito PreSignUp trigger — rejects a signup outright if `preferred_username`
 * is already taken, closing a real gap the rest of the system leaves open:
 * Cognito's own `preferred_username` attribute is a plain mutable string
 * here, not configured as a login alias, so nothing about the User Pool
 * itself stops two signups from choosing the same value. Postgres does
 * enforce uniqueness (`users_username_key` in
 * `backend/src/main/resources/db/migration/V1__create_users_table.sql`),
 * but by the time that constraint fires — inside `postConfirmation`, a
 * fire-and-forget trigger that must never throw — the user has *already*
 * confirmed a real Cognito account with no way to ever get a Postgres
 * profile row for it (the username is permanently claimed by the other
 * account). This trigger catches that at the one point where throwing is
 * exactly the right thing to do: PreSignUp errors surface directly to the
 * client as the actual signup failure, before an account exists at all.
 *
 * Unlike `postConfirmation`, this one is explicitly allowed to throw — that
 * IS how a PreSignUp trigger rejects a signup, per Cognito's own contract.
 * The frontend's `SignUp.tsx` catch block will surface whatever message is
 * thrown here.
 *
 * Deliberately fails *open* (logs and lets the signup proceed) if Postgres
 * itself is unreachable — the failure mode this is guarding against is a
 * same-username race under normal operation, not a database outage; making
 * every signup depend on this one check being reachable would trade a rare
 * problem (a lost username race) for a much worse one (signups going down
 * entirely whenever this Lambda can't reach the database). A genuine
 * username collision is still caught as a real, if late, unique-constraint
 * conflict inside `postConfirmation` even if this check couldn't run.
 */
export const handler = async (event) => {
  if (event.triggerSource !== "PreSignUp_SignUp") {
    return event;
  }

  const username = event.request.userAttributes?.preferred_username;
  if (!username) {
    // No preferred_username attribute at all — SignUp.tsx always sends one,
    // but nothing stops a direct API/SDK call from omitting it. Let
    // Cognito's own `required: true` attribute-schema validation (see
    // frontend/amplify/auth/resource.ts) be the thing that rejects this,
    // not a duplicate check here.
    return event;
  }

  if (!USERNAME_FORMAT.test(username)) {
    throw new Error("Username must be 3-30 characters, letters, numbers, and underscores only.");
  }

  const client = new Client(await resolveDbConfig());

  try {
    await client.connect();
    const result = await client.query(
      // CITEXT column — Postgres itself does the case-insensitive compare,
      // matching how the UNIQUE index (users_username_key) already treats
      // "Alice" and "alice" as the same username.
      `SELECT 1 FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );
    if (result.rowCount > 0) {
      throw new Error(`Username "${username}" is already taken.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Username")) {
      throw error; // the real, intended rejection — propagate it to Cognito
    }
    console.error("PreSignUp: could not check username availability, allowing signup to proceed", {
      username,
      error: error instanceof Error ? error.message : error,
    });
  } finally {
    await client.end().catch(() => {});
  }

  return event;
};
