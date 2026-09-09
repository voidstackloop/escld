import { GetBootstrapBrokersCommand, KafkaClient as KafkaControlPlaneClient } from "@aws-sdk/client-kafka";
import { generateAuthToken } from "aws-msk-iam-sasl-signer-js";
import { Kafka, type Consumer } from "kafkajs";

import { logger } from "./logger.js";

const PARTITION_COUNT = 3;
const REPLICATION_FACTOR = 3;

/** MSK Serverless has no static bootstrap-broker CFN output — every client
 * resolves the current broker string at connect time via the
 * kafka:GetBootstrapBrokers control-plane API against the cluster ARN (see
 * EventStreamingStack). BootstrapBrokerStringSaslIam specifically, the
 * IAM-auth-flavored endpoint — matches WarehouseEventPublisher's Java side
 * of this exact lookup. */
async function resolveBootstrapBrokers(region: string, clusterArn: string): Promise<string[]> {
  const client = new KafkaControlPlaneClient({ region });
  const response = await client.send(new GetBootstrapBrokersCommand({ ClusterArn: clusterArn }));
  const brokers = response.BootstrapBrokerStringSaslIam;
  if (!brokers) {
    throw new Error("MSK GetBootstrapBrokers returned no SASL/IAM broker string");
  }
  return brokers.split(",");
}

/** Idempotent — MSK Serverless has no auto.create.topics.enable, so
 * something has to create each topic before the first produce/consume.
 * Both this consumer and the backend's WarehouseEventPublisher do this
 * defensively rather than relying on ordering between the two services'
 * startup. */
async function ensureTopicsExist(kafka: Kafka, topics: string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const missing = topics.filter((topic) => !existing.includes(topic));
    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((topic) => ({
          topic,
          numPartitions: PARTITION_COUNT,
          replicationFactor: REPLICATION_FACTOR,
        })),
      });
      logger.info("Created Kafka topics", { topics: missing });
    }
  } finally {
    await admin.disconnect();
  }
}

/**
 * `localBootstrapServers`, when set, is a local-testing-only escape hatch
 * (see `Config.kafkaLocalBootstrapServers`'s own doc) — takes priority over
 * `clusterArn`, connects PLAINTEXT directly to a docker-compose broker, and
 * skips the MSK `GetBootstrapBrokers` call and IAM/OAUTHBEARER auth
 * entirely. Never set in a real environment.
 */
export async function createConsumer(
  region: string,
  clusterArn: string | undefined,
  localBootstrapServers: string | undefined,
  groupId: string,
  topics: string[]
): Promise<Consumer> {
  const kafka = localBootstrapServers
    ? new Kafka({ clientId: "bq-sink", brokers: localBootstrapServers.split(","), ssl: false })
    : new Kafka({
        clientId: "bq-sink",
        brokers: await resolveBootstrapBrokers(region, clusterArn!),
        ssl: true,
        sasl: {
          mechanism: "oauthbearer",
          // Uses the AWS default credentials provider chain — the task's own
          // IAM role — no separate broker credential to manage.
          oauthBearerProvider: async () => {
            const { token } = await generateAuthToken({ region });
            return { value: token };
          },
        },
      });

  await ensureTopicsExist(kafka, topics);

  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });
  return consumer;
}
