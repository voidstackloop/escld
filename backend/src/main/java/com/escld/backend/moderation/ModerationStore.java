package com.escld.backend.moderation;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;

import org.slf4j.MDC;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.dto.ReportSummary;
import com.escld.backend.exceptions.ReportNotFoundException;
import com.escld.backend.metrics.EmfMetrics;

import lombok.extern.slf4j.Slf4j;

/**
 * Single-table DynamoDB store for reports and the moderator audit log - same
 * adjacency-list shape as FollowGraphStore / ws-sfu's conversations table:
 *
 *   pk=REPORT#<id>,        sk=META                    -> canonical report record
 *   pk=MODQUEUE#OPEN,      sk=REPORT#<createdAt>#<id>  -> open-report queue, deleted on resolve
 *   pk=MOD#<moderatorId>,  sk=ACTION#<createdAt>#<id>  -> per-moderator audit trail
 *
 * The queue item is a denormalized copy of META, deleted (not just
 * status-flagged) once resolved - the same "pending item deleted on
 * resolution" trick FollowGraphStore already uses for follow REQUEST#s.
 *
 * logAction is deliberately the one place that logs a moderation action to
 * the application log (not ModerationServiceImpl or UserController, both of
 * which call this): every moderator/admin action reaches here regardless of
 * which of those two entry points triggered it (e.g. suspending a user by
 * id via UserController vs. by username via ModerationController both end
 * up here), so putting the log line anywhere else would either miss one
 * path or duplicate across both. Before this, a moderation action taken via
 * ModerationController left no trace in the application logs at all — only
 * this DynamoDB audit item and an EMF counter, neither of which shows up in
 * a plain log search/CloudWatch Logs Insights query.
 */
@Slf4j
@Component
public class ModerationStore {

    private static final String OPEN = "OPEN";
    private static final String RESOLVED = "RESOLVED";

    private final DynamoDbClient dynamoDbClient;
    private final EmfMetrics emfMetrics;
    private final String tableName;

    public ModerationStore(DynamoDbClient dynamoDbClient, EmfMetrics emfMetrics,
            @Value("${app.dynamodb.moderation-table-name}") String tableName) {
        this.dynamoDbClient = dynamoDbClient;
        this.emfMetrics = emfMetrics;
        this.tableName = tableName;
    }

    public ReportSummary fileReport(UUID reporterId, ReportTargetType targetType, UUID targetId, String reason) {
        UUID reportId = UUID.randomUUID();
        String now = Instant.now().toString();

        Map<String, AttributeValue> record = Map.of(
                "pk", AttributeValue.fromS(reportKey(reportId)),
                "sk", AttributeValue.fromS("META"),
                "id", AttributeValue.fromS(reportId.toString()),
                "targetType", AttributeValue.fromS(targetType.name()),
                "targetId", AttributeValue.fromS(targetId.toString()),
                "reporterId", AttributeValue.fromS(reporterId.toString()),
                "reason", AttributeValue.fromS(reason),
                "status", AttributeValue.fromS(OPEN),
                "createdAt", AttributeValue.fromS(now));

        dynamoDbClient.putItem(PutItemRequest.builder().tableName(tableName).item(record).build());

        Map<String, AttributeValue> queueItem = new HashMap<>(record);
        queueItem.put("pk", AttributeValue.fromS("MODQUEUE#" + OPEN));
        queueItem.put("sk", AttributeValue.fromS(queueSk(now, reportId)));

        dynamoDbClient.putItem(PutItemRequest.builder().tableName(tableName).item(queueItem).build());

        log.info("New report {} filed by {} against {} {}", reportId, reporterId, targetType, targetId);
        return toSummary(record);
    }

    public List<ReportSummary> listOpenReports() {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :prefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS("MODQUEUE#" + OPEN),
                        ":prefix", AttributeValue.fromS("REPORT#")))
                .scanIndexForward(false)
                .build());

        return response.items().stream().map(this::toSummary).collect(Collectors.toList());
    }

    public void resolveReport(UUID reportId, UUID moderatorId, String note) {
        var response = dynamoDbClient.getItem(GetItemRequest.builder()
                .tableName(tableName)
                .key(Map.of("pk", AttributeValue.fromS(reportKey(reportId)), "sk", AttributeValue.fromS("META")))
                .build());
        if (!response.hasItem()) {
            throw new ReportNotFoundException(reportId);
        }
        Map<String, AttributeValue> report = response.item();
        String createdAt = report.get("createdAt").s();

        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(Map.of(
                        "pk", AttributeValue.fromS("MODQUEUE#" + OPEN),
                        "sk", AttributeValue.fromS(queueSk(createdAt, reportId))))
                .build());

        Map<String, AttributeValue> updated = new HashMap<>(report);
        updated.put("status", AttributeValue.fromS(RESOLVED));
        updated.put("resolvedBy", AttributeValue.fromS(moderatorId.toString()));
        updated.put("resolvedAt", AttributeValue.fromS(Instant.now().toString()));
        if (note != null && !note.isBlank()) {
            updated.put("resolutionNote", AttributeValue.fromS(note));
        }
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(tableName).item(updated).build());

        logAction(moderatorId, "RESOLVE_REPORT", "REPORT", reportId.toString());
    }

    /** Audit trail entry for any moderator/admin action, not just report resolutions. */
    public void logAction(UUID moderatorId, String action, String targetType, String targetId) {
        String now = Instant.now().toString();
        UUID actionId = UUID.randomUUID();

        Map<String, AttributeValue> item = new HashMap<>(Map.of(
                "pk", AttributeValue.fromS("MOD#" + moderatorId),
                "sk", AttributeValue.fromS("ACTION#" + now + "#" + actionId),
                "action", AttributeValue.fromS(action),
                "targetType", AttributeValue.fromS(targetType),
                "targetId", AttributeValue.fromS(targetId),
                "createdAt", AttributeValue.fromS(now)));
        // Cross-references this audit entry against the structured request
        // log for the same action (see CorrelationIdFilter) — absent for
        // actions not triggered from an HTTP request (none currently exist,
        // but logAction isn't HTTP-request-specific by contract).
        String correlationId = MDC.get(CorrelationIdFilter.MDC_KEY);
        if (correlationId != null) {
            item.put("correlationId", AttributeValue.fromS(correlationId));
        }

        dynamoDbClient.putItem(PutItemRequest.builder().tableName(tableName).item(item).build());
        emfMetrics.increment("moderation_actions_total", Map.of("action", action));
        log.info("Moderator {} performed {} on {} {}", moderatorId, action, targetType, targetId);
    }

    private ReportSummary toSummary(Map<String, AttributeValue> item) {
        return new ReportSummary(
                UUID.fromString(item.get("id").s()),
                ReportTargetType.valueOf(item.get("targetType").s()),
                UUID.fromString(item.get("targetId").s()),
                UUID.fromString(item.get("reporterId").s()),
                item.get("reason").s(),
                item.getOrDefault("status", AttributeValue.fromS(OPEN)).s(),
                Instant.parse(item.get("createdAt").s()));
    }

    private String reportKey(UUID reportId) {
        return "REPORT#" + reportId;
    }

    private String queueSk(String createdAt, UUID reportId) {
        return "REPORT#" + createdAt + "#" + reportId;
    }
}
