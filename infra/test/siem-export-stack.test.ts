import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ModerationStack } from '../lib/moderation-stack';
import { SiemExportStack } from '../lib/siem-export-stack';

function buildStack(app: cdk.App, suffix: string) {
  const moderation = new ModerationStack(app, `TestModerationStack${suffix}`);
  const siemExport = new SiemExportStack(app, `TestSiemExportStack${suffix}`, {
    moderationTable: moderation.moderationTable,
  });
  return { moderation, siemExport };
}

test('the moderation table has DynamoDB Streams enabled with NEW_IMAGE', () => {
  const app = new cdk.App();
  const { moderation } = buildStack(app, '1');
  const template = Template.fromStack(moderation);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
  });
});

test('the export bucket is retained, encrypted, versioned, and never public', () => {
  const app = new cdk.App();
  const { siemExport } = buildStack(app, '2');
  const template = Template.fromStack(siemExport);

  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
        ]),
      }),
    }),
  });
});

test('the export function only triggers on INSERTs to MOD#-prefixed partition keys', () => {
  const app = new cdk.App();
  const { siemExport } = buildStack(app, '3');
  const template = Template.fromStack(siemExport);

  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    StartingPosition: 'TRIM_HORIZON',
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    FilterCriteria: {
      Filters: [
        {
          Pattern: Match.serializedJson({
            eventName: ['INSERT'],
            dynamodb: { Keys: { pk: { S: [{ prefix: 'MOD#' }] } } },
          }),
        },
      ],
    },
  });
});

test('grants the export function write access to the bucket, not read', () => {
  const app = new cdk.App();
  const { siemExport } = buildStack(app, '4');
  const template = Template.fromStack(siemExport);

  const policies = template.findResources('AWS::IAM::Policy');
  const allActions = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement.flatMap((s: any) => s.Action),
  );

  // grantWrite (not grantReadWrite) — includes PutObject* and the
  // DeleteObject*/Abort* actions S3 bundles into "write" for multipart-
  // upload cleanup and version management, but never GetObject/read.
  expect(allActions).toEqual(expect.arrayContaining(['s3:PutObject']));
  expect(allActions).not.toEqual(expect.arrayContaining(['s3:GetObject']));
});
