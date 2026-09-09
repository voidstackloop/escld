import { handler } from "./index.mjs";

// Same local-testing convention as postConfirmation/test-local.mjs — real
// DB_HOST/etc env vars, DB_SECRET_ARN left unset, a real Postgres with the
// real users table schema already applied and at least one existing row
// (set EXISTING_USERNAME to that row's real username before running).

function event(username) {
  return {
    triggerSource: "PreSignUp_SignUp",
    request: { userAttributes: { preferred_username: username } },
  };
}

// A fresh, never-used username must be allowed through untouched.
const fresh = `lambda_presignup_${Date.now()}`;
const result = await handler(event(fresh));
console.log("[1] a fresh username was allowed (returned event unchanged):", result.request.userAttributes.preferred_username === fresh);

// An already-taken username must be rejected with a clear error.
const existing = process.env.EXISTING_USERNAME;
if (existing) {
  try {
    await handler(event(existing));
    console.log(`[2] FAILED — expected a taken username ("${existing}") to be rejected, but it was not`);
  } catch (err) {
    console.log("[2] a taken username was correctly rejected:", err.message);
  }
} else {
  console.log("[2] skipped — set EXISTING_USERNAME to a real existing username to exercise this case");
}

// An invalid format must be rejected before ever touching the database.
try {
  await handler(event("a b!"));
  console.log("[3] FAILED — expected an invalid-format username to be rejected");
} catch (err) {
  console.log("[3] an invalid-format username was correctly rejected:", err.message);
}

console.log("ALL PRESIGNUP LOCAL CHECKS COMPLETED");
