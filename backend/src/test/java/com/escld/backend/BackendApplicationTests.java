package com.escld.backend;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Boots the whole application context against a real Postgres (Flyway runs
 * its migrations and Hibernate validates the schema against them) and a
 * real Redis. The AWS-backed beans only need a region at startup, so they
 * load without credentials.
 */
@SpringBootTest
@Testcontainers
class BackendApplicationTests {

	@Container
	@ServiceConnection
	static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17");

	@Container
	static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

	// Set as plain properties rather than a @ServiceConnection: the rate
	// limiter builds its own Lettuce client from spring.data.redis.host/port.
	@DynamicPropertySource
	static void redisProperties(DynamicPropertyRegistry registry) {
		registry.add("spring.data.redis.host", redis::getHost);
		registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
	}

	// FlywayMigrationListener only runs when spring.datasource.url is set,
	// which @ServiceConnection doesn't do, so migrate here the same way the
	// other Postgres-backed tests do.
	@BeforeAll
	static void migrateSchema() {
		Flyway.configure()
				.dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
				.locations("classpath:db/migration")
				.load()
				.migrate();
	}

	@Test
	void contextLoads() {
	}

}
