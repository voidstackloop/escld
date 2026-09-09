#!/usr/bin/env python3
"""Backfills the user_search Elasticsearch index and each user's denormalized
posts_count from Postgres. Needed because the 1000-user load-test seed (and
any other user created by directly inserting into Postgres rather than going
through UserServiceImpl) never goes through the app code paths that keep
those two things in sync — see bin/loadtest/seed_1000.sql.
"""
import json
import subprocess
import sys

PG_CONTAINER = "escld-postgres-1"
ES_CONTAINER = "escld-elasticsearch-1"
DB_USER = "escld"
DB_NAME = "escld"


def psql(query: str) -> str:
    return subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", query],
        check=True, capture_output=True, text=True,
    ).stdout


def main() -> None:
    print("Recomputing posts_count for every user...")
    psql("""
        UPDATE users u SET posts_count = (
            SELECT count(*) FROM posts p WHERE p.user_id = u.id AND p.deleted_at IS NULL
        );
    """)

    print("Exporting users for indexing...")
    rows = psql("""
        SELECT id || E'\\t' || username || E'\\t' || display_name || E'\\t' ||
               coalesce(bio, '') || E'\\t' || coalesce(avatar_url, '') || E'\\t' ||
               is_verified || E'\\t' || is_private || E'\\t' || followers_count
        FROM users
        WHERE deleted_at IS NULL;
    """).strip().split("\n")

    bulk_lines = []
    for row in rows:
        if not row.strip():
            continue
        user_id, username, display_name, bio, avatar_url, verified, private, followers = row.split("\t")
        bulk_lines.append(json.dumps({"index": {"_index": "user_search", "_id": user_id}}))
        bulk_lines.append(json.dumps({
            "id": user_id,
            "username": username,
            "displayName": display_name,
            "bio": bio or None,
            "avatarUrl": avatar_url or None,
            "verified": verified == "t",
            "privateAccount": private == "t",
            "followersCount": int(followers),
        }))

    print(f"Indexing {len(bulk_lines) // 2} users into Elasticsearch...")
    body = "\n".join(bulk_lines) + "\n"
    result = subprocess.run(
        ["docker", "exec", "-i", ES_CONTAINER, "curl", "-s", "-X", "POST",
         "http://localhost:9200/user_search/_bulk", "-H", "Content-Type: application/x-ndjson", "--data-binary", "@-"],
        input=body, check=True, capture_output=True, text=True,
    )
    response = json.loads(result.stdout)
    print(f"Bulk index errors: {response.get('errors')}")

    subprocess.run(
        ["docker", "exec", "-i", ES_CONTAINER, "curl", "-s", "-X", "POST", "http://localhost:9200/user_search/_refresh"],
        check=True,
    )
    print("Done.")


if __name__ == "__main__":
    sys.exit(main())
