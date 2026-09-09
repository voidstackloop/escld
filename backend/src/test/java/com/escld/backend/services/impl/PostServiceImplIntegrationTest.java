package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;

import java.util.List;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.dto.CreatePostRequest;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.feed.PostEventPublisher;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.services.UserService;
import com.escld.backend.transcode.TranscodeJobPublisher;
import com.escld.backend.warehouse.WarehouseEventPublisher;

/**
 * Real-Postgres regression test for the createPost data-loss bug: a bulk
 * {@code @Modifying(clearAutomatically = true)} query (UserRepository's
 * incrementPostsCount) run right after {@code postRepository.save(...)}
 * silently discarded the new post's still-pending (write-behind) INSERT —
 * clearAutomatically calls EntityManager.clear(), which detaches everything
 * not yet flushed. createPost returned 201 with a populated body; the post
 * never reached the database. A pure-mock unit test can't catch this — it's
 * a genuine Hibernate persistence-context interaction with a real bulk
 * UPDATE, which is exactly what this test exercises against a real Postgres
 * via Testcontainers. Fixed by saveAndFlush (see PostServiceImpl).
 *
 * UserService itself is mocked (avoids pulling in caching/Elasticsearch), but
 * its incrementPostsCount call is forwarded to the REAL UserRepository bulk
 * query below — that forwarding is what makes this test meaningful instead
 * of just exercising a no-op mock.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import(PostServiceImpl.class)
@Testcontainers
class PostServiceImplIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17");

    // Run migrations directly via Flyway's own API rather than relying on Spring's
    // FlywayAutoConfiguration, which @DataJpaTest's narrow test slice doesn't pull
    // in — this runs (per JUnit lifecycle) after Testcontainers starts the
    // container above but before Spring's ApplicationContext (and therefore
    // Hibernate's ddl-auto=validate check) is created for the first test.
    @BeforeAll
    static void migrateSchema() {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Autowired
    private PostRepository postRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private PostServiceImpl postService;

    @MockitoBean
    private UserService userService;
    @MockitoBean
    private TranscodeJobPublisher transcodeJobPublisher;
    @MockitoBean
    private PostEventPublisher postEventPublisher;
    @MockitoBean
    private AnalyticsEventPublisher analyticsEventPublisher;
    @MockitoBean
    private WarehouseEventPublisher warehouseEventPublisher;
    @MockitoBean
    private EmfMetrics emfMetrics;

    private User author;

    @BeforeEach
    void setUp() {
        author = userRepository.save(User.builder()
                .cognitoSub(UUID.randomUUID())
                .username("integration_test_user_" + UUID.randomUUID().toString().substring(0, 8))
                .email(UUID.randomUUID() + "@example.com")
                .displayName("Integration Test User")
                .build());

        // Forwards to the real bulk UPDATE — see class javadoc for why this matters.
        doAnswer(invocation -> {
            userRepository.incrementPostsCount(invocation.getArgument(0));
            return null;
        }).when(userService).incrementPostsCount(any());
    }

    @Test
    void createdPostIsActuallyPersistedDespiteTheCountUpdateRightAfterIt() {
        CreatePostRequest request = new CreatePostRequest("hello from the integration test", null, null, List.of("integration"));

        Post saved = postService.createPost(author.getId(), request);

        Post reloaded = postRepository.findById(saved.getId()).orElseThrow(
                () -> new AssertionError("Post was never actually persisted to Postgres"));

        assertThat(reloaded.getText()).isEqualTo("hello from the integration test");
        assertThat(reloaded.getCreatedAt()).isNotNull();
        assertThat(reloaded.getUserId()).isEqualTo(author.getId());
    }

    @Test
    void postsCountIsIncrementedExactlyOnce() {
        CreatePostRequest request = new CreatePostRequest("counting test", null, null, List.of());

        postService.createPost(author.getId(), request);

        User reloadedAuthor = userRepository.findById(author.getId()).orElseThrow();
        assertThat(reloadedAuthor.getPostsCount()).isEqualTo(1);
    }
}
