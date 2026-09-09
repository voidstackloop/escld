import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

export interface CacheStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** Backend Fargate tasks' security group (from ComputeStack) — granted inbound 6379 below. */
  appServiceSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Redis, pulled forward from Phase 4 of the 100k-DAU plan because the backend
 * hard-requires it at boot: RateLimitConfig's LettuceBasedProxyManager opens
 * a real connection during Spring context startup (not lazily), so the
 * backend Fargate service in Phase 2 cannot start without this existing.
 *
 * Single node for now (cache.t4g.micro, no replication group) — matches this
 * plan's "vertical/simple first, revisit once metrics justify more" approach
 * applied elsewhere (see ws-sfu in the plan). Both of Redis's current jobs —
 * distributed rate limiting and the analytics pub/sub channel — are already
 * explicitly designed to tolerate a connection blip (analytics events are
 * documented fire-and-forget; a rate-limit check failing open under a brief
 * Redis restart is an acceptable trade at this scale). Upgrade to a
 * Multi-AZ replication group only if that trade stops being acceptable.
 */
export class CacheStack extends cdk.Stack {
  public readonly cluster: elasticache.CfnCacheCluster;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id, props);

    this.securityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: props.vpc,
      description: 'escld Redis',
      allowAllOutbound: false,
    });
    this.securityGroup.addIngressRule(
      props.appServiceSecurityGroup,
      ec2.Port.tcp(6379),
      'Backend Fargate tasks -> Redis',
    );

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Isolated subnets — Redis has no route to the internet and needs none',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    this.cluster = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [this.securityGroup.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.cluster.attrRedisEndpointAddress,
      description: 'Set as SPRING_DATA_REDIS_HOST for the backend',
    });

    new cdk.CfnOutput(this, 'RedisPort', {
      value: this.cluster.attrRedisEndpointPort,
    });
  }
}
