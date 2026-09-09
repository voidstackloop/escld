package com.escld.backend.warehouse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.fasterxml.jackson.databind.ObjectMapper;

@Testcontainers
class WarehouseOutboxStoreIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17");

    private WarehouseOutboxStore store;
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;

    @BeforeAll
    static void migrateSchema() {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @BeforeEach
    void setUp() {
        DataSource dataSource = new DriverManagerDataSource(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
        store = new WarehouseOutboxStore(new NamedParameterJdbcTemplate(dataSource), new ObjectMapper());
        jdbc = new JdbcTemplate(dataSource);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        jdbc.update("DELETE FROM warehouse_outbox");
    }

    @Test
    void enqueueParticipatesInTheCallingTransaction() {
        WarehouseEvent event = event();

        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> {
            store.enqueue(event);
            throw new IllegalStateException("roll back domain mutation");
        })).isInstanceOf(IllegalStateException.class);

        assertThat(jdbc.queryForObject("SELECT count(*) FROM warehouse_outbox", Integer.class)).isZero();
    }

    @Test
    void enqueueIsIdempotentForAStableClientEventId() {
        WarehouseEvent event = event();

        store.enqueue(event);
        store.enqueue(event);

        assertThat(jdbc.queryForObject("SELECT count(*) FROM warehouse_outbox WHERE id = ?",
                Integer.class, event.eventId())).isEqualTo(1);
    }

    @Test
    void expiredClaimsAreRecoverableAndSuccessfulRowsAreNotClaimedAgain() {
        WarehouseEvent event = event();
        store.enqueue(event);
        UUID firstWorker = UUID.randomUUID();

        var firstClaim = store.claimBatch(firstWorker, 10, Duration.ofSeconds(30));
        var competingClaim = store.claimBatch(UUID.randomUUID(), 10, Duration.ofSeconds(30));

        assertThat(firstClaim).singleElement().satisfies(claimed -> {
            assertThat(claimed.eventId()).isEqualTo(event.eventId());
            assertThat(claimed.attempts()).isEqualTo(1);
        });
        assertThat(competingClaim).isEmpty();

        jdbc.update("UPDATE warehouse_outbox SET claimed_until = now() - interval '1 second' WHERE id = ?", event.eventId());
        UUID recoveryWorker = UUID.randomUUID();
        var recovered = store.claimBatch(recoveryWorker, 10, Duration.ofSeconds(30));

        assertThat(recovered).singleElement().satisfies(claimed -> assertThat(claimed.attempts()).isEqualTo(2));
        assertThat(store.markSent(event.eventId(), recoveryWorker)).isTrue();
        assertThat(store.claimBatch(UUID.randomUUID(), 10, Duration.ofSeconds(30))).isEmpty();
    }

    @Test
    void publishesOnlyOneUnsentEventPerPartitionKeyAtATime() {
        UUID postId = UUID.randomUUID();
        WarehouseEvent first = event(postId, Instant.parse("2026-09-05T12:00:00Z"));
        WarehouseEvent second = event(postId, Instant.parse("2026-09-05T12:00:01Z"));
        store.enqueue(first);
        store.enqueue(second);
        UUID worker = UUID.randomUUID();

        var initialClaim = store.claimBatch(worker, 10, Duration.ofSeconds(30));

        assertThat(initialClaim).extracting(WarehouseOutboxRecord::eventId).containsExactly(first.eventId());
        assertThat(store.markSent(first.eventId(), worker)).isTrue();

        UUID nextWorker = UUID.randomUUID();
        var nextClaim = store.claimBatch(nextWorker, 10, Duration.ofSeconds(30));
        assertThat(nextClaim).extracting(WarehouseOutboxRecord::eventId).containsExactly(second.eventId());
    }

    private WarehouseEvent event() {
        UUID postId = UUID.randomUUID();
        return event(postId, Instant.now());
    }

    private WarehouseEvent event(UUID postId, Instant occurredAt) {
        return new WarehouseEvent(
                UUID.randomUUID(), "post.created", "2", postId.toString(), occurredAt, "backend",
                UUID.randomUUID(), "post", postId.toString(), 1L, "correlation-1",
                null, UUID.randomUUID(), null, null,
                Map.of("postId", postId.toString()));
    }
}
