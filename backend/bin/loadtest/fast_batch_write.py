#!/usr/bin/env python3
"""Fast replacement for the sequential `aws dynamodb batch-write-item` /
`aws sqs send-message-batch` shell loop in run_50000.sh: reads the exact same
already-generated /tmp/loadtest_batches/*.json files and submits them via one
long-lived boto3 client (no per-call process-spawn cost) with a thread pool
for concurrency. Same requests, same endpoint, same data — just fast.
"""
import glob
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

ENDPOINT = os.environ.get("DYNAMODB_URL", "http://localhost:8000")
SQS_ENDPOINT = os.environ.get("SQS_URL", "http://localhost:9324")
QUEUE_URL = os.environ.get("QUEUE_URL", f"{SQS_ENDPOINT}/000000000000/post-events")
REGION = os.environ.get("AWS_REGION", "eu-central-1")

os.environ.setdefault("AWS_ACCESS_KEY_ID", "local")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "local")


def write_dynamo_batches(pattern: str, workers: int = 16) -> None:
    ddb = boto3.client("dynamodb", endpoint_url=ENDPOINT, region_name=REGION)
    files = sorted(glob.glob(pattern))
    total = len(files)
    print(f"{pattern}: {total} batches")

    def do_one(path):
        with open(path) as f:
            request_items = json.load(f)
        # DynamoDB batch-write can leave UnprocessedItems under local load;
        # retry those a few times rather than silently dropping rows.
        for attempt in range(5):
            resp = ddb.batch_write_item(RequestItems=request_items)
            unprocessed = resp.get("UnprocessedItems") or {}
            if not unprocessed:
                return None
            request_items = unprocessed
            time.sleep(0.05 * (attempt + 1))
        return path  # still unprocessed after retries

    done = 0
    failed = []
    start = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(do_one, f) for f in files]
        for fut in as_completed(futures):
            done += 1
            result = fut.result()
            if result:
                failed.append(result)
            if done % 200 == 0 or done == total:
                elapsed = time.time() - start
                print(f"  {done}/{total} done ({elapsed:.1f}s, {done/elapsed:.1f}/s)")
    if failed:
        print(f"  WARNING: {len(failed)} batches still had unprocessed items after retries: {failed[:5]}")


def send_sqs_batches(pattern: str, workers: int = 16) -> None:
    sqs = boto3.client("sqs", endpoint_url=SQS_ENDPOINT, region_name=REGION)
    files = sorted(glob.glob(pattern))
    total = len(files)
    print(f"{pattern}: {total} batches")

    def do_one(path):
        with open(path) as f:
            entries = json.load(f)
        resp = sqs.send_message_batch(QueueUrl=QUEUE_URL, Entries=entries)
        failures = resp.get("Failed") or []
        return (path, len(failures)) if failures else None

    done = 0
    failed = []
    start = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(do_one, f) for f in files]
        for fut in as_completed(futures):
            done += 1
            result = fut.result()
            if result:
                failed.append(result)
            if done % 500 == 0 or done == total:
                elapsed = time.time() - start
                print(f"  {done}/{total} done ({elapsed:.1f}s, {done/elapsed:.1f}/s)")
    if failed:
        print(f"  WARNING: {len(failed)} batches had send failures: {failed[:5]}")


if __name__ == "__main__":
    kind = sys.argv[1]
    if kind == "follows":
        write_dynamo_batches("/tmp/loadtest_batches/follows_*.json")
    elif kind == "likes":
        write_dynamo_batches("/tmp/loadtest_batches/likes_*.json")
    elif kind == "events":
        send_sqs_batches("/tmp/loadtest_batches/events_*.json")
    else:
        print("usage: fast_batch_write.py [follows|likes|events]")
        sys.exit(1)
