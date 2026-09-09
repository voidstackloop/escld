import * as cdk from 'aws-cdk-lib/core';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Wires an ECS Fargate task definition up for AWS X-Ray tracing + CloudWatch
 * Application Signals — shared between every service-stack file that needs
 * it (mirrors msk-iam-policy.ts's own "one helper, several call sites"
 * shape) rather than duplicating the sidecar/IAM/SSM wiring per stack.
 *
 * Deliberately built on the CloudWatch agent (`ecs-cwagent`) + ADOT
 * auto-instrumentation, NOT the older `aws-xray-sdk-java`/`aws-xray-sdk-
 * core` libraries — AWS's own X-Ray SDKs (all languages) entered
 * maintenance mode in Feb 2026, and current AWS guidance for both X-Ray
 * tracing and Application Signals is ADOT/OpenTelemetry auto-
 * instrumentation. One `ecs-cwagent` sidecar does both jobs (it receives
 * OTLP on :4316 for traces/metrics and exposes the X-Ray sampling endpoint
 * on :2000), which is why there's a single shared helper here rather than
 * separate "X-Ray" and "Application Signals" wiring.
 *
 * No CDK L2 construct exists for either the sidecar or Application Signals
 * at aws-cdk-lib@2.261.0 (confirmed by inspecting the installed
 * aws-applicationsignals/aws-xray module READMEs before writing this) —
 * everything here is raw ecs.ContainerDefinition/addContainer wiring.
 */

const CW_AGENT_CPU = 128;
const CW_AGENT_MEMORY_MIB = 256;

/**
 * Adds the shared `ecs-cwagent` sidecar (receives traces+metrics over OTLP,
 * exports to X-Ray + CloudWatch) and the IAM permissions both it and the
 * app container's own OTel auto-instrumentation need. Callers still need to
 * add the OTEL_* environment variables (see otelEnvVars below) to their own
 * app container, since those differ slightly per language/runtime.
 *
 * The 128 CPU / 256 MiB reservation is community/AWS-sample convention, not
 * an AWS-published guarantee (verified: not documented) — services already
 * near Fargate's minimum cpu/memory combo need a real bump to fit this, not
 * just an env var change (see analytics-service-stack.ts/bq-sink-service-
 * stack.ts, both bumped from 256/512 to 512/1024 for exactly this reason).
 */
export function addCloudWatchAgentSidecar(
  scope: cdk.Stack,
  taskDefinition: ecs.FargateTaskDefinition,
  serviceName: string,
): void {
  const configParam = new ssm.StringParameter(scope, 'OtelAgentConfig', {
    // Not scoped to the "AmazonCloudWatch-" prefix CloudWatchAgentServerPolicy's
    // own SSM grant assumes — this relies on the automatic execution-role
    // grant CDK adds via ecs.Secret.fromSsmParameter below, not on that
    // managed policy's own (narrower) SSM scoping. Flagged as unverified
    // without a real deploy in the plan this stack's own history documents.
    parameterName: `/escld/otel/cwagent-config-${serviceName}`,
    stringValue: JSON.stringify({
      traces: { traces_collected: { application_signals: {} } },
      logs: { metrics_collected: { application_signals: {} } },
    }),
  });

  const logGroup = new logs.LogGroup(scope, 'OtelAgentLogGroup', {
    logGroupName: `/escld/${serviceName}/otel-agent`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  taskDefinition.addContainer('ecs-cwagent', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest'),
    essential: true,
    cpu: CW_AGENT_CPU,
    memoryReservationMiB: CW_AGENT_MEMORY_MIB,
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel-agent', logGroup }),
    secrets: {
      CW_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(configParam),
    },
  });

  // CloudWatchAgentServerPolicy: lets the sidecar itself publish
  // metrics/logs. AWSXRayDaemonWriteAccess: verified this is a real, separate
  // gap — CloudWatchAgentServerPolicy does NOT include xray:PutTraceSegments/
  // PutTelemetryRecords, so tracing would silently fail to export without it.
  taskDefinition.taskRole.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
  );
  taskDefinition.taskRole.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
  );
}

