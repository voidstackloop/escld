#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BqSinkServiceStack } from '../lib/bq-sink-service-stack';
import { EventStreamingStack } from '../lib/event-streaming-stack';
import { MediaStack } from '../lib/media-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { SocialGraphStack } from '../lib/social-graph-stack';
import { TranscodeStack } from '../lib/transcode-stack';
import { FeedStack } from '../lib/feed-stack';
import { PostEventsStack } from '../lib/post-events-stack';
import { ConversationsStack } from '../lib/conversations-stack';
import { ModerationStack } from '../lib/moderation-stack';
import { SiemExportStack } from '../lib/siem-export-stack';
import { LikesStack } from '../lib/likes-stack';
import { PostHidesStack } from '../lib/post-hides-stack';
import { DomainOutboxStack } from '../lib/domain-outbox-stack';
import { InsightsStack } from '../lib/insights-stack';
import { NetworkStack } from '../lib/network-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ComputeStack } from '../lib/compute-stack';
import { CacheStack } from '../lib/cache-stack';
import { BackendServiceStack } from '../lib/backend-service-stack';
import { AnalyticsServiceStack } from '../lib/analytics-service-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { TranscodeWorkerServiceStack } from '../lib/transcode-worker-service-stack';
import { FeedWorkerServiceStack } from '../lib/feed-worker-service-stack';
import { SearchStack } from '../lib/search-stack';
import { WsSfuStack } from '../lib/ws-sfu-stack';
import { RecordingsStack } from '../lib/recordings-stack';
import { RtmpServiceStack } from '../lib/rtmp-service-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

// Phase 1 of the 100k-DAU scaling plan: the compute/networking foundation
// that was entirely missing before (every other stack in this file is a
// DynamoDB table or SQS queue — nowhere for the app itself to actually run).
const networkStack = new NetworkStack(app, 'EscldNetworkStack', {
  env,
  description: 'VPC housing the ECS cluster, RDS instance, and future ElastiCache/OpenSearch',
});

// ComputeStack goes before Database/Cache: it owns the backend Fargate
// service's security group (see ComputeStack's comment on that field for
// why creating it there, instead of in DatabaseStack/CacheStack/
// BackendServiceStack, is what avoids a cyclic stack dependency).
const computeStack = new ComputeStack(app, 'EscldComputeStack', {
  env,
  description: 'ECS Fargate cluster + ALB — Phase 2 adds the backend/worker services on top of this',
  vpc: networkStack.vpc,
});

// `-c dbMultiAz=false` drops to single-AZ for a throwaway test deploy (half the
// RDS cost, and only needs capacity in one AZ). Anything other than the literal
// string 'false' keeps the production Multi-AZ default.
const dbMultiAz = app.node.tryGetContext('dbMultiAz') !== 'false';
const databaseStack = new DatabaseStack(app, 'EscldDatabaseStack', {
  env,
  description: `RDS Postgres (${dbMultiAz ? 'Multi-AZ' : 'single-AZ'}) for users/posts/comments`,
  vpc: networkStack.vpc,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  multiAz: dbMultiAz,
});

// Pulled forward from Phase 4 — the backend can't boot without it (see
// CacheStack's own comment for why).
const cacheStack = new CacheStack(app, 'EscldCacheStack', {
  env,
  description: 'Redis for distributed rate limiting and the analytics pub/sub channel',
  vpc: networkStack.vpc,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
});

const mediaStack = new MediaStack(app, 'EscldMediaStack', {
  env,
  description: 'S3 bucket + CloudFront distribution for escld user-uploaded images and videos',
});

new FrontendStack(app, 'EscldFrontendStack', {
  env,
  description: 'S3 + CloudFront static hosting for the built frontend SPA',
});

const socialGraphStack = new SocialGraphStack(app, 'EscldSocialGraphStack', {
  env,
  description: 'DynamoDB table backing the follows/followers social graph',
});

// Phase 0 of the telemetry plan — the single shared destination every
// CloudWatch Alarm in this app points at, starting with the two DLQ-depth
// alarms below. Created early since TranscodeStack/PostEventsStack depend
// on its topic.
const monitoringStack = new MonitoringStack(app, 'EscldMonitoringStack', {
  env,
  description: 'Shared SNS alerts topic every CloudWatch Alarm notifies — see MonitoringStack',
  dbInstance: databaseStack.instance,
  redisCluster: cacheStack.cluster,
  alertsEmail: app.node.tryGetContext('alertsEmail'),
  slackWorkspaceId: app.node.tryGetContext('slackWorkspaceId'),
  slackChannelId: app.node.tryGetContext('slackChannelId'),
});

const transcodeStack = new TranscodeStack(app, 'EscldTranscodeStack', {
  env,
  description: 'SQS queue + DLQ for the ffmpeg transcode worker',
  alertsTopic: monitoringStack.alertsTopic,
});

