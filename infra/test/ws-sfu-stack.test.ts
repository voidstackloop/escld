import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ConversationsStack } from '../lib/conversations-stack';
import { RecordingsStack } from '../lib/recordings-stack';
import { SocialGraphStack } from '../lib/social-graph-stack';
import { WsSfuStack } from '../lib/ws-sfu-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const database = new DatabaseStack(app, `TestDatabaseStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const conversations = new ConversationsStack(app, `TestConversationsStack${suffix}`);
  const recordings = new RecordingsStack(app, `TestRecordingsStack${suffix}`);
  const socialGraph = new SocialGraphStack(app, `TestSocialGraphStack${suffix}`);
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');

  const wsSfu = new WsSfuStack(app, `TestWsSfuStack${suffix}`, {
    vpc: network.vpc,
    httpListener: compute.httpListener,
    albSecurityGroup: compute.albSecurityGroup,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    dbInstance: database.instance,
    dbSecret: database.instance.secret!,
    conversationsTable: conversations.conversationsTable,
    recordingsBucket: recordings.bucket,
    followsTable: socialGraph.followsTable,
    mskClusterArn: 'arn:aws:kafka:eu-central-1:123456789012:cluster/test-cluster/abc-123',
    cognitoIssuerUri: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_test',
    cognitoAppClientId: 'test-client-id',
    corsAllowedOrigins: 'https://app.example.com',
    alertsTopic,
  });
  return { wsSfu };
}

test('opens the WebRTC media UDP range to the internet', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '1');
  const template = Template.fromStack(wsSfu);

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ IpProtocol: 'udp', FromPort: 40000, ToPort: 40999, CidrIp: '0.0.0.0/0' }),
    ]),
  });
});

test('opens signaling (4000) only to the ALB security group, not the internet', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '2b');
  const template = Template.fromStack(wsSfu);

  // SG-to-SG ingress rules synthesize as their own resource, not inlined
  // on the security group — same pattern as DatabaseStack/CacheStack.
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 4000,
    ToPort: 4000,
    SourceSecurityGroupId: Match.anyValue(),
  });
});

test('runs on a single EC2 instance with an associated Elastic IP', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '2');
  const template = Template.fromStack(wsSfu);

  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.resourceCountIs('AWS::EC2::EIP', 1);
  template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
});

test('routes /socket.io/* on the shared ALB to the instance target group', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '3');
  const template = Template.fromStack(wsSfu);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 4000,
    TargetType: 'instance',
    HealthCheckPath: '/health',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 3,
    Conditions: Match.arrayWith([
      Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/socket.io/*'] } }),
    ]),
  });
});

test('grants the instance role ECR pull, DB secret read, conversations table access, and recordings bucket writes', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '4');
  const template = Template.fromStack(wsSfu);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  expect(allActions).toEqual(
    expect.arrayContaining([
      'ecr:BatchGetImage',
      'secretsmanager:GetSecretValue',
      'dynamodb:GetItem',
      's3:PutObject',
    ]),
  );
  // Write-only: recordings are never read back through this role (see
  // RecordingsStack's class doc) - GetObject must not be among its actions.
  expect(allActions).not.toEqual(expect.arrayContaining(['s3:GetObject']));
});

test('grants the instance role MSK consumer access and read-only access to the follows table, and threads both env vars through', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '6');
  const template = Template.fromStack(wsSfu);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );
  // 'consumer' (not 'producer', unlike rtmp's own MSK grant) — the
  // group-access actions only grantMskClientAccess's consumer branch adds.
  expect(allActions).toEqual(expect.arrayContaining(['kafka-cluster:AlterGroup', 'kafka-cluster:DescribeGroup', 'dynamodb:Query']));

  const instances = template.findResources('AWS::EC2::Instance');
  const instance = Object.values(instances)[0] as any;
  const joinParts: unknown[] = instance.Properties.UserData['Fn::Base64']['Fn::Join'][1];
  const userDataText = joinParts.filter((part) => typeof part === 'string').join('');

  expect(userDataText).toContain('DYNAMODB_FOLLOWS_TABLE=');
  expect(userDataText).toContain('KAFKA_CLUSTER_ARN=arn:aws:kafka:eu-central-1:123456789012:cluster/test-cluster/abc-123');
});

test('runs a standalone ADOT Collector for X-Ray tracing, grants the instance role X-Ray write access', () => {
  const app = new cdk.App();
  const { wsSfu } = buildStack(app, '5');
  const template = Template.fromStack(wsSfu);

  const roles = template.findResources('AWS::IAM::Role');
  const allManagedArns = Object.values(roles).flatMap((r: any) =>
    (r.Properties.ManagedPolicyArns ?? []).map((arn: any) => JSON.stringify(arn)),
  );
  expect(allManagedArns.some((arn: string) => arn.includes('AWSXRayDaemonWriteAccess'))).toBe(true);

  // UserData renders as Fn::Base64 over an Fn::Join of string fragments —
  // flatten just the literal string parts (skipping embedded CFN intrinsics
  // like {Ref:...}) and search across the joined whole, since the
  // otel-collector docker run command and ws-sfu's own OTEL env vars each
  // span multiple fragments.
  const instances = template.findResources('AWS::EC2::Instance');
  const instance = Object.values(instances)[0] as any;
  const joinParts: unknown[] = instance.Properties.UserData['Fn::Base64']['Fn::Join'][1];
  const userDataText = joinParts.filter((part) => typeof part === 'string').join('');

  expect(userDataText).toContain('public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0');
  expect(userDataText).toContain('docker run -d --name otel-collector');
  expect(userDataText).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces');
});