/**
 * OTEL_* environment variables shared by every ADOT-auto-instrumented app
 * container (Java and Node alike) — points traces at the ecs-cwagent
 * sidecar's OTLP endpoint, enables Application Signals, and uses X-Ray's
 * own default reservoir sampler (1 req/sec guaranteed + 5% of the rest)
 * rather than 100% sampling. Deliberately not configurable per-service: at
 * this app's traffic (well below the 100k-DAU design-target peak — see
 * docs/SLOS.md's own note that none of that plan's numbers are load-tested
 * yet), 100% sampling would still be near-free, but hand-tuning per service
 * now would just be a "revisit later" TODO for no present benefit — X-Ray's
 * default sampler already scales gracefully from today's volume up to the
 * design-target peak without a redeploy.
 */
export function otelEnvVars(serviceName: string): Record<string, string> {
  return {
    OTEL_RESOURCE_ATTRIBUTES: `service.name=${serviceName}`,
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
    OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT: 'http://localhost:4316/v1/metrics',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4316/v1/traces',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_TRACES_SAMPLER: 'xray',
    OTEL_TRACES_SAMPLER_ARG: 'endpoint=http://localhost:2000',
    OTEL_PROPAGATORS: 'tracecontext,baggage,b3,xray',
  };
}

/**
 * Java's ADOT wiring, unlike Node's (see analytics-service-stack.ts), can't
 * be done via a NODE_OPTIONS-style env var alone — the javaagent .jar itself
 * has to physically land in the app container's filesystem first, which ECS
 * has no "copy a file into another container's image" primitive for. AWS's
 * own documented pattern (confirmed directly against the current
 * CloudWatch-Application-Signals-ECS-Sidecar doc, not assumed): a short-lived
 * `essential: false` init container, built from AWS's own ADOT-Java image,
 * whose only job is `cp /javaagent.jar` onto a volume both containers share;
 * the app container depends on it (`SUCCESS`) so it can't start racing an
 * empty mount, then loads the agent via `-javaagent:` in JAVA_TOOL_OPTIONS.
 *
 * `v2.30.0` verified as a real, currently-published tag against the public
 * ECR Gallery's own tag-list API (`public.ecr.aws/v2/.../tags/list`) before
 * pinning it here, not copied from a doc example — AWS's docs only ever
 * say "use the latest image" and state 1.32.2 as the *minimum*, not a tag to
 * literally use.
 */
const JAVA_ADOT_INIT_IMAGE = 'public.ecr.aws/aws-observability/adot-autoinstrumentation-java:v2.30.0';
const JAVA_ADOT_VOLUME_NAME = 'opentelemetry-auto-instrumentation';
const JAVA_ADOT_MOUNT_PATH = '/otel-auto-instrumentation';

/**
 * Wires the shared volume + init container + mount point ECS's Java ADOT
 * pattern needs. Callers still need to: call addCloudWatchAgentSidecar for
 * the ecs-cwagent sidecar + IAM (same as Node), merge
 * `-javaagent:/otel-auto-instrumentation/javaagent.jar` into the app
 * container's own JAVA_TOOL_OPTIONS (can't be set here — callers already
 * have their own JVM flags in that same env var, and env var *values* can't
 * be appended to after addContainer, only replaced), and add otelEnvVars()
 * to that same container's environment.
 */
export function addJavaAdotInitContainer(
  taskDefinition: ecs.FargateTaskDefinition,
  appContainer: ecs.ContainerDefinition,
): void {
  taskDefinition.addVolume({ name: JAVA_ADOT_VOLUME_NAME });

  const initContainer = taskDefinition.addContainer('otel-java-init', {
    image: ecs.ContainerImage.fromRegistry(JAVA_ADOT_INIT_IMAGE),
    essential: false,
    command: ['cp', '/javaagent.jar', `${JAVA_ADOT_MOUNT_PATH}/javaagent.jar`],
  });
  initContainer.addMountPoints({
    sourceVolume: JAVA_ADOT_VOLUME_NAME,
    containerPath: JAVA_ADOT_MOUNT_PATH,
    readOnly: false,
  });

  appContainer.addContainerDependencies({
    container: initContainer,
    condition: ecs.ContainerDependencyCondition.SUCCESS,
  });
  appContainer.addMountPoints({
    sourceVolume: JAVA_ADOT_VOLUME_NAME,
    containerPath: JAVA_ADOT_MOUNT_PATH,
    readOnly: false,
  });
}

/** The `-javaagent:` flag to append to an app container's own JAVA_TOOL_OPTIONS
 * (space-separated, like any other JVM flag) — a small helper so the flag
 * string/path only needs to be correct in one place. */
export const JAVA_ADOT_AGENT_FLAG = `-javaagent:${JAVA_ADOT_MOUNT_PATH}/javaagent.jar`;