const feedStack = new FeedStack(app, 'EscldFeedStack', {
  env,
  description: 'DynamoDB table backing the fan-out-on-write posts feed',
});

const postEventsStack = new PostEventsStack(app, 'EscldPostEventsStack', {
  env,
  description: 'SQS queue + DLQ for the feed worker (embedding + indexing + fan-out)',
  alertsTopic: monitoringStack.alertsTopic,
});

const conversationsStack = new ConversationsStack(app, 'EscldConversationsStack', {
  env,
  description: 'DynamoDB table backing ws-sfu messaging (conversations, messages, inbox fan-out)',
});

const moderationStack = new ModerationStack(app, 'EscldModerationStack', {
  env,
  description: 'DynamoDB table backing reports and the moderator audit log',
});

new SiemExportStack(app, 'EscldSiemExportStack', {
  env,
  description: 'Exports the moderation audit trail to S3 for downstream SIEM ingestion',
  moderationTable: moderationStack.moderationTable,
});

const likesStack = new LikesStack(app, 'EscldLikesStack', {
  env,
  description: 'DynamoDB table backing post likes',
});

const postHidesStack = new PostHidesStack(app, 'EscldPostHidesStack', {
  env,
  description: 'DynamoDB table backing per-viewer post hide/not-interested decisions',
});

const domainOutboxStack = new DomainOutboxStack(app, 'EscldDomainOutboxStack', {
  env,
  description: 'Transactional outbox for DynamoDB-backed relationship and feed events',
});

const insightsStack = new InsightsStack(app, 'EscldInsightsStack', {
  env,
  description: 'Materialized per-post and per-creator daily insights (Creator Studio) — see InsightsStack',
});

new SearchStack(app, 'EscldSearchStack', {
  env,
  description: 'Self-hosted Elasticsearch (not managed OpenSearch — see SearchStack for why) as an ECS Fargate service, EFS-backed',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  alertsTopic: monitoringStack.alertsTopic,
});

// Phase 0 of the Kafka/BigQuery analytics plan — MSK Serverless, IAM-only
// auth. Created before BackendServiceStack (the producer) and
// BqSinkServiceStack (the consumer/bridge to BigQuery) since both need its
// cluster ARN.
const eventStreamingStack = new EventStreamingStack(app, 'EscldEventStreamingStack', {
  env,
  description: 'MSK Serverless — the Kafka backbone for the warehouse/analytics event pipeline (see EventStreamingStack)',
  vpc: networkStack.vpc,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
});

// Phase 2: the first real workload on top of Phase 1's cluster/ALB/RDS.
// Cloud Map service names are deterministic strings, not CDK tokens, so this
// doesn't need a cross-stack reference to SearchStack — see the cluster's
// defaultCloudMapNamespace in ComputeStack and SearchStack's cloudMapOptions.
const elasticsearchUri = 'http://elasticsearch.escld.local:9200';
const corsAllowedOrigins = app.node.tryGetContext('corsAllowedOrigins') ?? 'http://localhost:5173';

new BackendServiceStack(app, 'EscldBackendServiceStack', {
  env,
  description: 'The Spring Boot API as an ECS Fargate service behind the shared ALB',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  httpListener: computeStack.httpListener,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  dbInstance: databaseStack.instance,
  dbSecret: databaseStack.instance.secret!,
  redisCluster: cacheStack.cluster,
  followsTable: socialGraphStack.followsTable,
  feedTable: feedStack.feedTable,
  conversationsTable: conversationsStack.conversationsTable,
  moderationTable: moderationStack.moderationTable,
  likesTable: likesStack.likesTable,
  postHidesTable: postHidesStack.hidesTable,
  domainOutboxTable: domainOutboxStack.outboxTable,
  insightsTable: insightsStack.insightsTable,
  transcodeQueue: transcodeStack.transcodeQueue,
  postEventsQueue: postEventsStack.postEventsQueue,
  mediaBucket: mediaStack.bucket,
  mediaCloudFrontDomain: mediaStack.distribution.distributionDomainName,
  elasticsearchUri,
  corsAllowedOrigins,
  cognitoIssuerUri: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_ESOikZUZv',
  cognitoAppClientId: '38h4lsvt0ujkjv2qoc9dobj8hv',
  alertsTopic: monitoringStack.alertsTopic,
  mskClusterArn: eventStreamingStack.cluster.attrArn,
});

new AnalyticsServiceStack(app, 'EscldAnalyticsServiceStack', {
  env,
  description: 'Trending posts/hashtags API (reads the Redis pub/sub analytics channel) as an ECS Fargate service',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  httpListener: computeStack.httpListener,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  redisCluster: cacheStack.cluster,
  corsAllowedOrigins,
  alertsTopic: monitoringStack.alertsTopic,
});

