import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** Backend Fargate tasks' security group (from ComputeStack) — granted inbound 5432 below. */
  appServiceSecurityGroup: ec2.ISecurityGroup;
  /** Defaults to true (the production posture: automatic failover, see the
   * instance's own comment). Set false only for a throwaway test deploy —
   * Multi-AZ needs RDS capacity in two AZs simultaneously and costs roughly
   * double, and a real `insufficient-capacity` failure in eu-central-1 is
   * what made this configurable. Wired to the `dbMultiAz` CDK context flag. */
  multiAz?: boolean;
}

export class DatabaseStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  /** Granted ingress to Postgres below — for Lambdas that live outside this
   * CDK app entirely (Amplify Gen 2's Cognito triggers, see
   * frontend/amplify/auth/resource.ts) and so can't reference
   * appServiceSecurityGroup directly. Its id (and the outputs below) are
   * pasted as literal placeholder values into that file, matching this
   * repo's existing convention for cross-app values with no clean CDK
   * cross-stack mechanism (see aws/bin/infra.ts's hardcoded Cognito ids,
   * the inverse direction of the same problem). */
  public readonly authLambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: props.vpc,
      description: 'escld RDS Postgres',
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(
      props.appServiceSecurityGroup,
      ec2.Port.tcp(5432),
      'Backend Fargate tasks to Postgres',
    );

    this.authLambdaSecurityGroup = new ec2.SecurityGroup(this, 'AuthLambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'escld Amplify Cognito trigger Lambdas (postConfirmation, preSignUp) - VPC-attached so they can reach Postgres, a PRIVATE_ISOLATED-subnet instance no default (non-VPC) Lambda execution environment can route to at all',
      allowAllOutbound: true,
    });
    this.dbSecurityGroup.addIngressRule(
      this.authLambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Amplify Cognito trigger Lambdas to Postgres',
    );

    // users/posts/comments — the relational, admin-queryable data the moderation
    // console and ad hoc queries need (see ENTERPRISE_ARCHITECTURE plan: everything
    // with a fixed access pattern already lives in DynamoDB single-table stores
    // instead — follows/feed/conversations/moderation/likes).
    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      // Right-sized for the ~350-450 req/s peak / ~5-8 backend replicas estimated
      // for 100k DAU (see plan) — a connection ceiling of a few hundred comfortably
      // covers 4-8 replicas x a Hikari pool of 10. Bump before adding a read replica.
      //
      // T3 (Intel), not T4G (Graviton): a real `insufficient-capacity` failure on
      // db.t4g.medium in eu-central-1 blocked this stack's first deploy. Graviton
      // RDS pools in this region run tight; T3 draws from a separate, broader pool
      // for the same class size and near-identical price. Revisit T4G (~10-20%
      // cheaper) once capacity there is reliable.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageType: rds.StorageType.GP3,
      // Multi-AZ for automatic failover, not for read scaling — the load
      // estimate doesn't justify a read replica on day one (see plan's
      // "what to revisit" section). Defaults on; see props.multiAz.
      multiAz: props.multiAz ?? true,
      databaseName: 'escld',
      credentials: rds.Credentials.fromGeneratedSecret('escld_app'),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      // No real user data yet, so turning this on is a safe destroy+recreate
      // on next deploy rather than a snapshot-restore migration (confirmed
      // with the user before enabling it — see the enterprise-hardening plan).
      storageEncrypted: true,
      // Dev-friendly default so `cdk destroy` cleans up fully, matching every
      // other stack in this repo. Switch to RETAIN/SNAPSHOT before this holds
      // real user data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Rotates the generated credentials on a schedule via a CDK-managed
    // Secrets Manager Lambda — no custom rotation code to write or operate.
    this.instance.addRotationSingleUser({
      automaticallyAfter: cdk.Duration.days(30),
    });

    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: this.instance.dbInstanceEndpointAddress,
      description: 'RDS Postgres endpoint — set as DB_HOST for the backend and ws-sfu',
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.instance.secret!.secretArn,
      description: 'Secrets Manager secret holding the generated DB credentials (username/password/host/port) — also what the Amplify Cognito trigger Lambdas read at runtime, see frontend/amplify/auth/resource.ts',
    });

    // Everything frontend/amplify/auth/resource.ts's postConfirmation/
    // preSignUp Lambdas need to paste in as their own hardcoded placeholder
    // values (that file has no CDK cross-stack reference into this app).
    new cdk.CfnOutput(this, 'VpcIdForAuthLambdas', {
      value: props.vpc.vpcId,
      description: 'VPC id — paste into frontend/amplify/auth/resource.ts\'s AUTH_LAMBDA_VPC_ID placeholder',
    });
    new cdk.CfnOutput(this, 'PrivateIsolatedSubnetIdsForAuthLambdas', {
      value: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds.join(','),
      description: 'Comma-separated private-isolated subnet ids (same subnets Postgres itself lives in) — paste into AUTH_LAMBDA_SUBNET_IDS',
    });
    new cdk.CfnOutput(this, 'AuthLambdaSecurityGroupId', {
      value: this.authLambdaSecurityGroup.securityGroupId,
      description: 'Paste into AUTH_LAMBDA_SECURITY_GROUP_ID',
    });
  }
}
