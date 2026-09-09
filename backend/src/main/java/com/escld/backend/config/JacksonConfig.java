package com.escld.backend.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * A classic Jackson 2 ({@code com.fasterxml.jackson.databind.ObjectMapper})
 * bean, for the handful of components below that need one via constructor
 * injection.
 *
 * Spring Boot 4's own JSON auto-configuration ({@code spring-boot-jackson})
 * wires up Jackson 3's {@code tools.jackson.databind.ObjectMapper} instead —
 * a different class in a different package, not merely a newer version of
 * this one (confirmed directly: {@code ./mvnw dependency:tree} resolves both
 * {@code com.fasterxml.jackson.core:jackson-databind:2.21.2} *and*
 * {@code tools.jackson.core:jackson-databind:3.1.0} on the classpath
 * simultaneously). That left every {@code @Component} here that declared a
 * plain constructor-injected classic {@code ObjectMapper} parameter with
 * "no qualifying bean" at startup — this app never had one, only ever
 * exercised as unit tests that construct these classes directly (bypassing
 * Spring entirely) or via best-effort SQS/Kafka publishers
 * ({@code PostEventPublisher}, {@code AnalyticsEventPublisher}) that already
 * work around the same gap by constructing their own {@code ObjectMapper}
 * inline rather than requesting one from Spring.
 *
 * {@code findAndRegisterModules()} picks up {@code jackson-datatype-jsr310}
 * (an explicit direct dependency — see pom.xml) via its SPI registration,
 * matching every one of this bean's consumers' own pre-existing test setup
 * ({@code new ObjectMapper().findAndRegisterModules()}) exactly, so this
 * bean behaves identically to what those tests already construct by hand.
 */
@Configuration
public class JacksonConfig {

    @Bean
    ObjectMapper objectMapper() {
        return new ObjectMapper().findAndRegisterModules();
    }
}
