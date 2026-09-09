import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';
import { CacheStack } from '../lib/cache-stack';
import { MediaStack } from '../lib/media-stack';
import { SocialGraphStack } from '../lib/social-graph-stack';
import { FeedStack } from '../lib/feed-stack';
import { ConversationsStack } from '../lib/conversations-stack';
import { ModerationStack } from '../lib/moderation-stack';
import { LikesStack } from '../lib/likes-stack';
import { PostHidesStack } from '../lib/post-hides-stack';
import { DomainOutboxStack } from '../lib/domain-outbox-stack';
import { InsightsStack } from '../lib/insights-stack';
import { TranscodeStack } from '../lib/transcode-stack';
import { PostEventsStack } from '../lib/post-events-stack';
import { BackendServiceStack } from '../lib/backend-service-stack';

function buildStack(app: cdk.App, suffix: string) {
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
  const media = new MediaStack(app, `TestMediaStack${suffix}`);
  const socialGraph = new SocialGraphStack(app, `TestSocialGraphStack${suffix}`);
  const feed = new FeedStack(app, `TestFeedStack${suffix}`);
  const conversations = new ConversationsStack(app, `TestConversationsStack${suffix}`);
  const moderation = new ModerationStack(app, `TestModerationStack${suffix}`);
  const likes = new LikesStack(app, `TestLikesStack${suffix}`);
  const postHides = new PostHidesStack(app, `TestPostHidesStack${suffix}`);
  const domainOutbox = new DomainOutboxStack(app, `TestDomainOutboxStack${suffix}`);
  const insights = new InsightsStack(app, `TestInsightsStack${suffix}`);
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const transcode = new TranscodeStack(app, `TestTranscodeStack${suffix}`, { alertsTopic });
  const postEvents = new PostEventsStack(app, `TestPostEventsStack${suffix}`, { alertsTopic });

  const backend = new BackendServiceStack(app, `TestBackendServiceStack${suffix}`, {
    vpc: network.vpc,
    cluster: compute.cluster,
    httpListener: compute.httpListener,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    dbInstance: database.instance,
    dbSecret: database.instance.secret!,
    redisCluster: cache.cluster,
    followsTable: socialGraph.followsTable,
    feedTable: feed.feedTable,
    conversationsTable: conversations.conversationsTable,
    moderationTable: moderation.moderationTable,
    likesTable: likes.likesTable,
    postHidesTable: postHides.hidesTable,
    domainOutboxTable: domainOutbox.outboxTable,
    insightsTable: insights.insightsTable,
    transcodeQueue: transcode.transcodeQueue,
    postEventsQueue: postEvents.postEventsQueue,
    mediaBucket: media.bucket,
    mediaCloudFrontDomain: media.distribution.distributionDomainName,
    elasticsearchUri: 'http://es.test.internal:9200',
    corsAllowedOrigins: 'https://app.example.com',
    cognitoIssuerUri: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_test',
    cognitoAppClientId: 'test-client-id',
    alertsTopic,
  });

  return { backend };
}

test('runs the backend as a Fargate service with 2-8 task autoscaling', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '1');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MinCapacity: 2,
    MaxCapacity: 8,
  });
});

test('routes /api/* on the shared ALB listener to the backend target group', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '2');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: Match.arrayWith([
      Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }),
    ]),
  });
});

test('health-checks the actuator port, not the JWT-protected public API port', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '3');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 8080,
    HealthCheckPort: '9090',
    HealthCheckPath: '/actuator/health',
  });
});

test('grants the task role read/write on every DynamoDB table and send on both SQS queues', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '4');
  const template = Template.fromStack(backend);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  expect(allActions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'sqs:SendMessage']));
});

test('threads the insights table name through to the container environment', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '5');
  const template = Template.fromStack(backend);

  const containers = template.findResources('AWS::ECS::TaskDefinition');
  const envVars = Object.values(containers).flatMap((td: any) =>
    td.Properties.ContainerDefinitions.flatMap((c: any) => c.Environment ?? []),
  );
  expect(envVars).toEqual(
    expect.arrayContaining([expect.objectContaining({ Name: 'DYNAMODB_INSIGHTS_TABLE' })]),
  );
});

test('has enough task-level memory headroom for the ecs-cwagent sidecar + otel-java-init container', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '5');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '1024',
    Memory: '3072',
  });
});

test('runs the ecs-cwagent sidecar for X-Ray/Application Signals, configured via SSM', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '6');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'ecs-cwagent',
        Secrets: Match.arrayWith([Match.objectLike({ Name: 'CW_CONFIG_CONTENT' })]),
      }),
    ]),
  });
});

test('copies the ADOT Java agent onto a shared volume via a non-essential init container the app container depends on', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '7');
  const template = Template.fromStack(backend);

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: Match.arrayWith([Match.objectLike({ Name: 'opentelemetry-auto-instrumentation' })]),
    // Match.arrayWith's patterns must appear as an in-order subsequence —
    // the "backend" container is added before ecs-cwagent/otel-java-init in
    // the real array (see backend-service-stack.ts), not after, so this
    // list is ordered [backend, otel-java-init] to match — a first draft of
    // this test got this backwards and failed against a perfectly correct
    // stack (same class of bug analytics-service-stack.test.ts's own
    // comment already documents).
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'backend',
        DependsOn: Match.arrayWith([
          Match.objectLike({ ContainerName: 'otel-java-init', Condition: 'SUCCESS' }),
        ]),
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'JAVA_TOOL_OPTIONS',
            Value: Match.stringLikeRegexp('-javaagent:/otel-auto-instrumentation/javaagent\\.jar'),
          }),
          Match.objectLike({ Name: 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED', Value: 'true' }),
          Match.objectLike({ Name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', Value: 'http://localhost:4316/v1/traces' }),
        ]),
      }),
      Match.objectLike({
        Name: 'otel-java-init',
        Essential: false,
        Command: ['cp', '/javaagent.jar', '/otel-auto-instrumentation/javaagent.jar'],
      }),
    ]),
  });
});

test('grants the task role X-Ray write access and the CloudWatch agent policy', () => {
  const app = new cdk.App();
  const { backend } = buildStack(app, '8');
  const template = Template.fromStack(backend);

  // Same reasoning as analytics-service-stack.test.ts's equivalent test —
  // not disambiguating task role vs. execution role by principal, since both
  // trust ecs-tasks.amazonaws.com; otel-sidecar.ts only ever attaches these
  // to the task role, so finding them anywhere in this stack is precise enough.
  const roles = template.findResources('AWS::IAM::Role');
  const allManagedArns = Object.values(roles).flatMap((r: any) =>
    (r.Properties.ManagedPolicyArns ?? []).map((arn: any) => JSON.stringify(arn)),
  );

  expect(allManagedArns.some((arn: string) => arn.includes('AWSXRayDaemonWriteAccess'))).toBe(true);
  expect(allManagedArns.some((arn: string) => arn.includes('CloudWatchAgentServerPolicy'))).toBe(true);
});
