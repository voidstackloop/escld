package com.escld.backend.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.elasticsearch.client.elc.NativeQuery;
import org.springframework.data.elasticsearch.core.ElasticsearchOperations;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.Query;

import co.elastic.clients.elasticsearch._types.KnnSearch;

@ExtendWith(MockitoExtension.class)
class SemanticDiscoveryClientTest {

    @Mock
    private ElasticsearchOperations elasticsearchOperations;
    @Mock
    private SearchHits<PostSearchDocument> searchHits;
    @Mock
    private SearchHit<PostSearchDocument> hit1;
    @Mock
    private SearchHit<PostSearchDocument> hit2;

    private SemanticDiscoveryClient client;

    @BeforeEach
    void setUp() {
        client = new SemanticDiscoveryClient(elasticsearchOperations);
    }

    @Test
    void returnsAnEmptyListWithoutTouchingElasticsearchWhenGivenNoAffinityVector() {
        assertThat(client.findSimilar(null, 10)).isEmpty();
        assertThat(client.findSimilar(new float[0], 10)).isEmpty();
        assertThat(client.findSimilar(new float[] { 1.0f }, 0)).isEmpty();
    }

    @Test
    void buildsAKnnQueryAgainstTheEmbeddingFieldWithTheGivenVectorAndCount() {
        when(elasticsearchOperations.search(any(Query.class), eq(PostSearchDocument.class)))
                .thenReturn(searchHits);
        when(searchHits.getSearchHits()).thenReturn(List.of());

        client.findSimilar(new float[] { 1.0f, 0.5f, -0.5f }, 5);

        ArgumentCaptor<Query> captor = ArgumentCaptor.forClass(Query.class);
        verify(elasticsearchOperations).search(captor.capture(), eq(PostSearchDocument.class));
        NativeQuery query = (NativeQuery) captor.getValue();
        assertThat(query.getKnnSearches()).hasSize(1);
        KnnSearch knn = query.getKnnSearches().get(0);
        assertThat(knn.field()).isEqualTo("embedding");
        assertThat(knn.k()).isEqualTo(5);
        assertThat(knn.numCandidates()).isEqualTo(10);
        assertThat(knn.queryVector()).containsExactly(1.0f, 0.5f, -0.5f);
    }

    @Test
    void returnsHitIdsAsUuidsInRankedOrder() {
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        when(elasticsearchOperations.search(any(Query.class), eq(PostSearchDocument.class)))
                .thenReturn(searchHits);
        when(searchHits.getSearchHits()).thenReturn(List.of(hit1, hit2));
        when(hit1.getContent()).thenReturn(PostSearchDocument.builder().id(first.toString()).build());
        when(hit2.getContent()).thenReturn(PostSearchDocument.builder().id(second.toString()).build());

        List<UUID> result = client.findSimilar(new float[] { 1.0f }, 2);

        assertThat(result).containsExactly(first, second);
    }

    @Test
    void returnsAnEmptyListRatherThanPropagatingWhenElasticsearchFails() {
        when(elasticsearchOperations.search(any(Query.class), eq(PostSearchDocument.class)))
                .thenThrow(new RuntimeException("es down"));

        assertThat(client.findSimilar(new float[] { 1.0f }, 5)).isEmpty();
    }
}
