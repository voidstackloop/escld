#!/usr/bin/env python3
"""Turns the CSVs exported by seed_1000.sql into AWS CLI batch-request files:
DynamoDB BatchWriteItem files for the follow graph, and SQS SendMessageBatch
files for post-created events. Kept as plain stdlib (csv/json) so this runs
anywhere python3 does, no extra install needed.
"""
import csv
import json
import os
import re
import sys

OUT_DIR = "/tmp/loadtest_batches"
FOLLOWS_TABLE = os.environ.get("DYNAMODB_FOLLOWS_TABLE", "follows")


def to_iso(pg_timestamp: str) -> str:
    # Postgres \copy renders timestamptz as "2026-07-20 21:00:00.123456+00".
    s = pg_timestamp.strip().replace(" ", "T", 1)
    s = re.sub(r"([+-]\d\d)$", r"\1:00", s)
    if s.endswith("+00:00"):
        s = s[: -len("+00:00")] + "Z"
    return s


def write_json(path: str, data) -> None:
    with open(path, "w") as f:
        json.dump(data, f)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    # -- follow graph -> DynamoDB BatchWriteItem files (25 items/batch, 2 items/edge) --
    edges = []
    with open("/tmp/seed_follows.csv", newline="") as f:
        for follower_id, followee_id in csv.reader(f):
            edges.append((follower_id, followee_id))

    items = []
    for follower_id, followee_id in edges:
        items.append({
            "PutRequest": {"Item": {
                "pk": {"S": f"USER#{follower_id}"},
                "sk": {"S": f"FOLLOWING#{followee_id}"},
                "createdAt": {"S": "2026-01-01T00:00:00Z"},
            }}
        })
        items.append({
            "PutRequest": {"Item": {
                "pk": {"S": f"USER#{followee_id}"},
                "sk": {"S": f"FOLLOWER#{follower_id}"},
                "createdAt": {"S": "2026-01-01T00:00:00Z"},
            }}
        })

    follow_batch_count = 0
    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        write_json(f"{OUT_DIR}/follows_{follow_batch_count:05d}.json", {FOLLOWS_TABLE: chunk})
        follow_batch_count += 1

    # -- posts -> SQS SendMessageBatch files (10 entries/batch) --
    posts = []
    with open("/tmp/seed_posts.csv", newline="") as f:
        for post_id, user_id, text, created_at, tags in csv.reader(f):
            posts.append({
                "eventType": "CREATED",
                "postId": post_id,
                "authorId": user_id,
                "text": text,
                "tags": tags.split("|") if tags else [],
                "createdAt": to_iso(created_at),
            })

    event_batch_count = 0
    for i in range(0, len(posts), 10):
        chunk = posts[i:i + 10]
        entries = [
            {"Id": str(j), "MessageBody": json.dumps(event)}
            for j, event in enumerate(chunk)
        ]
        write_json(f"{OUT_DIR}/events_{event_batch_count:05d}.json", entries)
        event_batch_count += 1

    print(f"edges={len(edges)} follow_items={len(items)} follow_batches={follow_batch_count}")
    print(f"posts={len(posts)} event_batches={event_batch_count}")


if __name__ == "__main__":
    sys.exit(main())
