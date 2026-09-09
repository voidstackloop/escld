import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { CacheStack } from '../lib/cache-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const cache = new CacheStack(app, `TestCacheStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  return { compute, cache };
}

test('creates a single-node Redis cluster', () => {
  const app = new cdk.App();
  const { cache } = buildStack(app, '1');
  const template = Template.fromStack(cache);

  template.hasResourceProperties('AWS::ElastiCache::CacheCluster', {
    Engine: 'redis',
    CacheNodeType: 'cache.t4g.micro',
    NumCacheNodes: 1,
  });
});

test('grants the backend service security group inbound 6379', () => {
  const app = new cdk.App();
  const { cache } = buildStack(app, '2');
  const template = Template.fromStack(cache);

  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 6379,
    ToPort: 6379,
    SourceSecurityGroupId: Match.anyValue(),
  });
});
