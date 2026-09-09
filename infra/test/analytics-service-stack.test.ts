import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { CacheStack } from '../lib/cache-stack';
import { AnalyticsServiceStack } from '../lib/analytics-service-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const cache = new CacheStack(app, `TestCacheStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const analytics = new AnalyticsServiceStack(app, `TestAnalyticsServiceStack${suffix}`, {
    vpc: network.vpc,
    cluster: compute.cluster,
    httpListener: compute.httpListener,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    redisCluster: cache.cluster,
    corsAllowedOrigins: 'https://app.example.com',
    alertsTopic,
  });
  return { analytics };
}

test('routes /api/v1/analytics/* ahead of the backend catch-all', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '1');
  const template = Template.fromStack(analytics);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 5,
    Conditions: Match.arrayWith([
      Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/v1/analytics/*'] } }),
    ]),
  });
});

test('runs on port 4100 with 2-4 task autoscaling', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '2');
  const template = Template.fromStack(analytics);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Port: 4100 });
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MinCapacity: 2,
    MaxCapacity: 4,
  });
});

test('has enough task-level cpu/memory headroom for the added ecs-cwagent sidecar', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '3');
  const template = Template.fromStack(analytics);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
  });
});

test('runs the ecs-cwagent sidecar for X-Ray/Application Signals, configured via SSM', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '4');
  const template = Template.fromStack(analytics);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'ecs-cwagent',
        Secrets: Match.arrayWith([Match.objectLike({ Name: 'CW_CONFIG_CONTENT' })]),
      }),
    ]),
  });
});

test('the app container loads ADOT via NODE_OPTIONS and points traces at the sidecar', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '5');
  const template = Template.fromStack(analytics);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'analytics',
        // Match.arrayWith's patterns must appear as an in-order subsequence —
        // listed here in the same relative order otelEnvVars()/the
        // container's environment object actually declares them, not
        // arbitrary order (a first draft of this test got this wrong and
        // failed against a perfectly correct stack).
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'NODE_OPTIONS',
            Value: Match.stringLikeRegexp('aws-distro-opentelemetry-node-autoinstrumentation/register'),
          }),
          Match.objectLike({ Name: 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED', Value: 'true' }),
          Match.objectLike({ Name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', Value: 'http://localhost:4316/v1/traces' }),
        ]),
      }),
    ]),
  });
});

test('grants the task role X-Ray write access and the CloudWatch agent policy', () => {
  const app = new cdk.App();
  const { analytics } = buildStack(app, '6');
  const template = Template.fromStack(analytics);

  // Not disambiguating task role vs. execution role by principal (both trust
  // ecs-tasks.amazonaws.com, indistinguishable that way) — otel-sidecar.ts
  // only ever attaches these two managed policies to the task role, so
  // finding them anywhere in this stack's roles is already a precise enough
  // signal that the right role got them.
  const roles = template.findResources('AWS::IAM::Role');
  const allManagedArns = Object.values(roles).flatMap((r: any) =>
    (r.Properties.ManagedPolicyArns ?? []).map((arn: any) => JSON.stringify(arn)),
  );

  expect(allManagedArns.some((arn: string) => arn.includes('AWSXRayDaemonWriteAccess'))).toBe(true);
  expect(allManagedArns.some((arn: string) => arn.includes('CloudWatchAgentServerPolicy'))).toBe(true);
});
