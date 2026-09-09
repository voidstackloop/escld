import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { EventStreamingStack } from '../lib/event-streaming-stack';
import { BqSinkServiceStack } from '../lib/bq-sink-service-stack';
import { InsightsStack } from '../lib/insights-stack';

// No dedicated test file existed for this stack before — bq-sink-service-stack
// was only ever exercised indirectly via bin/infra.ts's full-app synth. Added
// alongside the X-Ray/Application Signals Phase 1 work below since that work
// needed real assertions on this stack's task definition, closing a real,
// pre-existing gap rather than adding untested code to an untested stack.
function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const eventStreaming = new EventStreamingStack(app, `TestEventStreamingStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');

  const bqSink = new BqSinkServiceStack(app, `TestBqSinkServiceStack${suffix}`, {
    vpc: network.vpc,
    cluster: compute.cluster,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    mskClusterArn: eventStreaming.cluster.attrArn,
    bigQueryProjectId: 'test-project',
    bigQueryDataset: 'escld_events_raw',
    gcpWorkloadIdentityProvider:
      '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws',
    alertsTopic,
  });

  return { bqSink };
}

test('has enough task-level headroom for the ecs-cwagent sidecar (bumped off Fargate\'s floor)', () => {
  const app = new cdk.App();
  const { bqSink } = buildStack(app, '1');
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
  });
});

test('runs the ecs-cwagent sidecar for X-Ray/Application Signals, configured via SSM', () => {
  const app = new cdk.App();
  const { bqSink } = buildStack(app, '2');
  const template = Template.fromStack(bqSink);

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
  const { bqSink } = buildStack(app, '3');
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'bq-sink',
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'KAFKA_TOPICS',
            Value: 'post.created,post.liked,post.unliked,post.commented,post.comment_deleted,post.hidden,post.unhidden,user.followed,user.unfollowed,live.started,live.ended,post.impression,post.dwell,feed.served,media.progress',
          }),
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
  const { bqSink } = buildStack(app, '4');
  const template = Template.fromStack(bqSink);

  const roles = template.findResources('AWS::IAM::Role');
  const allManagedArns = Object.values(roles).flatMap((r: any) =>
    (r.Properties.ManagedPolicyArns ?? []).map((arn: any) => JSON.stringify(arn)),
  );

  expect(allManagedArns.some((arn: string) => arn.includes('AWSXRayDaemonWriteAccess'))).toBe(true);
  expect(allManagedArns.some((arn: string) => arn.includes('CloudWatchAgentServerPolicy'))).toBe(true);
});

// Workload Identity Federation migration — the task role needs an explicit,
// stable name so bq-sink/setup-gcp.sh's GCP-side trust config can reference
// it independently of whether this stack has ever been deployed. See
// bq-sink-service-stack.ts's own doc comment for why this is a deliberate
// first for this codebase (every other stack lets CDK auto-name its roles).
test('gives the ECS task role an explicit, stable name for the GCP WIF trust relationship', () => {
  const app = new cdk.App();
  const { bqSink } = buildStack(app, '5');
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'escld-bq-sink-task-role',
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } }),
      ]),
    }),
  });
});

test('injects the WIF provider/service-account env vars and no service-account key/secret exists anywhere', () => {
  const app = new cdk.App();
  const { bqSink } = buildStack(app, '6');
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'bq-sink',
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'GCP_WORKLOAD_IDENTITY_PROVIDER',
            Value: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws',
          }),
          Match.objectLike({
            Name: 'GCP_SERVICE_ACCOUNT_EMAIL',
            Value: 'bq-sink@test-project.iam.gserviceaccount.com',
          }),
        ]),
      }),
    ]),
  });
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('derives the service-account email from bigQueryProjectId when gcpServiceAccountEmail is omitted, but an explicit value wins', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack7');
  const compute = new ComputeStack(app, 'TestComputeStack7', { vpc: network.vpc });
  const eventStreaming = new EventStreamingStack(app, 'TestEventStreamingStack7', {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const alertsStack = new cdk.Stack(app, 'TestAlertsStack7');
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');

  const bqSink = new BqSinkServiceStack(app, 'TestBqSinkServiceStack7', {
    vpc: network.vpc,
    cluster: compute.cluster,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    mskClusterArn: eventStreaming.cluster.attrArn,
    bigQueryProjectId: 'test-project',
    bigQueryDataset: 'escld_events_raw',
    gcpWorkloadIdentityProvider: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws',
    gcpServiceAccountEmail: 'explicit-override@another-project.iam.gserviceaccount.com',
    alertsTopic,
  });
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'bq-sink',
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'GCP_SERVICE_ACCOUNT_EMAIL',
            Value: 'explicit-override@another-project.iam.gserviceaccount.com',
          }),
        ]),
      }),
    ]),
  });
});

test('the insights export cron loop never starts when insightsTable is omitted', () => {
  const app = new cdk.App();
  const { bqSink } = buildStack(app, '8');
  const template = Template.fromStack(bqSink);

  const containers = template.findResources('AWS::ECS::TaskDefinition');
  const envVars = Object.values(containers).flatMap((td: any) =>
    td.Properties.ContainerDefinitions.flatMap((c: any) => c.Environment ?? []),
  );
  expect(envVars).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ Name: 'DYNAMODB_INSIGHTS_TABLE' })]),
  );
});

test('grants write-only DynamoDB access and threads the insights export config when insightsTable is provided', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack9');
  const compute = new ComputeStack(app, 'TestComputeStack9', { vpc: network.vpc });
  const eventStreaming = new EventStreamingStack(app, 'TestEventStreamingStack9', {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const alertsStack = new cdk.Stack(app, 'TestAlertsStack9');
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const insights = new InsightsStack(app, 'TestInsightsStack9');

  const bqSink = new BqSinkServiceStack(app, 'TestBqSinkServiceStack9', {
    vpc: network.vpc,
    cluster: compute.cluster,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    mskClusterArn: eventStreaming.cluster.attrArn,
    bigQueryProjectId: 'test-project',
    bigQueryDataset: 'escld_events_raw',
    gcpWorkloadIdentityProvider: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws',
    alertsTopic,
    insightsTable: insights.insightsTable,
  });
  const template = Template.fromStack(bqSink);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'bq-sink',
        Environment: Match.arrayWith([
          Match.objectLike({ Name: 'DYNAMODB_INSIGHTS_TABLE' }),
          Match.objectLike({ Name: 'INSIGHTS_EXPORT_INTERVAL_MS', Value: '3600000' }),
        ]),
      }),
    ]),
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );
  expect(allActions).toEqual(expect.arrayContaining(['dynamodb:PutItem']));
});
