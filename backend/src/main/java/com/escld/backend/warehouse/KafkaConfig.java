package com.escld.backend.warehouse;

import java.time.Duration;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.ExecutionException;

import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.errors.TopicExistsException;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.kafka.KafkaClient;
import software.amazon.awssdk.services.kafka.model.GetBootstrapBrokersRequest;

import lombok.extern.slf4j.Slf4j;

/**
 * Wires the Kafka producer used by WarehouseOutboxRelay — MSK Serverless,
 * IAM-only auth (it offers no other mechanism). Entirely skipped when
 * app.kafka.enabled is false; committed outbox rows remain pending until a
 * deployment with Kafka enabled can relay them.
 *
 * Serverless clusters have no static bootstrap-broker CFN output; every
 * client resolves the current broker string at connect time via the
 * kafka:GetBootstrapBrokers control-plane API against the cluster ARN (see
 * EventStreamingStack) — bootstrapBrokerStringSaslIam() specifically, the
 * IAM-auth-flavored endpoint.
 */
@Slf4j
@Configuration
@EnableScheduling
@ConditionalOnProperty(prefix = "app.kafka", name = "enabled", havingValue = "true")
public class KafkaConfig {

    private static final int PARTITION_COUNT = 3;
    private static final short REPLICATION_FACTOR = 3;

    @Bean(destroyMethod = "close")
    KafkaProducer<String, String> warehouseKafkaProducer(
            @Value("${app.kafka.cluster-arn}") String clusterArn,
            @Value("${app.kafka.region}") String region,
            @Value("${app.kafka.local-bootstrap-servers:}") String localBootstrapServers) {
        boolean local = !localBootstrapServers.isBlank();
        String bootstrapBrokers = local ? localBootstrapServers : resolveBootstrapBrokers(clusterArn, region);

        Properties props = local ? plaintextProperties(bootstrapBrokers) : iamAuthProperties(bootstrapBrokers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        // The outbox relay owns the network call, so waiting for all in-sync
        // replicas no longer adds latency to a user request. Idempotence
        // protects producer retries; the stable application event id protects
        // retries after an ambiguous database/Kafka handoff.
        props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 5_000);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 30_000);

        ensureTopicsExist(bootstrapBrokers, local, warehouseTopics());

        return new KafkaProducer<>(props);
    }

    private List<String> warehouseTopics() {
        return List.of(
                WarehouseEventPublisher.TOPIC_POST_CREATED,
                WarehouseEventPublisher.TOPIC_POST_LIKED,
                WarehouseEventPublisher.TOPIC_POST_UNLIKED,
                WarehouseEventPublisher.TOPIC_POST_COMMENTED,
                WarehouseEventPublisher.TOPIC_POST_COMMENT_DELETED,
                WarehouseEventPublisher.TOPIC_POST_HIDDEN,
                WarehouseEventPublisher.TOPIC_POST_UNHIDDEN,
                WarehouseEventPublisher.TOPIC_USER_FOLLOWED,
                WarehouseEventPublisher.TOPIC_USER_UNFOLLOWED,
                WarehouseEventPublisher.TOPIC_LIVE_STARTED,
                WarehouseEventPublisher.TOPIC_LIVE_ENDED,
                WarehouseEventPublisher.TOPIC_POST_IMPRESSION,
                WarehouseEventPublisher.TOPIC_POST_DWELL,
                WarehouseEventPublisher.TOPIC_FEED_SERVED,
                WarehouseEventPublisher.TOPIC_MEDIA_PROGRESS);
    }

    private String resolveBootstrapBrokers(String clusterArn, String region) {
        try (KafkaClient client = KafkaClient.builder().region(Region.of(region)).build()) {
            return client.getBootstrapBrokers(GetBootstrapBrokersRequest.builder().clusterArn(clusterArn).build())
                    .bootstrapBrokerStringSaslIam();
        }
    }

    /** Idempotent — MSK Serverless has no auto.create.topics.enable, so
     * something has to create each topic before the first produce/consume.
     * Both this producer and bq-sink's consumer do this defensively rather
     * than relying on ordering between the two services' startup. One batch
     * call for the complete warehouse topic set rather than one
     * call per topic — on every restart after the first, every topic
     * already exists, so this is expected to hit the TopicExistsException
     * path (logged at debug) far more often than the create path. */
    private void ensureTopicsExist(String bootstrapBrokers, boolean local, List<String> topicNames) {
        Properties adminProps = local ? plaintextProperties(bootstrapBrokers) : iamAuthProperties(bootstrapBrokers);
        try (Admin admin = Admin.create(adminProps)) {
            List<NewTopic> newTopics = topicNames.stream()
                    .map(name -> new NewTopic(name, PARTITION_COUNT, REPLICATION_FACTOR))
                    .toList();
            admin.createTopics(newTopics).all().get(10, java.util.concurrent.TimeUnit.SECONDS);
            log.info("Created Kafka topics {}", topicNames);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof TopicExistsException) {
                log.debug("Kafka topics already exist: {}", topicNames);
            } else {
                log.warn("Failed to ensure Kafka topics exist: {}", topicNames, e);
            }
        } catch (Exception e) {
            log.warn("Failed to ensure Kafka topics exist: {}", topicNames, e);
        }
    }

    private Properties iamAuthProperties(String bootstrapBrokers) {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapBrokers);
        props.put("security.protocol", "SASL_SSL");
        props.put("sasl.mechanism", "AWS_MSK_IAM");
        props.put("sasl.jaas.config", "software.amazon.msk.auth.iam.IAMLoginModule required;");
        props.put("sasl.client.callback.handler.class", "software.amazon.msk.auth.iam.IAMClientCallbackHandler");
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, (int) Duration.ofSeconds(10).toMillis());
        return props;
    }

    /** Local-testing-only path (see {@code app.kafka.local-bootstrap-servers}'s
     * doc in application.yml) — a plain PLAINTEXT connection to a
     * docker-compose Kafka broker, no SASL/IAM at all. Never reachable in a
     * real environment, since {@code local-bootstrap-servers} is always
     * empty there. */
    private Properties plaintextProperties(String bootstrapBrokers) {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapBrokers);
        props.put("security.protocol", "PLAINTEXT");
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, (int) Duration.ofSeconds(10).toMillis());
        return props;
    }
}
