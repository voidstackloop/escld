package com.escld.backend.search;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.springframework.data.elasticsearch.client.elc.NativeQuery;
import org.springframework.data.elasticsearch.core.ElasticsearchOperations;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.Query;
import org.springframework.stereotype.Component;

import lombok.extern.slf4j.Slf4j;

/**
 * Real semantic discovery beyond the follow graph — row 2 of
 * docs/DATA_ANALYSIS_AND_FEED_DESIGN.md's #6.1 6-source retrieval table
 * ("Semantic discovery... Filtered ANN over public eligible post
 * embeddings"), nothing more. Topic discovery, engagement-neighborhoods, and
 * exploration slots (the other rows of that table) are each their own
 * project, not attempted here.
 *
 * Callers MUST gate this to mode=for_you only — see FeedServiceImpl#getFeed.
 * `following` is defined as strictly "eligible followed authors and self";
 * injecting off-graph content there would break the one invariant that
 * mode's name promises. There is also, today, a purely practical reason this
 * is the safe place to ship a new, unproven candidate source: no frontend
 * caller sets mode=for_you yet, so this carries zero production traffic
 * until the frontend opts in.
 *
 * PostSearchDocument doesn't carry visibility/isPrivateAccount today (the
 * design doc calls that its own future reindex scope), so a raw KNN hit
 * against a private author's post can still get filtered out downstream by
 * FeedServiceImpl#hydrateEligible — over-fetch (see the caller's
 * knnOverfetchMultiplier) compensates for that unknown loss rate rather than
 * filtering visibility inside this query.
 */
@Slf4j
@Component
public class SemanticDiscoveryClient {

    private final ElasticsearchOperations elasticsearchOperations;

    public SemanticDiscoveryClient(ElasticsearchOperations elasticsearchOperations) {
        this.elasticsearchOperations = elasticsearchOperations;
    }

    /**
     * Returns up to `count` post ids ranked by embedding similarity to
     * `affinityVector` (the viewer's own taste vector — see
     * FeedServiceImpl#computeAffinityVector, the same vector already used for
     * semantic-affinity ranking, not a separately-computed one). Best-effort,
     * matching every other cross-store read in this backend: any
     * Elasticsearch failure returns an empty list rather than propagating,
     * degrading for_you back to a pure follow-graph feed for that request
     * rather than failing it outright.
     */
    public List<UUID> findSimilar(float[] affinityVector, int count) {
        if (affinityVector == null || affinityVector.length == 0 || count <= 0) {
            return List.of();
        }
        try {
            List<Float> queryVector = new ArrayList<>(affinityVector.length);
            for (float v : affinityVector) {
                queryVector.add(v);
            }

            // numCandidates > k so HNSW has real room to search, not just
            // return exactly k nearest of a k-sized shortlist.
            int numCandidates = Math.max(count * 2, count);
            Query query = NativeQuery.builder()
                    .withKnnSearches(builder -> builder
                            .field("embedding")
                            .queryVector(queryVector)
                            .k(count)
                            .numCandidates(numCandidates))
                    .build();

            SearchHits<PostSearchDocument> hits = elasticsearchOperations.search(query, PostSearchDocument.class);
            List<UUID> ids = new ArrayList<>();
            for (SearchHit<PostSearchDocument> hit : hits.getSearchHits()) {
                ids.add(UUID.fromString(hit.getContent().getId()));
            }
            return ids;
        } catch (Exception e) {
            log.warn("Semantic discovery KNN query failed; for_you falls back to follow-graph-only for this request", e);
            return List.of();
        }
    }
}
