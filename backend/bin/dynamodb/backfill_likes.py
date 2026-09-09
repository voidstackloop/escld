#!/usr/bin/env python3
"""Backfills the DynamoDB `likes` table from the existing Postgres
`post_likes` rows, in the exact item shape LikeStore.java writes going
forward (see backend/src/main/java/com/escld/backend/like/LikeStore.java):

    pk=POST#<postId>, sk=LIKE#<userId>   -> "does user X like post Y"
    pk=USER#<userId>, sk=LIKED#<postId>  -> "which posts has user X liked"

Needed because LikeServiceImpl now reads/writes likes through DynamoDB only
(see the "post_likes -> DynamoDB" migration) - any like that existed in
Postgres before that cutover is invisible to the app until backfilled here.
Idempotent and safe to re-run: every write is a plain PutItem with no
condition, so re-running just overwrites the same items with themselves.

This does NOT touch posts.likes_count - that counter was already correct
from ongoing app usage and this script doesn't recompute it.
"""
import json
import os
import subprocess
import sys

PG_CONTAINER = "escld-postgres-1"
DB_USER = "escld"
DB_NAME = "escld"
DYNAMODB_ENDPOINT = "http://localhost:8000"
LIKES_TABLE = "likes"
BATCH_SIZE = 25  # DynamoDB BatchWriteItem's per-request limit


def psql(query: str) -> str:
    return subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", query],
        check=True, capture_output=True, text=True,
    ).stdout


def batch_write(items: list[dict]) -> None:
    if not items:
        return
    payload = json.dumps({LIKES_TABLE: [{"PutRequest": {"Item": item}} for item in items]})
    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": os.environ.get("AWS_ACCESS_KEY_ID", "local"),
        "AWS_SECRET_ACCESS_KEY": os.environ.get("AWS_SECRET_ACCESS_KEY", "local"),
        "AWS_DEFAULT_REGION": os.environ.get("AWS_REGION", "eu-central-1"),
    }
    subprocess.run(
        ["aws", "dynamodb", "batch-write-item",
         "--endpoint-url", DYNAMODB_ENDPOINT,
         "--request-items", payload],
        check=True, capture_output=True, text=True, env=env,
    )


def main() -> None:
    print("Exporting post_likes from Postgres...")
    rows = psql("""
        SELECT post_id || E'\\t' || user_id || E'\\t' || created_at
        FROM post_likes;
    """).strip().split("\n")

    rows = [r for r in rows if r.strip()]
    print(f"Found {len(rows)} likes to backfill.")

    items = []
    for row in rows:
        post_id, user_id, created_at = row.split("\t")
        items.append({
            "pk": {"S": f"POST#{post_id}"},
            "sk": {"S": f"LIKE#{user_id}"},
            "createdAt": {"S": created_at},
        })
        items.append({
            "pk": {"S": f"USER#{user_id}"},
            "sk": {"S": f"LIKED#{post_id}"},
            "createdAt": {"S": created_at},
        })

    written = 0
    for i in range(0, len(items), BATCH_SIZE):
        batch = items[i:i + BATCH_SIZE]
        batch_write(batch)
        written += len(batch)
        print(f"  wrote {written}/{len(items)} items")

    print("Done.")


if __name__ == "__main__":
    sys.exit(main())
