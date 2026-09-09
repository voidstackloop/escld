package com.escld.backend.search;

import java.util.List;

import org.springframework.data.elasticsearch.repository.ElasticsearchRepository;

public interface UserSearchRepository extends ElasticsearchRepository<UserSearchDocument, String> {

    List<UserSearchDocument> findByUsernameContainingOrDisplayNameContaining(
            String username, String displayName);
}
