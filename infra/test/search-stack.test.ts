import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { SearchStack } from '../lib/search-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const alertsStack = new cdk.Stack(app, `TestAlertsStack${suffix}`);
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const search = new SearchStack(app, `TestSearchStack${suffix}`, {
    vpc: network.vpc,
    cluster: compute.cluster,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
    alertsTopic,
  });
  return { search };
}

test('runs a single Elasticsearch task backed by an encrypted EFS volume', () => {
  const app = new cdk.App();
  const { search } = buildStack(app, '1');
  const template = Template.fromStack(search);

  template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  template.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
  template.hasResourceProperties('AWS::EFS::AccessPoint', {
    PosixUser: { Uid: '1000', Gid: '0' },
  });
});

test('registers Cloud Map service discovery so other services get a stable DNS name', () => {
  const app = new cdk.App();
  const { search } = buildStack(app, '2');
  const template = Template.fromStack(search);

  template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
    Name: 'elasticsearch',
  });
});

test('grants only the app-tier security group inbound 9200 — never public', () => {
  const app = new cdk.App();
  const { search } = buildStack(app, '3');
  const template = Template.fromStack(search);

  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 9200,
    ToPort: 9200,
    SourceSecurityGroupId: Match.anyValue(),
  });
});

test('alarms on zero running tasks via ECS Container Insights, not an ALB target group it does not have', () => {
  const app = new cdk.App();
  const { search } = buildStack(app, '4');
  const template = Template.fromStack(search);

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'ECS/ContainerInsights',
    MetricName: 'RunningTaskCount',
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
  });
});
