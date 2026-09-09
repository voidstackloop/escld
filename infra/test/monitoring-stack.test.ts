import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';
import { CacheStack } from '../lib/cache-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

function buildStack(app: cdk.App, suffix: string, extraProps: Record<string, unknown> = {}) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const database = new DatabaseStack(app, `TestDatabaseStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const cache = new CacheStack(app, `TestCacheStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const monitoring = new MonitoringStack(app, `TestMonitoringStack${suffix}`, {
    dbInstance: database.instance,
    redisCluster: cache.cluster,
    ...extraProps,
  });
  return { monitoring, cache };
}

test('creates a single SNS alerts topic with no subscribers by default', () => {
  const app = new cdk.App();
  const { monitoring } = buildStack(app, '1');
  const template = Template.fromStack(monitoring);

  template.resourceCountIs('AWS::SNS::Topic', 1);
  template.resourceCountIs('AWS::SNS::Subscription', 0);
  template.resourceCountIs('AWS::Chatbot::SlackChannelConfiguration', 0);
});

test('subscribes an email address when alertsEmail is provided', () => {
  const app = new cdk.App();
  const { monitoring } = buildStack(app, '2', { alertsEmail: 'ops@example.com' });
  const template = Template.fromStack(monitoring);

  template.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'ops@example.com',
  });
});

test('creates a Slack channel configuration only when both Slack IDs are provided', () => {
  const app = new cdk.App();
  const { monitoring } = buildStack(app, '3', {
    slackWorkspaceId: 'T00000000',
    slackChannelId: 'C00000000',
  });
  const template = Template.fromStack(monitoring);

  template.hasResourceProperties('AWS::Chatbot::SlackChannelConfiguration', {
    SlackWorkspaceId: 'T00000000',
    SlackChannelId: 'C00000000',
  });
});

test('subscribes to RDS failure/availability/failover/recovery events', () => {
  const app = new cdk.App();
  const { monitoring } = buildStack(app, '4');
  const template = Template.fromStack(monitoring);

  template.hasResourceProperties('AWS::RDS::EventSubscription', {
    SourceType: 'db-instance',
    EventCategories: Match.arrayWith(['failure', 'availability', 'failover', 'recovery']),
  });
});

test('wires the Redis cluster to notify the alerts topic directly', () => {
  const app = new cdk.App();
  const { cache } = buildStack(app, '5');
  const cacheTemplate = Template.fromStack(cache);

  // Set from MonitoringStack (constructed after CacheStack) via a direct
  // property mutation on the shared CfnCacheCluster reference — verifying
  // it lands in CacheStack's own synthesized template, not just in-memory.
  cacheTemplate.hasResourceProperties('AWS::ElastiCache::CacheCluster', {
    NotificationTopicArn: Match.anyValue(),
  });
});
