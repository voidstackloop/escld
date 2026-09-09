import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 2 AZs is enough for Multi-AZ RDS + an ALB with 2+ targets; a 3rd AZ is easy
    // to add later by bumping maxAzs, nothing here depends on exactly 2.
    // 1 NAT gateway (not 1-per-AZ) trades a small availability gap for meaningfully
    // lower cost at this scale — revisit only if NAT throughput/AZ-failure becomes
    // a real problem.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'escld',
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          // ECS tasks: need outbound internet (pulling images, calling Cognito/S3)
          // but no inbound path from the internet — reached only via the ALB.
          name: 'private-egress',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          // RDS: no internet path at all, reachable only from inside the VPC.
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC housing the ECS cluster, RDS instance, and (later) ElastiCache/OpenSearch',
    });
  }
}
