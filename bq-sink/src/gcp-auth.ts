import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { AwsClient } from "google-auth-library";
import type { AwsSecurityCredentials, AwsSecurityCredentialsSupplier } from "google-auth-library";

/**
 * Supplies this ECS task's own AWS credentials to google-auth-library's AWS
 * Workload Identity Federation client, in place of the library's built-in
 * credential resolution (env vars, then an EC2-IMDS-style metadata URL) —
 * verified against the installed library's source that neither path
 * understands ECS Fargate's AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
 * mechanism, and there is no EC2 IMDS reachable inside a Fargate task's
 * network namespace at all. `fromNodeProviderChain` is the standard AWS SDK
 * v3 default credential chain — it does understand the ECS container
 * credentials endpoint, and transparently re-resolves/rotates credentials
 * on each call (ECS task-role credentials rotate hourly; baking them into
 * env vars once at boot would pass an initial smoke test and then silently
 * fail about an hour in).
 *
 * One provider instance is built and reused (not rebuilt per call) since
 * its own internal memoization/expiry tracking only works across calls to
 * the same instance.
 */
export class EcsAwsSecurityCredentialsSupplier implements AwsSecurityCredentialsSupplier {
  private readonly provider = fromNodeProviderChain();

  constructor(private readonly awsRegion: string) {}

  async getAwsRegion(): Promise<string> {
    return this.awsRegion;
  }

  async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
    const credentials = await this.provider();
    // exactOptionalPropertyTypes: `token` must be omitted, not set to
    // `undefined`, when there's no session token to report.
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken !== undefined ? { token: credentials.sessionToken } : {}),
    };
  }
}

/**
 * Builds a google-auth-library AuthClient that authenticates as
 * `serviceAccountEmail` by federating this ECS task's own AWS identity
 * through GCP's Security Token Service — no service-account key is ever
 * downloaded or stored (see bq-sink/setup-gcp.sh for the GCP-side trust
 * setup this depends on). Pass the result as `authClient` to
 * `new BigQuery({ projectId, authClient })`.
 *
 * Uses `AwsClient` directly rather than `ExternalAccountClient.fromJSON` —
 * the latter is, per its own type declarations in the installed version, a
 * dispatcher with no constructor of its own that can return `null`; since
 * AWS is known statically here, there's no reason to route through it.
 */
export function buildExternalAccountClient(
  workloadIdentityProvider: string,
  serviceAccountEmail: string,
  awsRegion: string
): AwsClient {
  return new AwsClient({
    audience: workloadIdentityProvider,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    aws_security_credentials_supplier: new EcsAwsSecurityCredentialsSupplier(awsRegion),
  });
}