// Same EC2-not-Fargate reasoning as WsSfuStack above, applied to the RTMP
// live-streaming ingest server (see RtmpServiceStack) — a genuinely
// separate instance, not folded into WsSfuStack, since it's an unrelated
// protocol/codebase (Rust, but a different crate) with its own port and
// its own much smaller resource footprint.
new RtmpServiceStack(app, 'EscldRtmpServiceStack', {
  env,
  description: 'Live-streaming RTMP ingest server (EC2, not Fargate — see RtmpServiceStack)',
  vpc: networkStack.vpc,
  httpListener: computeStack.httpListener,
  albSecurityGroup: computeStack.albSecurityGroup,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  dbInstance: databaseStack.instance,
  dbSecret: databaseStack.instance.secret!,
  mediaBucket: mediaStack.bucket,
  mediaCloudFrontDomain: mediaStack.distribution.distributionDomainName,
  redisCluster: cacheStack.cluster,
  mskClusterArn: eventStreamingStack.cluster.attrArn,
  alertsTopic: monitoringStack.alertsTopic,
});

new TranscodeWorkerServiceStack(app, 'EscldTranscodeWorkerServiceStack', {
  env,
  description: 'ffmpeg transcode worker (SQS-driven) as an ECS Fargate service',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  dbInstance: databaseStack.instance,
  dbSecret: databaseStack.instance.secret!,
  transcodeQueue: transcodeStack.transcodeQueue,
  mediaBucket: mediaStack.bucket,
  mediaCloudFrontDomain: mediaStack.distribution.distributionDomainName,
  alertsTopic: monitoringStack.alertsTopic,
});

new FeedWorkerServiceStack(app, 'EscldFeedWorkerServiceStack', {
  env,
  description: 'Post-created event consumer (embed + index + fan-out) as an ECS Fargate service',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  postEventsQueue: postEventsStack.postEventsQueue,
  followsTable: socialGraphStack.followsTable,
  feedTable: feedStack.feedTable,
  elasticsearchUri,
  alertsTopic: monitoringStack.alertsTopic,
});

const recordingsStack = new RecordingsStack(app, 'EscldRecordingsStack', {
  env,
  description: 'Private S3 bucket for call recordings — no CloudFront, no public read path (see RecordingsStack)',
});

// ADR-002's "Option A" made real — see WsSfuStack for why this is EC2, not
// another Fargate service.
new WsSfuStack(app, 'EscldWsSfuStack', {
  env,
  description: 'WebSocket signaling + mediasoup WebRTC SFU (EC2, not Fargate — see WsSfuStack)',
  vpc: networkStack.vpc,
  httpListener: computeStack.httpListener,
  albSecurityGroup: computeStack.albSecurityGroup,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  dbInstance: databaseStack.instance,
  dbSecret: databaseStack.instance.secret!,
  conversationsTable: conversationsStack.conversationsTable,
  recordingsBucket: recordingsStack.bucket,
  followsTable: socialGraphStack.followsTable,
  mskClusterArn: eventStreamingStack.cluster.attrArn,
  cognitoIssuerUri: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_ESOikZUZv',
  cognitoAppClientId: '38h4lsvt0ujkjv2qoc9dobj8hv',
  corsAllowedOrigins,
  alertsTopic: monitoringStack.alertsTopic,
});

// The AWS->GCP bridge — see BqSinkServiceStack for why this is a small
// purpose-built consumer rather than MSK Connect. bigQueryProjectId/Dataset
// and gcpWorkloadIdentityProvider have no sensible default (there's no GCP
// project or WIF trust this repo can assume) — pass them via
// `-c bigQueryProjectId=... -c bigQueryDataset=... -c gcpWorkloadIdentityProvider=...`
// (the last one is bq-sink/setup-gcp.sh's final printed output); until then
// this deploys fine but bq-sink's own config.ts fails fast at container
// startup with a clear "missing required env var" rather than silently
// writing to the wrong project. No service-account key/secret is ever
// involved — bq-sink authenticates via Workload Identity Federation using
// the ECS task role's own identity (see gcp-auth.ts).
new BqSinkServiceStack(app, 'EscldBqSinkServiceStack', {
  env,
  description: 'Kafka -> BigQuery streaming bridge (see BqSinkServiceStack)',
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  appServiceSecurityGroup: computeStack.appServiceSecurityGroup,
  mskClusterArn: eventStreamingStack.cluster.attrArn,
  bigQueryProjectId: app.node.tryGetContext('bigQueryProjectId') ?? '',
  bigQueryDataset: app.node.tryGetContext('bigQueryDataset') ?? 'escld_events_raw',
  gcpWorkloadIdentityProvider: app.node.tryGetContext('gcpWorkloadIdentityProvider') ?? '',
  gcpServiceAccountEmail: app.node.tryGetContext('gcpServiceAccountEmail'),
  alertsTopic: monitoringStack.alertsTopic,
  insightsTable: insightsStack.insightsTable,
});
