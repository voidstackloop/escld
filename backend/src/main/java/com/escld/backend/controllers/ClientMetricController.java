package com.escld.backend.controllers;

import java.util.Locale;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.WebVitalRequest;
import com.escld.backend.metrics.EmfMetrics;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

import software.amazon.cloudwatchlogs.emf.model.Unit;

/**
 * Frontend Real User Monitoring (Core Web Vitals: LCP/INP/CLS/FCP/TTFB, via
 * the web-vitals npm package — see frontend/src/lib/rum.ts), on the same
 * "self-hosted over a dedicated SaaS" call already made for frontend error
 * reporting (see ClientLogController's own doc) — these land as EMF metrics
 * in the same escld/backend CloudWatch namespace every other backend metric
 * already uses, rather than adopting a vendor RUM product for a single
 * frontend.
 *
 * No auth required, same reasoning as ClientLogController: a slow page
 * before login should still be measurable. The existing IP-based
 * RateLimitFilter bounds request volume; WebVitalRequest's own @Pattern
 * constraints on name/rating are what actually bounds metric-name/dimension
 * cardinality — an attacker sending a high volume of validly-shaped-but-
 * fabricated requests still only ever produces one of the 5 known metric
 * names crossed with one of 3 known ratings, not an unbounded set.
 */
@RestController
@RequestMapping("/api/v1/client-metrics")
@RequiredArgsConstructor
public class ClientMetricController {

    private final EmfMetrics emfMetrics;

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    public void reportWebVital(@Valid @RequestBody WebVitalRequest request) {
        // CLS is a unitless score (sum of layout-shift impact fractions),
        // every other Core Web Vital here is a duration.
        Unit unit = "CLS".equals(request.name()) ? Unit.NONE : Unit.MILLISECONDS;
        emfMetrics.recordValue(
                "web_vital_" + request.name().toLowerCase(Locale.ROOT),
                request.value(),
                unit,
                Map.of("rating", request.rating()));
    }
}
