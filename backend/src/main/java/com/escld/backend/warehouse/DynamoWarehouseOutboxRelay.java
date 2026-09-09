package com.escld.backend.warehouse;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.escld.backend.metrics.EmfMetrics;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.ReturnValue;

/** Relays DynamoDB transactional-outbox events to Kafka with leases and stable IDs. */
@Slf4j
@Component
@ConditionalOnProperty(prefix = "app.kafka", name = "enabled", havingValue = "true")
public class DynamoWarehouseOutboxRelay {

    private static final String CORRELATION_ID_HEADER = "correlationId";

    private final DynamoDbClient dynamo;
    private final KafkaProducer<String, String> producer;
    private final ObjectMapper objectMapper;
    private final EmfMetrics metrics;
    private final String tableName;
    private final int batchSize;
    private final Duration lease;
    private final Duration sendTimeout;
    private final Duration sentRetention;
    private final String workerId = UUID.randomUUID().toString();
    private final AtomicInteger nextShard = new AtomicInteger();

    public DynamoWarehouseOutboxRelay(DynamoDbClient dynamo, KafkaProducer<String, String> producer,
            ObjectMapper objectMapper, EmfMetrics metrics,
            @Value("${app.dynamodb.domain-outbox-table-name}") String tableName,
            @Value("${app.warehouse.dynamodb-outbox.batch-size:25}") int batchSize,
            @Value("${app.warehouse.dynamodb-outbox.lease:60s}") Duration lease,
            @Value("${app.warehouse.outbox.send-timeout:10s}") Duration sendTimeout,
            @Value("${app.warehouse.outbox.sent-retention:7d}") Duration sentRetention) {
        this.dynamo = dynamo;
        this.producer = producer;
        this.objectMapper = objectMapper;
        this.metrics = metrics;
        this.tableName = tableName;
        this.batchSize = Math.max(1, Math.min(batchSize, 100));
        this.lease = lease;
        this.sendTimeout = sendTimeout;
        this.sentRetention = sentRetention;
    }

    @Scheduled(fixedDelayString = "${app.warehouse.dynamodb-outbox.poll-delay:250ms}")
    public void relayBatch() {
        int shard = Math.floorMod(nextShard.getAndIncrement(), DynamoWarehouseOutbox.SHARD_COUNT);
        String now = Instant.now().toString();
        Map<String, AttributeValue> startKey = null;
        // Drain the due backlog in this shard (paginated) so a burst of >25
        // events does not wait multiple 4s round-robin cycles. Bounded to 4
        // pages per tick to keep relay latency predictable.
        for (int page = 0; page < 4; page++) {
            var query = QueryRequest.builder()
                    .tableName(tableName)
                    .indexName(DynamoWarehouseOutbox.PENDING_INDEX)
                    .keyConditionExpression("pendingShard = :shard AND availableAt <= :now")
                    .expressionAttributeValues(Map.of(
                            ":shard", AttributeValue.fromS("PENDING#" + String.format("%02d", shard)),
                            ":now", AttributeValue.fromS(now)))
                    .scanIndexForward(true)
                    .limit(batchSize);
            if (startKey != null) query.exclusiveStartKey(startKey);
            var response = dynamo.query(query.build());
            for (Map<String, AttributeValue> candidate : response.items()) {
                Map<String, AttributeValue> claimed = claim(candidate.get("pk").s());
                if (claimed != null) {
                    publish(claimed);
                }
            }
            if (!response.hasLastEvaluatedKey()) break;
            startKey = response.lastEvaluatedKey();
            if (response.items().isEmpty()) break;
        }
    }

