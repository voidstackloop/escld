import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MediaStack } from '../lib/media-stack';
import { TranscodeStack } from '../lib/transcode-stack';
import { TranscodeWorkerServiceStack } from '../lib/transcode-worker-service-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const database = new DatabaseStack(app, `TestDatabaseStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const media = new MediaStack(app, `TestMediaStack${suffix}`);
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const transcode = new TranscodeStack(app, `TestTranscodeStack${suffix}`, { alertsTopic });

  const worker = new TranscodeWorkerServiceStack(app, `TestTranscodeWorkerServiceStack${suffix}`, {
    vpc: network.vpc,
    cluster: compute.cluster,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    dbInstance: database.instance,
    dbSecret: database.instance.secret!,
    transcodeQueue: transcode.transcodeQueue,
    mediaBucket: media.bucket,
    mediaCloudFrontDomain: media.distribution.distributionDomainName,
    alertsTopic,
  });
  return { worker };
}

test('runs as a queue-depth-autoscaled Fargate service with no ALB target group', () => {
  const app = new cdk.App();
  const { worker } = buildStack(app, '1');
  const template = Template.fromStack(worker);

  template.resourceCountIs('AWS::ECS::Service', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MinCapacity: 1,
    MaxCapacity: 6,
  });
});

test('alarms on zero running tasks via ECS Container Insights, not an ALB target group it does not have', () => {
  const app = new cdk.App();
  const { worker } = buildStack(app, '3');
  const template = Template.fromStack(worker);

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'ECS/ContainerInsights',
    MetricName: 'RunningTaskCount',
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
  });
});

test('grants the task role SQS consume and S3 read/write', () => {
  const app = new cdk.App();
  const { worker } = buildStack(app, '2');
  const template = Template.fromStack(worker);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  expect(allActions).toEqual(expect.arrayContaining(['sqs:ReceiveMessage', 's3:PutObject']));
});

test('runs the ecs-cwagent sidecar and loads ADOT via NODE_OPTIONS for X-Ray/Application Signals', () => {
  const app = new cdk.App();
  const { worker } = buildStack(app, '4');
  const template = Template.fromStack(worker);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'worker',
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'NODE_OPTIONS',
            Value: Match.stringLikeRegexp('aws-distro-opentelemetry-node-autoinstrumentation/register'),
          }),
          Match.objectLike({ Name: 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED', Value: 'true' }),
        ]),
      }),
      Match.objectLike({
        Name: 'ecs-cwagent',
        Secrets: Match.arrayWith([Match.objectLike({ Name: 'CW_CONFIG_CONTENT' })]),
      }),
    ]),
  });

  const roles = template.findResources('AWS::IAM::Role');
  const allManagedArns = Object.values(roles).flatMap((r: any) =>
    (r.Properties.ManagedPolicyArns ?? []).map((arn: any) => JSON.stringify(arn)),
  );
  expect(allManagedArns.some((arn: string) => arn.includes('AWSXRayDaemonWriteAccess'))).toBe(true);
  expect(allManagedArns.some((arn: string) => arn.includes('CloudWatchAgentServerPolicy'))).toBe(true);
});
