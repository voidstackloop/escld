package com.escld.backend.metrics;

import java.util.Map;

import org.springframework.stereotype.Component;

import software.amazon.cloudwatchlogs.emf.logger.MetricsLogger;
import software.amazon.cloudwatchlogs.emf.model.DimensionSet;
import software.amazon.cloudwatchlogs.emf.model.Unit;

import lombok.extern.slf4j.Slf4j;

/**
 * A handful of custom business counters (posts created, moderation actions,
 * follow requests, SQS enqueue results) — deliberately small, not blanket
 * instrumentation of every controller. Default JVM/HTTP/DB-pool metrics
 * already come from Micrometer/Actuator; this exists only for domain events
 * those don't see.
 *
 * Writes CloudWatch Embedded Metric Format JSON directly to stdout via its
 * own sink (MetricsLogger, independent of the SLF4J/Logback structured-
 * logging pipeline) — CloudWatch auto-extracts real metrics from these
 * lines out of the same log group the ECS awsLogs driver already ships, no
 * separate scrape agent or collector needed. A fresh MetricsLogger per call
 * rather than a shared instance: it's cheap to construct, and this avoids
 * any question of thread-safety across concurrent requests.
 */
@Slf4j
@Component
public class EmfMetrics {

    private static final String NAMESPACE = "escld/backend";

    public void increment(String metricName, Map<String, String> dimensions) {
        try {
            MetricsLogger metrics = new MetricsLogger();
            metrics.setNamespace(NAMESPACE);
            applyDimensions(metrics, dimensions);
            metrics.putMetric(metricName, 1, Unit.COUNT);
            metrics.flush();
        } catch (Exception e) {
            // A metrics-emission failure must never break the operation it's
            // instrumenting — same "best-effort" reasoning as the SQS/Redis
            // event publishers.
            log.warn("Failed to emit EMF metric {}", metricName, e);
        }
    }

    /**
     * Unlike {@link #increment}, records a real measured value rather than a
     * fixed count of 1 — needed for frontend Web Vitals (see
     * ClientMetricController), which are durations/scores, not occurrences.
     */
    public void recordValue(String metricName, double value, Unit unit, Map<String, String> dimensions) {
        try {
            MetricsLogger metrics = new MetricsLogger();
            metrics.setNamespace(NAMESPACE);
            applyDimensions(metrics, dimensions);
            metrics.putMetric(metricName, value, unit);
            metrics.flush();
        } catch (Exception e) {
            log.warn("Failed to emit EMF metric {}", metricName, e);
        }
    }

    private void applyDimensions(MetricsLogger metrics, Map<String, String> dimensions) {
        if (dimensions.isEmpty()) {
            return;
        }
        DimensionSet dimensionSet = new DimensionSet();
        for (Map.Entry<String, String> dimension : dimensions.entrySet()) {
            dimensionSet.addDimension(dimension.getKey(), dimension.getValue());
        }
        metrics.putDimensions(dimensionSet);
    }
}
