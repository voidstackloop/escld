package com.escld.backend.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

import com.escld.backend.metrics.EmfMetrics;

@Configuration
@EnableConfigurationProperties(AnalyticsIngressProperties.class)
public class AnalyticsIngressConfig {

    @Bean
    FilterRegistrationBean<AnalyticsRequestSizeFilter> analyticsRequestSizeFilterRegistration(
            AnalyticsIngressProperties properties, EmfMetrics emfMetrics) {
        var registration = new FilterRegistrationBean<>(new AnalyticsRequestSizeFilter(properties, emfMetrics));
        registration.addUrlPatterns("/api/v1/analytics/events");
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 1);
        return registration;
    }
}
