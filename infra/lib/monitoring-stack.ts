import * as cdk from 'aws-cdk-lib/core';
import * as applicationsignals from 'aws-cdk-lib/aws-applicationsignals';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  dbInstance: rds.IDatabaseInstance;
  redisCluster: elasticache.CfnCacheCluster;

  /**
   * Email address to subscribe to the alerts topic as the AWS-native side of
   * delivery (CloudWatch Alarms are also visible in the console with no
   * subscription at all — this is the push notification, not the only
   * record). Optional so this stack can deploy before an address is chosen;
   * add it later via a redeploy.
   */
  alertsEmail?: string;

  /**
   * Both required together to wire Slack delivery via AWS Chatbot. Chatbot
   * itself requires a one-time Slack-workspace authorization done by a
   * workspace admin in the AWS Chatbot console (not CDK-manageable) — these
   * two IDs are what that authorization produces; pass them via CDK context
   * (`-c slackWorkspaceId=... -c slackChannelId=...`) once you have them.
   * Left unset, this stack still deploys everything else — alarms remain
   * visible in the CloudWatch console and (if `alertsEmail` is set) by email.
   */
  slackWorkspaceId?: string;
  slackChannelId?: string;
}

/**
 * The single shared destination every CloudWatch Alarm in this app points
 * at, plus the two infra-level alarm-equivalents that don't belong inside
 * any single service stack (Postgres/Redis reachability) and a dashboard
 * covering the phase-2 EMF metrics. Every other service's own alarms
 * (ServiceDown/HighErrorRate/etc.) live inside that service's own stack,
 * taking `alertsTopic` as a prop — matching the DLQ-alarm pattern already
 * established in TranscodeStack/PostEventsStack, and avoiding a circular
 * dependency this stack would otherwise have on every service stack.
 */
