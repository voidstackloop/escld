import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/**
 * Static hosting for the built React SPA (frontend/dist) — S3 + CloudFront,
 * the same shape as MediaStack's bucket/distribution but for the app bundle
 * instead of user media. Completes Phase 3 of the 100k-DAU plan (media
 * hosting already existed via MediaStack; this was the missing half).
 *
 * `frontend/dist` must exist at synth time (`npm run build` in frontend/
 * first) — deliberately not bundled into the CDK asset build here, since
 * that would mean running `npm install && npm run build` inside a Docker
 * bundling step on every synth, which is slow and a poor fit for a build
 * step a real CI pipeline should own. Point wherever the frontend is built
 * (CI job, or manually) at running that build before `cdk deploy`.
 *
 * VITE_API_URL / VITE_ANALYTICS_URL (see frontend/src/lib/api.ts and
 * lib/analytics.ts) are baked in at build time, not runtime-configurable —
 * the real production build needs those set to the ALB's real domain before
 * `npm run build` runs. Not solved here; this stack only owns where the
 * already-built output is served from.
 */
export class FrontendStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Dev-friendly default so `cdk destroy` cleans up fully, matching
      // every other stack in this repo. Switch to RETAIN before this holds
      // a real production build history worth keeping.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'escld frontend SPA',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // Client-side routing (react-router): any path CloudFront/S3 doesn't
      // recognize as a real object (a deep link like /profile/someone) gets
      // rewritten to index.html instead of surfacing S3's 403/404, so the
      // SPA's own router — not S3 — decides what to render for that path.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset('../frontend/dist')],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'Public URL for the frontend SPA',
    });
  }
}
