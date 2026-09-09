package com.escld.backend.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Pattern;

/**
 * A single Core Web Vital measurement from the web-vitals npm package (see
 * frontend/src/lib/rum.ts). `name`/`rating` are constrained to the library's
 * own fixed value sets rather than left as free-form strings — this endpoint
 * is unauthenticated (see ClientMetricController), and both fields flow
 * straight into a CloudWatch EMF metric name/dimension, so an unconstrained
 * value here would let any caller mint arbitrary custom metrics/dimension
 * values, a real cost and cardinality-explosion risk, not just a data-shape
 * concern.
 */
public record WebVitalRequest(
        @NotBlank
        @Pattern(regexp = "CLS|FCP|INP|LCP|TTFB", message = "name must be one of CLS, FCP, INP, LCP, TTFB")
        String name,

        @PositiveOrZero
        double value,

        @NotBlank
        @Pattern(regexp = "good|needs-improvement|poor", message = "rating must be one of good, needs-improvement, poor")
        String rating) {
}
