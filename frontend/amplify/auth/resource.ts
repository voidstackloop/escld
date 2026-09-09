import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineAuth, defineFunction } from '@aws-amplify/backend';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.join(__dirname, '..', '..', '..', 'aws', 'lambda');

/**
 * Both Cognito triggers below need to reach Postgres — a RDS instance CDK's
 * `infra/` app places in a PRIVATE_ISOLATED subnet (see
 * `infra/lib/database-stack.ts`), meaning the *default* (non-VPC) Lambda
 * execution environment Amplify's plain `defineFunction({...})` form
 * provisions has no network path to it at all: every invocation would just
 * time out on `client.connect()` (confirmed against a real run of this
 * exact failure mode before this fix — see the fix's own commit message).
 * `defineFunction`'s declarative `FunctionProps` has no `vpc` option (real,
 * verified in the installed `@aws-amplify/backend-function` types, not
 * assumed), so both triggers use its other form instead — a provider
 * callback that builds the underlying CDK function directly, which *does*
 * support real VPC attachment.
 *
 * `infra/` and this Amplify app are two separate, independently-deployed
 * CDK apps with no cross-stack construct reference between them, so the
 * VPC/subnet/security-group ids below come in as environment variables set
 * on whatever actually runs `ampx pipeline-deploy` in production (from
 * `infra/lib/database-stack.ts`'s own `VpcIdForAuthLambdas`/
 * `PrivateIsolatedSubnetIdsForAuthLambdas`/`AuthLambdaSecurityGroupId`
 * CfnOutputs, printed after deploying that stack) — the same
 * cross-app-literal-value pattern `infra/bin/infra.ts` already uses for
 * this app's own Cognito ids, in the opposite direction.
 *
 * Deliberately **absent, not a placeholder string, when unset** — local
 * `ampx sandbox` development never has a real VPC to attach to (and doesn't
 * need one: local dev already points at a plain docker-compose Postgres
 * reachable without any VPC at all, see `docs/LOCAL_DEVELOPMENT.md`), so
 * this must synth cleanly with zero VPC configuration when these env vars
 * aren't set, not fail trying to resolve a fake placeholder id.
 */
const authLambdaVpcId = process.env.AUTH_LAMBDA_VPC_ID;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const authLambdaSubnetIds = process.env.AUTH_LAMBDA_SUBNET_IDS?.split(',').filter(Boolean) ?? [];
const authLambdaSecurityGroupId = process.env.AUTH_LAMBDA_SECURITY_GROUP_ID;
/** `infra/lib/database-stack.ts`'s `DbSecretArn` output — the RDS-generated,
 * auto-rotating Secrets Manager secret. Also absent-by-default; see
 * `aws/lambda/shared/db.mjs`'s `resolveDbConfig` for the local-testing
 * fallback (`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) this
 * takes instead when unset. */
const dbSecretArn = process.env.DB_SECRET_ARN;

/**
 * Builds one Cognito trigger Lambda from a plain `.mjs` handler in
 * `aws/lambda/<name>/index.mjs`, real-VPC-attached to reach Postgres when
 * `authLambdaVpcId` is configured, and — the actual point of using
 * `NodejsFunction` here instead of Amplify's own bundler — bundled via a
 * real Docker-run `npm install` from that directory's own `package.json`
 * (`forceDockerBundling`), so nothing needs a `node_modules` tree committed
 * to the repo (this project's established convention everywhere else, e.g.
 * `infra/lib/siem-export-stack.ts`'s identical `NodejsFunction` use — this
 * lambda used to be the one inconsistent exception).
 */
function buildTriggerFunction(scope: Construct, id: string, lambdaDirName: string): lambda.IFunction {
  const vpc = authLambdaVpcId
    ? ec2.Vpc.fromLookup(scope, `${id}Vpc`, { vpcId: authLambdaVpcId })
    : undefined;

  const fn = new nodejs.NodejsFunction(scope, id, {
    entry: path.join(LAMBDA_ROOT, lambdaDirName, 'index.mjs'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: cdk.Duration.seconds(10),
    bundling: {
      forceDockerBundling: true,
      // pg's native TLS negotiation isn't relevant here (SSL is handled at
      // the connection-options level, not a native addon) and the AWS SDK
      // v3 clients ship with the Lambda Node runtime already — externalize
      // them so esbuild doesn't try to bundle a full client we don't need
      // duplicated, matching NodejsFunction's own documented default for
      // `@aws-sdk/*` (kept explicit here since this bundling block already
      // overrides other defaults).
      externalModules: ['@aws-sdk/*'],
    },
    environment: {
      DB_SECRET_ARN: dbSecretArn ?? '',
      DB_SSL: process.env.DB_SSL ?? 'true',
      // Local/sandbox fallback only — resolveDbConfig() ignores these the
      // moment DB_SECRET_ARN is set. Never real production credentials:
      // this app's local dev Postgres password is already a
      // publicly-known, non-secret default (see docker-compose.yaml).
      DB_HOST: process.env.DB_HOST ?? '',
      DB_PORT: process.env.DB_PORT ?? '5432',
      DB_NAME: process.env.DB_NAME ?? 'escld',
      DB_USER: process.env.DB_USER ?? '',
      DB_PASSWORD: process.env.DB_PASSWORD ?? '',
    },
    ...(vpc
      ? {
          vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, availabilityZones: undefined },
          securityGroups: authLambdaSecurityGroupId
            ? [ec2.SecurityGroup.fromSecurityGroupId(scope, `${id}SecurityGroup`, authLambdaSecurityGroupId)]
            : undefined,
        }
      : {}),
  });

  if (dbSecretArn) {
    secretsmanager.Secret.fromSecretCompleteArn(scope, `${id}DbSecret`, dbSecretArn).grantRead(fn);
  }

  return fn;
}

// Rejects a signup outright if `preferred_username` is already taken in
// Postgres — see aws/lambda/preSignUp/index.mjs's own doc comment for why
// this needs to exist at all (Cognito's own user pool enforces no such
// uniqueness on this attribute) and why it fails open on a DB outage.
const preSignUp = defineFunction((scope) => buildTriggerFunction(scope, 'PreSignUpFunction', 'preSignUp'), {
  resourceGroupName: 'auth',
});

// Provisions the Postgres `users` row once a signup is confirmed.
// See aws/lambda/postConfirmation/index.mjs and aws/README.md.
const postConfirmation = defineFunction(
  (scope) => buildTriggerFunction(scope, 'PostConfirmationFunction', 'postConfirmation'),
  { resourceGroupName: 'auth' },
);

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // RBAC tiers for the app: membership shows up as the "cognito:groups"
  // claim on both the ID and access tokens, so no separate roles table is
  // needed - the backend and ws-sfu map group name -> authority directly.
  groups: ['admin', 'moderator'],
  userAttributes: {
    preferredUsername: {
      mutable: true,
      required: true
    },
    profilePicture: {
      mutable: true,
      required: true
    }
  },
  triggers: {
    preSignUp,
    postConfirmation,
  },
});
