import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Private storage for call recordings (see ws-sfu/src/sfu/recording.rs) —
 * deliberately a *separate* bucket from MediaStack's, not a prefix within
 * it. MediaStack's bucket is designed to be publicly readable through its
 * CloudFront distribution (avatars, post images/video); recordings must
 * never be reachable that way. This bucket has no CloudFront distribution
 * and no public read path at all — the only access is direct, IAM-authenticated
 * S3 API calls, granted to ws-sfu's instance role for writes (PutObject only,
 * see WsSfuStack) and to nobody for reads yet. Reading a recording back is a
 * deliberately deferred follow-up (an admin-only tool issuing presigned
 * GetObject URLs), not built here — this stack only has to guarantee
 * recordings are never end-user-reachable, which a private bucket with no
 * distribution and no public grants already does at the infrastructure level.
 */
export class RecordingsStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'RecordingsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to
      // RETAIN (and drop autoDeleteObjects) before this holds real recordings.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Private S3 bucket for call recordings — no public read path, admin/moderator access only',
    });
  }
}
