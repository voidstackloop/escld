CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub      UUID NOT NULL,
    username         CITEXT NOT NULL,
    email            CITEXT NOT NULL,
    display_name     VARCHAR(50) NOT NULL,
    bio              VARCHAR(160),
    avatar_url       TEXT,
    cover_image_url  TEXT,
    location         VARCHAR(100),
    website_url      TEXT,
    birthdate        DATE,
    is_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    is_private       BOOLEAN NOT NULL DEFAULT FALSE,
    status           VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    followers_count  INTEGER NOT NULL DEFAULT 0,
    following_count  INTEGER NOT NULL DEFAULT 0,
    posts_count      INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,

    CONSTRAINT users_status_check
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
    CONSTRAINT users_username_format_check
        CHECK (username ~ '^[a-zA-Z0-9_]{3,30}$'),
    CONSTRAINT users_followers_count_check CHECK (followers_count >= 0),
    CONSTRAINT users_following_count_check CHECK (following_count >= 0),
    CONSTRAINT users_posts_count_check CHECK (posts_count >= 0)
);

-- One Postgres profile row per Cognito identity; email/password/verification stay in Cognito.
CREATE UNIQUE INDEX users_cognito_sub_key ON users (cognito_sub);
CREATE UNIQUE INDEX users_username_key ON users (username);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;

CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