export class MonitoringStack extends cdk.Stack {
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'escld-alerts',
      displayName: 'escld production alerts',
    });

    if (props.alertsEmail) {
      this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(props.alertsEmail));
    }

    if (props.slackWorkspaceId && props.slackChannelId) {
      new chatbot.SlackChannelConfiguration(this, 'SlackChannel', {
        slackChannelConfigurationName: 'escld-alerts',
        slackWorkspaceId: props.slackWorkspaceId,
        slackChannelId: props.slackChannelId,
        notificationTopics: [this.alertsTopic],
      });
    }

    // PostgresDown-equivalent: RDS event subscriptions are the native
    // mechanism for "tell me when this instance fails/fails over" — more
    // direct than guessing a metric threshold, and doesn't need Postgres's
    // own exporter (removed from production once metrics went AWS-native,
    // see docs/BACKGROUND_SERVICES.md's telemetry notes).
    new rds.CfnEventSubscription(this, 'PostgresEventSubscription', {
      snsTopicArn: this.alertsTopic.topicArn,
      sourceType: 'db-instance',
      sourceIds: [props.dbInstance.instanceIdentifier],
      eventCategories: ['failure', 'availability', 'failover', 'recovery'],
    });

    // RedisDown-equivalent: ElastiCache can publish cluster/node events
    // (including failures) directly to an SNS topic with no CloudWatch
    // Alarm or exporter involved at all — set post-construction since
    // CacheStack (which owns this cluster) is built before this stack; CDK
    // resolves the cross-stack topic-ARN reference at synth time regardless
    // of which stack's code sets the property.
    props.redisCluster.notificationTopicArn = this.alertsTopic.topicArn;

    // One-time, account/region-level enablement of CloudWatch Application
    // Signals (creates AWSServiceRoleForCloudWatchApplicationSignals) — the
    // declarative CDK equivalent of the one-time console click AWS's own
    // docs describe. This resource has no dependents and does nothing on
    // its own; OtelSidecar (see otel-sidecar.ts) is what actually gets each
    // service's traces/metrics flowing once this account-level switch is on.
    new applicationsignals.CfnDiscovery(this, 'ApplicationSignalsDiscovery');

    this.buildDashboard();

    new cdk.CfnOutput(this, 'AlertsTopicArn', {
      value: this.alertsTopic.topicArn,
      description: 'Every CloudWatch Alarm in this app notifies this topic',
    });
  }

  private buildDashboard(): void {
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'escld-overview',
    });

    const emfMetric = (namespace: string, metricName: string, dimensionsMap?: Record<string, string>) =>
      new cloudwatch.Metric({ namespace, metricName, dimensionsMap, statistic: 'Sum', period: cdk.Duration.minutes(5) });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Posts created / moderation actions / follow requests',
        left: [
          emfMetric('escld/backend', 'posts_created_total'),
          emfMetric('escld/backend', 'moderation_actions_total'),
          emfMetric('escld/backend', 'follow_requests_total'),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS enqueue results (success vs failure — a failure here means a post is stuck)',
        left: [
          emfMetric('escld/backend', 'transcode_jobs_enqueue_total', { result: 'failure' }),
          emfMetric('escld/backend', 'post_events_enqueue_total', { result: 'failure' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Rate limit rejections (429s)',
        left: [emfMetric('escld/backend', 'rate_limit_rejections_total')],
      }),
      new cloudwatch.GraphWidget({
        title: 'Trending-score lookups in feed ranking (success vs failure)',
        left: [
          emfMetric('escld/backend', 'trending_score_lookup_total', { result: 'success' }),
          emfMetric('escld/backend', 'trending_score_lookup_total', { result: 'failure' }),
        ],
      }),
    );

    // Frontend RUM (Core Web Vitals) — relayed through the backend's
    // ClientMetricController, not a separate namespace (see that class's
    // doc comment for why: no dedicated RUM SaaS, self-hosted like frontend
    // error reporting). p75 is the standard Web Vitals aggregation
    // percentile (Google's own "good"/"poor" thresholds are defined against
    // it), not average/sum like the counters above.
    const rumMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'escld/backend',
        metricName,
        statistic: 'p75',
        period: cdk.Duration.minutes(5),
      });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Frontend Core Web Vitals — p75 (LCP/INP/TTFB in ms)',
        left: [rumMetric('web_vital_lcp'), rumMetric('web_vital_inp'), rumMetric('web_vital_ttfb')],
      }),
      new cloudwatch.GraphWidget({
        title: 'Frontend Core Web Vitals — p75 (CLS, unitless score)',
        left: [rumMetric('web_vital_cls')],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Transcode worker jobs (total + duration)',
        left: [emfMetric('escld/worker', 'worker_jobs_total')],
        right: [
          new cloudwatch.Metric({
            namespace: 'escld/worker',
            metricName: 'worker_job_duration_seconds',
            statistic: 'p99',
            period: cdk.Duration.minutes(5),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Feed worker events (total + duration)',
        left: [emfMetric('escld/feed-worker', 'feed_worker_events_total')],
        right: [
          new cloudwatch.Metric({
            namespace: 'escld/feed-worker',
            metricName: 'feed_worker_event_duration_seconds',
            statistic: 'p99',
            period: cdk.Duration.minutes(5),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Analytics events processed / Redis connectivity',
        left: [emfMetric('escld/analytics', 'analytics_events_processed_total')],
        right: [
          new cloudwatch.Metric({
            namespace: 'escld/analytics',
            metricName: 'analytics_redis_connected',
            statistic: 'Minimum',
            period: cdk.Duration.minutes(5),
          }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ws-sfu: sockets connected / rooms active',
        left: [
          new cloudwatch.Metric({
            namespace: 'escld/ws-sfu',
            metricName: 'ws_sfu_sockets_connected',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'escld/ws-sfu',
            metricName: 'ws_sfu_call_rooms_active',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(5),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'ws-sfu: messages sent / call producers / auth failures',
        left: [
          emfMetric('escld/ws-sfu', 'ws_sfu_messages_sent_total'),
          emfMetric('escld/ws-sfu', 'ws_sfu_call_producers_total'),
          emfMetric('escld/ws-sfu', 'ws_sfu_auth_failures_total'),
        ],
      }),
    );
  }
}
