import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';
import { CacheStack } from '../lib/cache-stack';
import { EventStreamingStack } from '../lib/event-streaming-stack';
import { MediaStack } from '../lib/media-stack';
import { RtmpServiceStack } from '../lib/rtmp-service-stack';

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
  const eventStreaming = new EventStreamingStack(app, `TestEventStreamingStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  const media = new MediaStack(app, `TestMediaStack${suffix}`);
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');

  const rtmp = new RtmpServiceStack(app, `TestRtmpServiceStack${suffix}`, {
    vpc: network.vpc,
    httpListener: compute.httpListener,
    albSecurityGroup: compute.albSecurityGroup,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    dbInstance: database.instance,
    dbSecret: database.instance.secret!,
    mediaBucket: media.bucket,
    mediaCloudFrontDomain: media.distribution.distributionDomainName,
    redisCluster: cache.cluster,
    mskClusterArn: eventStreaming.cluster.attrArn,
    alertsTopic,
  });
  return { rtmp };
}

// UserData renders as Fn::Base64 over an Fn::Join of string fragments — same
// decoding approach as ws-sfu-stack.test.ts's identical helper.
function decodeUserData(template: Template): string {
  const instances = template.findResources('AWS::EC2::Instance');
  const instance = Object.values(instances)[0] as any;
  const joinParts: unknown[] = instance.Properties.UserData['Fn::Base64']['Fn::Join'][1];
  return joinParts.filter((part) => typeof part === 'string').join('');
}

test('opens RTMP (1935) to the internet, HTTP (4001) only to the ALB security group', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '1');
  const template = Template.fromStack(rtmp);

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ IpProtocol: 'tcp', FromPort: 1935, ToPort: 1935, CidrIp: '0.0.0.0/0' }),
    ]),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 4001,
    ToPort: 4001,
    SourceSecurityGroupId: Match.anyValue(),
  });
});

test('runs on a single EC2 instance with an associated Elastic IP', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '2');
  const template = Template.fromStack(rtmp);

  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.resourceCountIs('AWS::EC2::EIP', 1);
  template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
});

test('routes /hls/* on the shared ALB to the instance target group on port 4001', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '3');
  const template = Template.fromStack(rtmp);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 4001,
    TargetType: 'instance',
    HealthCheckPath: '/health',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 4,
    Conditions: Match.arrayWith([
      Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/hls/*'] } }),
    ]),
  });
});

test('grants the instance role ECR pull, DB secret read, and scoped S3 put for live HLS output', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '4');
  const template = Template.fromStack(rtmp);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  expect(allActions).toEqual(
    expect.arrayContaining(['ecr:BatchGetImage', 'secretsmanager:GetSecretValue', 's3:PutObject']),
  );
});

test('grants MSK producer access when mskClusterArn is configured', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '6');
  const template = Template.fromStack(rtmp);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  expect(allActions).toEqual(
    expect.arrayContaining(['kafka:GetBootstrapBrokers', 'kafka-cluster:Connect', 'kafka-cluster:WriteData']),
  );
});

test('threads the shared Redis endpoint into the instance docker run command', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '7');
  const template = Template.fromStack(rtmp);

  const userData = decodeUserData(template);
  expect(userData).toContain('-e REDIS_HOST=');
  expect(userData).toContain('-e REDIS_PORT=');
});

test('alarms on zero healthy ALB targets', () => {
  const app = new cdk.App();
  const { rtmp } = buildStack(app, '5');
  const template = Template.fromStack(rtmp);

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'rtmp has no healthy ALB targets',
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
  });
});
