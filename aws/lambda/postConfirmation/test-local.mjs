import { handler } from "./index.mjs";

// Requires DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD/DB_SSL env vars
// pointing at a real, reachable Postgres with the real `users` table schema
// applied (backend/src/main/resources/db/migration) — DB_SECRET_ARN
// deliberately left unset so resolveDbConfig() takes the local-testing
// fallback path, not a real AWS Secrets Manager call.

function event(overrides) {
  return {
    triggerSource: "PostConfirmation_ConfirmSignUp",
    request: {
      userAttributes: {
        sub: crypto.randomUUID(),
        email: `lambda-test-${Date.now()}@example.invalid`,
        preferred_username: `lambda_test_${Date.now()}`,
        picture: "https://api.dicebear.com/9.x/identicon/svg?seed=lambda_test_user",
        ...overrides,
      },
    },
  };
}

const first = event();
const result = await handler(first);
console.log("[1] handler returned event unchanged:", result === first);

// Re-invoking with the SAME cognito_sub (Cognito can call PostConfirmation
// more than once for one signup) must be a harmless no-op, not an error.
await handler(first);
console.log("[2] re-invocation with the same cognito_sub did not throw");

// A genuine username conflict (different cognito_sub, same username) must
// be caught and logged distinctly, never thrown back to Cognito.
const conflicting = event({ sub: crypto.randomUUID(), preferred_username: first.request.userAttributes.preferred_username });
await handler(conflicting);
console.log("[3] a real username conflict was caught, not thrown");

console.log("ALL POSTCONFIRMATION LOCAL CHECKS COMPLETED");
