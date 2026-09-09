package com.escld.backend.controllers;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.dto.WebVitalRequest;
import com.escld.backend.metrics.EmfMetrics;

import software.amazon.cloudwatchlogs.emf.model.Unit;

@ExtendWith(MockitoExtension.class)
class ClientMetricControllerTest {

    @Mock
    private EmfMetrics emfMetrics;

    @Test
    void recordsClsInUnitlessScoreNotMilliseconds() {
        new ClientMetricController(emfMetrics)
                .reportWebVital(new WebVitalRequest("CLS", 0.05, "good"));

        verify(emfMetrics).recordValue(eq("web_vital_cls"), eq(0.05), eq(Unit.NONE), eq(Map.of("rating", "good")));
    }

    @Test
    void recordsDurationVitalsInMilliseconds() {
        new ClientMetricController(emfMetrics)
                .reportWebVital(new WebVitalRequest("LCP", 2400.0, "needs-improvement"));

        verify(emfMetrics).recordValue(
                eq("web_vital_lcp"), eq(2400.0), eq(Unit.MILLISECONDS), eq(Map.of("rating", "needs-improvement")));
    }
}
