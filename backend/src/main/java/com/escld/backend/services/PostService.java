package com.escld.backend.services;

import java.util.UUID;

import com.escld.backend.dto.CreatePostRequest;
import com.escld.backend.entities.Post;
import com.escld.backend.post.PostPage;

/**
 * The transcode worker (worker/) updates a post's media_status/media_url by
 * connecting to Postgres directly once a job finishes — same pattern as the
 * Cognito postConfirmation Lambda. No callback endpoint here; keeps the
 * worker decoupled from needing backend credentials/auth.
 */
public interface PostService {

    Post createPost(UUID authorId, CreatePostRequest request);

    Post getById(UUID postId);

    PostPage getByUsername(String username, int limit, String cursor);

    void deletePost(UUID postId, UUID requesterId);

    /** Moderator override — removes any post regardless of ownership. */
    void deletePostAsModerator(UUID postId);

    // Wrappers around PostRepository's own atomic UPDATE counters (see
    // PostRepository) — routed through here, not called directly by
    // LikeServiceImpl/CommentServiceImpl, specifically so the postsById
    // cache (see PostServiceImpl#getById) gets evicted alongside the count
    // change. These bypass save()/the cached entity entirely (a bulk
    // UPDATE), so without this indirection the cache would keep serving a
    // stale like/comment count indefinitely after the very like/comment
    // that changed it.
    void incrementLikeCount(UUID postId);

    void decrementLikeCount(UUID postId);

    void incrementCommentCount(UUID postId);

    void decrementCommentCount(UUID postId);
}
