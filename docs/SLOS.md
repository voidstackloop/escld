# Service Level Objectives

These SLOs are defined directly against the CloudWatch alarms and dashboard that already exist in `infra/lib/` (`backend-service-stack.ts`, `ws-sfu-stack.ts`, `monitoring-stack.ts`, `analytics-service-stack.ts`) — this doc is possible now specifically because that monitoring foundation is real, not aspirational (see the telemetry/logging plan). Every alarm referenced below already fires into the shared `escld-alerts` SNS topic (`MonitoringStack`), fanning out to Slack (via AWS Chatbot, once configured) and/or email.

## backend (the primary API)

| SLO | Target | Backing alarm/metric |
|---|---|---|
| Availability | ≥99.5% of 1-minute windows have ≥1 healthy ALB target | `ServiceDownAlarm` — `metricHealthyHostCount` < 1 |
| Error rate | 5xx rate stays under 5% over any 5-minute window | `HighErrorRateAlarm` — `errors / MAX(requests, 1)` > 0.05 |
| Latency | p99 response time stays under 2s over any 5-minute window | `HighP99LatencyAlarm` — ALB `metricTargetResponseTime` p99 > 2s |
| Capacity headroom | Container memory (JVM heap proxy) stays under 90% for any 10-minute window | `HighContainerMemoryAlarm` |
| Abuse/saturation | Rate-limit rejections stay under 5 req/s average over 5 minutes | `RateLimitSaturationAlarm` — `escld/backend` `rate_limit_rejections_total` |

## ws-sfu (real-time messaging + calling)

| SLO | Target | Backing alarm/metric |
|---|---|---|
| Availability | ≥99.5% of 1-minute windows have ≥1 healthy ALB target | `ServiceDownAlarm` |
| Auth abuse | Connection-rejection rate stays under 1 req/s average over 5 minutes | `AuthFailureSpikeAlarm` — `ws_sfu_auth_failures_total` |

No latency/error-rate SLO for ws-sfu's actual Socket.IO traffic yet — unlike the backend's ALB-fronted REST API, message/call-signaling latency isn't captured as an HTTP metric today. Revisit once `ws_sfu_messages_sent_total`/`ws_sfu_call_producers_total` (already on the dashboard) show enough volume to define a meaningful target against.

## analytics

| SLO | Target | Backing alarm/metric |
|---|---|---|
| Availability | ≥99.5% of 1-minute windows have ≥1 healthy ALB target | `ServiceDownAlarm` (`AnalyticsServiceStack`) |

## Background workers (`worker`, `feed-worker`) and `bq-sink`

No ALB, so no `ServiceDownAlarm` today (flagged as an explicit gap in the telemetry plan, not silently missing). Instead:

| SLO | Target | Backing signal |
|---|---|---|
| Transcode job success rate | ≥99% of jobs succeed (not final-attempt-failed) | `escld/worker` `worker_jobs_total{status}`, on the dashboard |
| Transcode job latency | p99 job duration stays reasonable for the current media mix | `worker_job_duration_seconds` (p99), on the dashboard — no fixed numeric target yet, watch for a step change |
| Feed fan-out success rate | ≥99% of post-created events succeed | `escld/feed-worker` `feed_worker_events_total{status}` |
| DLQ depth | Both DLQs (`transcode-jobs`, `post-events`) stay near zero | `DlqNotEmptyAlarm` in `transcode-stack.ts`/`post-events-stack.ts` (on `deadLetterQueue.metricApproximateNumberOfMessagesVisible()`) |
| bq-sink availability | ≥1 running task at all times | `ServiceDownAlarm` in `bq-sink-service-stack.ts` (`RunningTaskCount` on the ECS service, no ALB) |

`bq-sink`'s success/failure *rate* (not just up/down) is not yet on the shared dashboard or behind its own alarm — only up/down is covered today. Flagged here as a known gap, not fixed as part of this doc.

## Infrastructure (not app-level, but load-bearing for every SLO above)

| SLO | Target | Backing signal |
|---|---|---|
| Postgres availability | Failover events are alerted on immediately, not discovered later | `PostgresEventSubscription` (RDS `CfnEventSubscription`, `failure`/`availability`/`failover`/`recovery` categories) |
| Redis availability | Cluster/node failures are alerted on immediately | ElastiCache's native `notificationTopicArn`, wired directly to `escld-alerts` |

## What's deliberately not an SLO yet

Full request tracing (span-level latency breakdown across services) isn't captured — correlation-ID-based log correlation is today's answer to "trace one action end-to-end," not span timing. If any SLO above is repeatedly missed and the backing metric alone can't explain which hop is responsible, that's the trigger to build AWS X-Ray tracing (already scoped as a deferred item in the telemetry plan), not before.

These targets are initial and deliberately round — they exist to give the alarms already in place a stated purpose, not the output of a load test against real production traffic yet. Revisit the specific numbers once the Phase 4 load test (see the enterprise-hardening plan) produces real p50/p99 baselines to calibrate against.
