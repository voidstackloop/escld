package com.escld.backend.search;

import java.util.List;

import org.springframework.data.domain.Pageable;
import org.springframework.data.elasticsearch.repository.ElasticsearchRepository;

public interface PostSearchRepository extends ElasticsearchRepository<PostSearchDocument, String> {

    List<PostSearchDocument> findByUserIdOrderByCreatedAtDesc(String userId);

    // FeedServiceImpl#computeAffinityVector only ever needs the first
    // AFFINITY_SAMPLE_SIZE documents - without a Pageable, the unbounded
    // overload above pulls a viewer's *entire* post-document history out of
    // Elasticsearch on every feed request, then discards everything past
    // the first 20 client-side. Same query, Pageable pushes the limit down
    // to ES itself.
    List<PostSearchDocument> findByUserIdOrderByCreatedAtDesc(String userId, Pageable pageable);
}
