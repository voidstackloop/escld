import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DatabaseStack } from '../lib/database-stack';

function buildStack(app: cdk.App, suffix: string) {
  const network = new NetworkStack(app, `TestNetworkStack${suffix}`);
  const compute = new ComputeStack(app, `TestComputeStack${suffix}`, { vpc: network.vpc });
  const database = new DatabaseStack(app, `TestDatabaseStack${suffix}`, {
    vpc: network.vpc,
    appServiceSecurityGroup: compute.appServiceSecurityGroup,
  });
  return { compute, database };
}

test('creates a Multi-AZ Postgres instance with generated credentials', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '1');
  const template = Template.fromStack(database);

  template.hasResourceProperties('AWS::RDS::DBInstance', {
    Engine: 'postgres',
    MultiAZ: true,
    DBName: 'escld',
  });
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
});

test('exposes a security group that the backend service can be granted access from', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '2');

  expect(database.dbSecurityGroup).toBeDefined();
  expect(database.instance).toBeDefined();
});

test('places the instance in an isolated DB subnet group', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '3');
  const template = Template.fromStack(database);

  template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
});

test('grants the backend service security group inbound 5432 — owned here, not by BackendServiceStack, to avoid a cyclic stack dependency', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '4');
  const template = Template.fromStack(database);

  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
    SourceSecurityGroupId: Match.anyValue(),
  });
});

test('encrypts storage at rest', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '5');
  const template = Template.fromStack(database);

  template.hasResourceProperties('AWS::RDS::DBInstance', {
    StorageEncrypted: true,
  });
});

test('rotates the generated credentials on a schedule', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '6');
  const template = Template.fromStack(database);

  template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
  template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
    RotationRules: Match.objectLike({
      ScheduleExpression: 'rate(30 days)',
    }),
  });
});

test('grants a dedicated security group (for the out-of-app Amplify Cognito trigger Lambdas) inbound 5432, and exports what they need to reference it', () => {
  const app = new cdk.App();
  const { database } = buildStack(app, '7');
  const template = Template.fromStack(database);

  expect(database.authLambdaSecurityGroup).toBeDefined();

  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
    Description: 'Amplify Cognito trigger Lambdas -> Postgres',
  });

  const outputs = template.findOutputs('*');
  expect(Object.keys(outputs)).toEqual(
    expect.arrayContaining(['VpcIdForAuthLambdas', 'PrivateIsolatedSubnetIdsForAuthLambdas', 'AuthLambdaSecurityGroupId']),
  );
});
