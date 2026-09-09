package com.escld.backend.search;

import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Search-optimized projection of a User, kept in sync with Postgres on every
 * profile write. Deliberately excludes anything private (email, status).
 *
 * createIndex is disabled: Spring Data Elasticsearch's auto-create-on-startup
 * check (indices.exists) hits a client/server response-parsing bug in this
 * Spring Boot version regardless of ES major version (7/8/9 all fail
 * identically with "Expecting a response body, but none was sent"). The
 * index is created explicitly instead — see bin/elasticsearch/seed.sh.
 */
@Document(indexName = "user_search", createIndex = false)
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserSearchDocument {

    @Id
    private String id;

    @Field(type = FieldType.Text)
    private String username;

    @Field(type = FieldType.Text)
    private String displayName;

    @Field(type = FieldType.Text)
    private String bio;

    @Field(type = FieldType.Keyword, index = false)
    private String avatarUrl;

    @Field(type = FieldType.Boolean)
    private boolean verified;

    @Field(type = FieldType.Boolean)
    private boolean privateAccount;

    @Field(type = FieldType.Integer)
    private int followersCount;
}
