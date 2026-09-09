import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwsClient } from "google-auth-library";

const providerFactory = vi.fn();

vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: (...args: unknown[]) => providerFactory(...args),
}));

const { EcsAwsSecurityCredentialsSupplier, buildExternalAccountClient } = await import("./gcp-auth.js");

beforeEach(() => {
  providerFactory.mockReset();
});

describe("EcsAwsSecurityCredentialsSupplier", () => {
  it("returns the configured AWS region", async () => {
    providerFactory.mockReturnValue(vi.fn());
    const supplier = new EcsAwsSecurityCredentialsSupplier("eu-central-1");

    await expect(supplier.getAwsRegion()).resolves.toBe("eu-central-1");
  });

  it("maps the resolved AWS SDK credential fields onto google-auth-library's shape", async () => {
    providerFactory.mockReturnValue(
      vi.fn().mockResolvedValue({
        accessKeyId: "AKIA...",
        secretAccessKey: "secret",
        sessionToken: "session-token",
      })
    );
    const supplier = new EcsAwsSecurityCredentialsSupplier("eu-central-1");

    await expect(supplier.getAwsSecurityCredentials()).resolves.toEqual({
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
      token: "session-token",
    });
  });

  it("omits token entirely rather than setting it to undefined when there's no session token", async () => {
    providerFactory.mockReturnValue(
      vi.fn().mockResolvedValue({ accessKeyId: "AKIA...", secretAccessKey: "secret" })
    );
    const supplier = new EcsAwsSecurityCredentialsSupplier("eu-central-1");

    const credentials = await supplier.getAwsSecurityCredentials();

    expect(credentials).toEqual({ accessKeyId: "AKIA...", secretAccessKey: "secret" });
    expect("token" in credentials).toBe(false);
  });

  it("builds the underlying provider chain once, not per credential fetch — it's only memoized/expiry-aware across calls to the same instance", async () => {
    const provider = vi.fn().mockResolvedValue({ accessKeyId: "a", secretAccessKey: "b" });
    providerFactory.mockReturnValue(provider);

    const supplier = new EcsAwsSecurityCredentialsSupplier("eu-central-1");
    await supplier.getAwsSecurityCredentials();
    await supplier.getAwsSecurityCredentials();
    await supplier.getAwsSecurityCredentials();

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(3);
  });
});

describe("buildExternalAccountClient", () => {
  it("constructs a real AwsClient wired to the given provider, service account, and region", () => {
    providerFactory.mockReturnValue(vi.fn());

    const client = buildExternalAccountClient(
      "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws",
      "bq-sink@my-project.iam.gserviceaccount.com",
      "eu-central-1"
    );

    expect(client).toBeInstanceOf(AwsClient);
  });
});