    private Map<String, AttributeValue> claim(String pk) {
        long now = Instant.now().getEpochSecond();
        try {
            return dynamo.updateItem(builder -> builder.tableName(tableName)
                    .key(Map.of("pk", AttributeValue.fromS(pk)))
                    .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(claimedUntil) OR claimedUntil < :now)")
                    .updateExpression("SET claimedBy = :worker, claimedUntil = :until, attempts = if_not_exists(attempts, :zero) + :one")
                    .expressionAttributeValues(Map.of(
                            ":worker", AttributeValue.fromS(workerId),
                            ":now", AttributeValue.fromN(Long.toString(now)),
                            ":until", AttributeValue.fromN(Long.toString(now + lease.toSeconds())),
                            ":zero", AttributeValue.fromN("0"),
                            ":one", AttributeValue.fromN("1")))
                    .returnValues(ReturnValue.ALL_NEW)).attributes();
        } catch (ConditionalCheckFailedException lostRace) {
            return null;
        }
    }

    private void publish(Map<String, AttributeValue> item) {
        String pk = item.get("pk").s();
        String eventId = item.get("eventId").s();
        String eventType = item.get("eventType").s();
        try {
            ObjectNode envelope = objectMapper.createObjectNode();
            envelope.put("eventId", eventId);
            envelope.put("eventType", eventType);
            envelope.put("eventVersion", item.get("eventVersion").s());
            envelope.put("occurredAt", item.get("occurredAt").s());
            envelope.put("ingestedAt", Instant.now().toString());
            envelope.put("producer", item.get("producer").s());
            putNullable(envelope, item, "actorId");
            putNullable(envelope, item, "entityType");
            putNullable(envelope, item, "entityId");
            putNullable(envelope, item, "correlationId");
            putNullable(envelope, item, "sessionId");
            putNullable(envelope, item, "requestId");
            putNullable(envelope, item, "experimentId");
            putNullable(envelope, item, "experimentVariant");
            if (item.containsKey("entityVersion")) envelope.put("entityVersion", Long.parseLong(item.get("entityVersion").n()));
            else envelope.putNull("entityVersion");
            envelope.set("payload", objectMapper.readTree(item.get("payload").s()));

            ProducerRecord<String, String> record = new ProducerRecord<>(eventType, item.get("partitionKey").s(),
                    objectMapper.writeValueAsString(envelope));
            if (item.containsKey("correlationId")) {
                record.headers().add(new RecordHeader(CORRELATION_ID_HEADER,
                        item.get("correlationId").s().getBytes(StandardCharsets.UTF_8)));
            }
            producer.send(record).get(sendTimeout.toMillis(), TimeUnit.MILLISECONDS);
            markSent(pk);
            metrics.increment("dynamodb_warehouse_outbox_publish_total", Map.of("result", "success", "eventType", eventType));
        } catch (Exception e) {
            int attempts = Integer.parseInt(item.get("attempts").n());
            markFailed(pk, attempts, rootMessage(e));
            log.warn("Failed to relay DynamoDB warehouse event {}; it will be retried", eventId, e);
            metrics.increment("dynamodb_warehouse_outbox_publish_total", Map.of("result", "failure", "eventType", eventType));
        }
    }

    private void markSent(String pk) {
        Instant now = Instant.now();
        dynamo.updateItem(builder -> builder.tableName(tableName)
                .key(Map.of("pk", AttributeValue.fromS(pk)))
                .conditionExpression("claimedBy = :worker")
                .updateExpression("SET sentAt = :sentAt, expiresAt = :expiresAt REMOVE pendingShard, availableAt, claimedBy, claimedUntil")
                .expressionAttributeValues(Map.of(
                        ":worker", AttributeValue.fromS(workerId),
                        ":sentAt", AttributeValue.fromS(now.toString()),
                        ":expiresAt", AttributeValue.fromN(Long.toString(now.plus(sentRetention).getEpochSecond()))))
                .build());
    }

    private void markFailed(String pk, int attempts, String error) {
        long delaySeconds = Math.min(300, 1L << Math.min(Math.max(attempts, 1), 8));
        Map<String, AttributeValue> values = new HashMap<>();
        values.put(":worker", AttributeValue.fromS(workerId));
        values.put(":availableAt", AttributeValue.fromS(Instant.now().plusSeconds(delaySeconds).toString()));
        values.put(":error", AttributeValue.fromS(error.length() > 1000 ? error.substring(0, 1000) : error));
        dynamo.updateItem(builder -> builder.tableName(tableName)
                .key(Map.of("pk", AttributeValue.fromS(pk)))
                .conditionExpression("claimedBy = :worker")
                .updateExpression("SET availableAt = :availableAt, lastError = :error REMOVE claimedBy, claimedUntil")
                .expressionAttributeValues(values).build());
    }

    private void putNullable(ObjectNode envelope, Map<String, AttributeValue> item, String field) {
        if (item.containsKey(field)) envelope.put(field, item.get(field).s());
        else envelope.putNull(field);
    }

    private String rootMessage(Exception error) {
        Throwable current = error;
        while (current.getCause() != null) current = current.getCause();
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }
}
