export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// Mirrors the backend's real constraint (users_username_format_check in
// V1__*.sql) — SignUp.tsx used to only check length >= 2 with no character
// restriction, so a username with e.g. a space or hyphen would pass Cognito
// signup, then fail the backend's CHECK constraint the moment the profile
// row is provisioned on first login (see UserServiceImpl.provision).
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,30}$/.test(username)
}

export const PASSWORD_REQUIREMENTS = [
  { label: "At least 8 characters", test: (v: string) => v.length >= 8 },
  { label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "One lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { label: "One number", test: (v: string) => /[0-9]/.test(v) },
  { label: "One symbol", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
]

export function passwordFailures(password: string): string[] {
  return PASSWORD_REQUIREMENTS.filter((r) => !r.test(password)).map(
    (r) => r.label
  )
}
