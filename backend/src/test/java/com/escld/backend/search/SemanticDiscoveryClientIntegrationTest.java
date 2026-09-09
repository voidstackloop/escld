package com.escld.backend.search;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.elasticsearch.client.elc.ElasticsearchTemplate;
import org.springframework.data.elasticsearch.core.ElasticsearchOperations;
import org.springframework.data.elasticsearch.core.document.Document;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.jackson.JacksonJsonpMapper;
import co.elastic.clients.transport.rest5_client.Rest5ClientTransport;
import co.elastic.clients.transport.rest5_client.low_level.Rest5Client;

/**
 * The first Elasticsearch Testcontainers test in this repo — settles, against
 * a real server matching docker-compose.yaml's own elasticsearch:9.4.3
 * exactly, whether ES 9.4.3 genuinely accepts a `knn` clause in a standard
 * `_search` body, rather than trusting that from client-library shape alone
 * (SemanticDiscoveryClientTest only proves the query object is built
 * correctly, not that a real server accepts it). Uses a real 3-dim
 * dense_vector mapping — same index:true/similarity:cosine shape as the real
 * posts_mapping.json (see that file's own comment on why the index is
 * already kNN-ready) — applied via IndexOperations, mirroring what
 * bin/elasticsearch/create_posts_index.sh does against a raw HTTP PUT.
 */
@Testcontainers
class SemanticDiscoveryClientIntegrationTest {

    private static final String INDEX_NAME = "posts_search";

    @Container
    static GenericContainer<?> elasticsearch =
            new GenericContainer<>(DockerImageName.parse("elasticsearch:9.4.3"))
                    .withEnv("discovery.type", "single-node")
                    .withEnv("xpack.security.enabled", "false")
                    .withEnv("ES_JAVA_OPTS", "-Xms512m -Xmx512m")
                    .withExposedPorts(9200)
                    .waitingFor(Wait.forHttp("/_cluster/health").forStatusCode(200))
                    .withStartupTimeout(Duration.ofMinutes(2));

    static ElasticsearchOperations operations;

    @BeforeAll
    static void setUp() {
        Rest5Client rest5Client = Rest5Client.builder(
                URI.create("http://" + elasticsearch.getHost() + ":" + elasticsearch.getMappedPort(9200)))
                .build();
        ElasticsearchClient esClient = new ElasticsearchClient(
                new Rest5ClientTransport(rest5Client, new JacksonJsonpMapper()));
        operations = new ElasticsearchTemplate(esClient);

        operations.indexOps(IndexCoordinates.of(INDEX_NAME)).create();
        operations.indexOps(IndexCoordinates.of(INDEX_NAME)).putMapping(Document.parse(
                "{\"properties\":{"
                        + "\"userId\":{\"type\":\"keyword\"},"
                        + "\"text\":{\"type\":\"text\"},"
                        + "\"tags\":{\"type\":\"keyword\"},"
                        + "\"embedding\":{\"type\":\"dense_vector\",\"dims\":3,\"index\":true,\"similarity\":\"cosine\"}"
                        + "}}"));
    }

    @Test
    void aRealKnnSearchReturnsDocumentsOrderedByEmbeddingSimilarity() {
        UUID exactMatch = UUID.randomUUID();
        UUID closeMatch = UUID.randomUUID();
        UUID farMatch = UUID.randomUUID();

        index(exactMatch, List.of(1.0f, 0.0f, 0.0f));
        index(closeMatch, List.of(0.9f, 0.1f, 0.0f));
        index(farMatch, List.of(0.0f, 1.0f, 0.0f));
        operations.indexOps(IndexCoordinates.of(INDEX_NAME)).refresh();

        SemanticDiscoveryClient discoveryClient = new SemanticDiscoveryClient(operations);
        List<UUID> results = discoveryClient.findSimilar(new float[] { 1.0f, 0.0f, 0.0f }, 3);

        assertThat(results).containsExactly(exactMatch, closeMatch, farMatch);
    }

    private void index(UUID id, List<Float> embedding) {
        PostSearchDocument doc = PostSearchDocument.builder()
                .id(id.toString())
                .userId(UUID.randomUUID().toString())
                .text("post")
                .embedding(embedding)
                .build();
        operations.save(doc, IndexCoordinates.of(INDEX_NAME));
    }
}
