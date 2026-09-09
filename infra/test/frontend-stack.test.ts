import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';

test('serves the SPA from a private S3 bucket behind CloudFront', () => {
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'TestFrontendStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: { DefaultRootObject: 'index.html' },
  });
});

test('rewrites 403/404 to index.html so client-side routing works on direct navigation', () => {
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'TestFrontendStack2');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      CustomErrorResponses: [
        { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' },
        { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' },
      ],
    },
  });
});
