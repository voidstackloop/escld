import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

export interface EventStreamingStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** Backend + bq-sink Fargate tasks' shared security group (from
   * ComputeStack) — granted inbound 9098 (Kafka's TLS/SASL-IAM port) below. */
  appServiceSecurityGroup: ec2.ISecurityGroup;
}

/**
 * MSK Serverless, not Provisioned, not self-hosted — see the plan's §1 for
 * the full reasoning. The short version: current event volume (a few
 * thousand/day) is nowhere near a throughput problem, so this is Kafka for
 * its durable-pub/sub-plus-fan-out properties, not its throughput — and
 * Provisioned MSK has a fixed ~$300-450/mo standing broker cost regardless
 * of traffic, the same category of always-on capacity this repo has
 * consistently avoided elsewhere (RDS/ElastiCache/CloudWatch-native over
 * self-hosting, all citing "managed for a small team").
 *
 * IAM-only auth (Serverless doesn't offer SASL/SCRAM) — both the backend
 * producer and bq-sink consumer authenticate with their own task role via
 * the AWS MSK IAM SASL signer libraries, no separate secret to manage.
 *
 * Serverless has no static bootstrap-broker CFN output — clients call the
 * `kafka:GetBootstrapBrokers` API against this cluster's ARN at connect
 * time (both `WarehouseEventPublisher` and `bq-sink` do this; see their own
 * comments). `grantConnect`/`grantTopic`-style helpers don't exist yet on
 * this L1 construct, so IAM policy is hand-written on the two consuming
 * stacks' task roles (see BackendServiceStack, BqSinkServiceStack).
 */
export class EventStreamingStack extends cdk.Stack {
  public readonly cluster: msk.CfnServerlessCluster;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EventStreamingStackProps) {
    super(scope, id, props);

    this.securityGroup = new ec2.SecurityGroup(this, 'MskSecurityGroup', {
      vpc: props.vpc,
      description: 'escld MSK Serverless — Kafka (SASL/IAM, port 9098) from app services only',
      allowAllOutbound: false,
    });
    this.securityGroup.addIngressRule(
      props.appServiceSecurityGroup,
      ec2.Port.tcp(9098),
      'Backend producer / bq-sink consumer -> MSK',
    );

    this.cluster = new msk.CfnServerlessCluster(this, 'Cluster', {
      clusterName: 'escld-events',
      clientAuthentication: {
        sasl: { iam: { enabled: true } },
      },
      vpcConfigs: [
        {
          subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
          securityGroups: [this.securityGroup.securityGroupId],
        },
      ],
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.attrArn,
      description: 'Passed to producers/consumers as MSK_CLUSTER_ARN — used for the GetBootstrapBrokers call',
    });
  }
}
