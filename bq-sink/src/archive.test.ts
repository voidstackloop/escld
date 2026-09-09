import { describe, expect, it, vi } from "vitest";

import { NoopArchiveWriter, S3ArchiveWriter } from "./archive.js";

describe("S3ArchiveWriter", () => {
  it("noop writer resolves without side effects", async () => {
    await expect(new NoopArchiveWriter().writeBatch([])).resolves.toBeUndefined();
    await expect(
      new NoopArchiveWriter().writeBatch([
        { topic: "post.created", partition: 0, offset: "0", envelopeJson: "{}" },
      ])
    ).resolves.toBeUndefined();
  });

  it("writes gzipped JSONL keyed by date and first offset", async () => {
    const send = vi.fn().mockResolvedValue({});
    const s3 = { send } as unknown as import("@aws-sdk/client-s3").S3Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as unknown as import("./logger.js").Logger;
    const writer = new S3ArchiveWriter(s3, "archive-bucket", "escld-events", logger);

    await writer.writeBatch([
      { topic: "post.created", partition: 2, offset: "123", envelopeJson: '{"eventId":"a"}' },
      { topic: "post.created", partition: 2, offset: "124", envelopeJson: '{"eventId":"b"}' },
    ]);

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]?.[0] as unknown as { input: Record<string, unknown> };
    expect(cmd.input.Bucket).toBe("archive-bucket");
    expect(cmd.input.Key as string).toMatch(/^escld-events\/dt=\d{4}-\d{2}-\d{2}\/hour=\d{2}\/post\.created-2-123\.json\.gz$/);
    expect(cmd.input.ContentEncoding).toBe("gzip");
  });
});
