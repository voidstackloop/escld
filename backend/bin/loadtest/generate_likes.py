#!/usr/bin/env python3
"""Generates a synthetic like graph over the posts/users seeded by
seed_50000.sql: DynamoDB BatchWriteItem files (matching LikeStore's exact
two-item-per-like schema: pk=POST#<id>/sk=LIKE#<userId> and
pk=USER#<id>/sk=LIKED#<postId>, both carrying createdAt/updatedAt/deleted/
entityVersion) plus a CSV of per-post like counts, since this bypasses the
real LikeServiceImpl.like() path that would normally increment
posts.like_count on each call — that denormalized counter needs a matching
bulk UPDATE afterward (see apply_like_counts.sql, generated alongside).

Kept as plain stdlib, same as generate_batches.py.
"""
import csv
import json
import os
import random
import sys
import time
from collections import defaultdict

OUT_DIR = "/tmp/loadtest_batches"
LIKES_TABLE = os.environ.get("DYNAMODB_LIKES_TABLE", "likes")
NOW = "2026-01-01T00:00:00Z"

# Each user likes a random subset of posts, average ~8 (a modest, realistic
# density — not the point of this load test the way comments/tags/follow
# -recency are, so kept proportionate rather than maximal).
MIN_LIKES_PER_USER = 0
MAX_LIKES_PER_USER = 20


def write_json(path: str, data) -> None:
    with open(path, "w") as f:
        json.dump(data, f)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    random.seed(50000)

    with open("/tmp/seed_users.csv", newline="") as f:
        user_ids = [row[0] for row in csv.reader(f)]
    with open("/tmp/seed_posts.csv", newline="") as f:
        post_ids = [row[0] for row in csv.reader(f)]

    like_counts = defaultdict(int)
    items = []
    for user_id in user_ids:
        n = random.randint(MIN_LIKES_PER_USER, MAX_LIKES_PER_USER)
        n = min(n, len(post_ids))
        liked = random.sample(post_ids, n)
        for post_id in liked:
            like_counts[post_id] += 1
            version = int(time.time() * 1000)
            items.append({"PutRequest": {"Item": {
                "pk": {"S": f"POST#{post_id}"},
                "sk": {"S": f"LIKE#{user_id}"},
                "createdAt": {"S": NOW},
                "updatedAt": {"S": NOW},
                "deleted": {"BOOL": False},
                "entityVersion": {"N": str(version)},
            }}})
            items.append({"PutRequest": {"Item": {
                "pk": {"S": f"USER#{user_id}"},
                "sk": {"S": f"LIKED#{post_id}"},
                "createdAt": {"S": NOW},
                "updatedAt": {"S": NOW},
                "deleted": {"BOOL": False},
                "entityVersion": {"N": str(version)},
            }}})

    batch_count = 0
    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        write_json(f"{OUT_DIR}/likes_{batch_count:05d}.json", {LIKES_TABLE: chunk})
        batch_count += 1

    with open("/tmp/seed_like_counts.csv", "w", newline="") as f:
        writer = csv.writer(f)
        for post_id, count in like_counts.items():
            writer.writerow([post_id, count])

    print(f"like_edges={len(items) // 2} like_items={len(items)} batches={batch_count} "
          f"posts_with_likes={len(like_counts)}")


if __name__ == "__main__":
    sys.exit(main())
