package com.escld.backend.search;

import java.util.List;
import java.util.Set;

import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Search/ranking projection of a Post, written by the feed worker (see
 * feed-worker/) once it computes a local sentence embedding for the post
 * text. Not the source of truth — Postgres is (see Post entity); this exists
 * purely to power semantic feed ranking and is rebuildable from Postgres at
 * any time.
 *
 * createIndex is disabled for the same reason as UserSearchDocument — see
 * that class's Javadoc. The index is created out-of-band, see
 * bin/elasticsearch/seed_posts.sh.
 */
@Document(indexName = "posts_search", createIndex = false)
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PostSearchDocument {

    @Id
    private String id;

    @Field(type = FieldType.Keyword)
    private String userId;

    @Field(type = FieldType.Text)
    private String text;

    @Field(type = FieldType.Keyword)
    private Set<String> tags;

    // Kept as a raw ISO-8601 string, not Instant: Spring Data ES's temporal
    // converter enforces millisecond precision on read, but this is written
    // straight-through by the feed worker (see feed-worker/src/es.ts) using
    // whatever precision the source timestamp has (Java's Instant.toString()
    // can be nanosecond-precision) — never actually parsed as a date in Java
    // code, only stored for descriptive/future-query purposes, so there's
    // nothing to gain from strict typing here.
    @Field(type = FieldType.Keyword)
    private String createdAt;

    // MiniLM-L6-v2 (see feed-worker/src/embeddings.ts) produces 384-dim vectors.
    @Field(type = FieldType.Dense_Vector, dims = 384)
    private List<Float> embedding;
}
