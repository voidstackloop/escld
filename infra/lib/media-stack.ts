import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface MediaStackProps extends cdk.StackProps {
  /** Origins allowed to PUT/GET directly against the bucket (browser presigned uploads). */
  allowedOrigins?: string[];
}

export class MediaStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  /** Exposed so another stack can add its own cache behavior against this
   * same bucket/distribution (see RtmpServiceStack's live-manifest
   * behavior) without provisioning a second, redundant Origin Access
   * Control for the same bucket — reusing this one is what
   * `S3BucketOrigin.withOriginAccessControl`'s own `originAccessControl`
   * prop exists for. */
  public readonly originAccessControl: cloudfront.S3OriginAccessControl;

  constructor(scope: Construct, id: string, props?: MediaStackProps) {
    super(scope, id, props);

    // Dev default: any origin can PUT/GET directly against the bucket. Tighten this
    // to your real frontend origin(s) before production via the allowedOrigins prop.
    const allowedOrigins = props?.allowedOrigins ?? ['*'];

    // Private bucket — nothing is reachable directly from S3. CloudFront (below) is
    // the only public read path; writes happen via backend-issued presigned PUT URLs.
    this.bucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to RETAIN
      // (and drop autoDeleteObjects) before this holds real user data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Created explicitly (rather than letting withOriginAccessControl below
    // create one implicitly) purely so it can be exposed as a public
    // property — see this field's own doc comment.
    this.originAccessControl = new cloudfront.S3OriginAccessControl(this, 'MediaOriginAccessControl');

    const bucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessControl: this.originAccessControl,
    });

    this.distribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      comment: 'escld user media (avatars, covers, post images/video, live-stream HLS output)',
      defaultBehavior: {
        origin: bucketOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // Live-streaming HLS manifest — RtmpServiceStack writes live output
    // (manifest + fMP4 segments) under `live/<streamKey>/` in this same
    // bucket rather than a new one (see LiveStreamService's own doc for why
    // "reuse over parallel infra" is this feature's established call).
    // Registered here, in MediaStack, rather than from RtmpServiceStack:
    // `addBehavior` mutates this Distribution's own CloudFormation resource,
    // and RtmpServiceStack already depends on this stack for the bucket/OAC/
    // domain — adding the behavior from the other direction would create a
    // cross-stack dependency cycle. A short TTL applies to the manifest
    // alone, since a live playlist mutates every few seconds and the default
    // behavior's CACHING_OPTIMIZED policy above (correct for immutable post
    // media) would otherwise leave viewers stuck on a stale playlist.
    // Segments are immutable once written, so they correctly fall through to
    // the default behavior above with no special-casing needed.
    //
    // TTL pushed to CloudFront's practical floor (minTtl=0, so a client can
    // get a fresh copy on every request rather than being held to a fixed
    // window) as part of squeezing latency as low as achievable while
    // keeping this same S3+CloudFront delivery path — this is the one lever
    // left on the CDN side once real LL-HLS partial segments turned out to
    // be unavailable: confirmed directly against a real `ffmpeg -h
    // muxer=hls` run that mainline ffmpeg's `hls` muxer has no
    // `EXT-X-PART`/partial-segment support at all (see rtmp/src/hls.rs's
    // own doc comment) — there is no separate partial-segment path pattern
    // to add a matching cache behavior for, only the manifest and the
    // already-immutable full segments exist.
    this.distribution.addBehavior('live/*/live.m3u8', bucketOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: new cloudfront.CachePolicy(this, 'LiveManifestCachePolicy', {
        comment: 'Floor TTL for the live HLS manifest only — segments use the distribution default',
        defaultTtl: cdk.Duration.seconds(1),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(1),
      }),
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for user-uploaded media',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront domain to read media through (use as the public base URL)',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
    });
  }
}
