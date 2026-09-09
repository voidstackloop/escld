package com.escld.backend;

import org.flywaydb.core.Flyway;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * Runs Flyway migrations against spring.datasource.* before the ApplicationContext
 * is refreshed, so they land before Hibernate validates the schema. Spring Boot's
 * own Flyway autoconfiguration isn't on the classpath for this Boot version, hence
 * the manual wiring.
 */
public class FlywayMigrationListener implements ApplicationListener<ApplicationEnvironmentPreparedEvent>, Ordered {

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        ConfigurableEnvironment env = event.getEnvironment();
        String url = env.getProperty("spring.datasource.url");
        if (url == null) {
            return;
        }

        Flyway.configure()
                .dataSource(url, env.getProperty("spring.datasource.username"), env.getProperty("spring.datasource.password"))
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 20;
    }
}
