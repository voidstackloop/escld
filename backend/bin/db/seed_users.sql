-- Local dev seed data. Not a Flyway migration — apply manually via bin/db/seed.sh.
INSERT INTO users (cognito_sub, username, email, display_name, avatar_url, status)
VALUES (
    '23c46852-d051-70d8-ccfe-66666f587097',
    'test12354',
    'salihyilboga13@gmail.com',
    'test12354',
    'https://api.dicebear.com/9.x/identicon/svg?seed=test12354',
    'ACTIVE'
)
ON CONFLICT (cognito_sub) DO UPDATE SET
    username = EXCLUDED.username,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    avatar_url = EXCLUDED.avatar_url,
    status = EXCLUDED.status;

-- Synthetic second user (no real Cognito account) — exists purely so local dev
-- can exercise follow/unfollow, search, etc. against something other than the
-- one real seeded account.
INSERT INTO users (cognito_sub, username, email, display_name, avatar_url, status)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'dev_buddy',
    'dev-buddy@example.invalid',
    'Dev Buddy',
    'https://api.dicebear.com/9.x/identicon/svg?seed=dev_buddy',
    'ACTIVE'
)
ON CONFLICT (cognito_sub) DO UPDATE SET
    username = EXCLUDED.username,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    avatar_url = EXCLUDED.avatar_url,
    status = EXCLUDED.status;
