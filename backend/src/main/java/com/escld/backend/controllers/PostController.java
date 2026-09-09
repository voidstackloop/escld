package com.escld.backend.controllers;

import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.CreatePostRequest;
import com.escld.backend.dto.FeedPageResponse;
import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.dto.PostInsightsResponse;
import com.escld.backend.dto.PostResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.PrivateAccountException;
import com.escld.backend.insights.PostInsightsService;
import com.escld.backend.mappers.PostMapper;
import com.escld.backend.post.PostPage;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.LikeService;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class PostController {

    private static final int MAX_LIMIT = 50;

    private final PostService postService;
    private final UserService userService;
    private final FollowService followService;
    private final LikeService likeService;
    private final PostInsightsService postInsightsService;
    private final PostMapper postMapper;

    @PostMapping("/posts")
    @ResponseStatus(HttpStatus.CREATED)
    public PostResponse createPost(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreatePostRequest request) {
        User author = currentUser(jwt);
        Post post = postService.createPost(author.getId(), request);
        // A post you just created can't already be liked by you.
        return postMapper.toResponse(post, author, false);
    }

    @GetMapping("/posts/{id}")
    public PostResponse getPost(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        Post post = postService.getById(id);
        User author = userService.getById(post.getUserId());
        User viewer = currentUser(jwt);
        requireVisible(viewer, author);

        boolean liked = likeService.getLikedPostIds(viewer.getId(), List.of(post.getId())).contains(post.getId());
        return postMapper.toResponse(post, author, liked);
    }

    @GetMapping("/users/{username}/posts")
    public FeedPageResponse getPostsByUser(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable String username,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(required = false) String cursor) {
        User author = userService.getByUsername(username);
        User viewer = currentUser(jwt);
        requireVisible(viewer, author);

        PostPage page = postService.getByUsername(username, Math.min(Math.max(limit, 1), MAX_LIMIT), cursor);

        List<UUID> postIds = page.items().stream().map(Post::getId).toList();
        Set<UUID> likedPostIds = likeService.getLikedPostIds(viewer.getId(), postIds);

        return new FeedPageResponse(
                page.items().stream()
                        .map(post -> postMapper.toResponse(post, author, likedPostIds.contains(post.getId())))
                        .toList(),
                page.nextCursor());
    }

    @DeleteMapping("/posts/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deletePost(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        postService.deletePost(id, currentUser(jwt).getId());
    }

    /** Author-only performance snapshot — see PostInsightsService's own doc
     * for scope (Postgres counters + live trending/viewer data, not a
     * BigQuery-backed historical dashboard). */
    @GetMapping("/posts/{id}/insights")
    public PostInsightsResponse getInsights(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return postInsightsService.getInsights(id, currentUser(jwt).getId());
    }

    /** Owner-only historical aggregates: UTC, inclusive from, exclusive to,
     * default 7 days, max 90 days. Returns 503 with explicit unavailable
     * status until the DynamoDB/Redis materialized exporter lands. */
    @GetMapping("/posts/{id}/insights/history")
    public InsightsHistoryResponse getInsightsHistory(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID id,
            @RequestParam(required = false) LocalDate from,
            @RequestParam(required = false) LocalDate to,
            @RequestParam(defaultValue = "day") String granularity) {
        if (!"day".equals(granularity)) {
            throw new IllegalArgumentException("Unsupported granularity: " + granularity);
        }
        return postInsightsService.getHistory(id, currentUser(jwt).getId(), from, to);
    }

    private void requireVisible(User viewer, User author) {
        if (!followService.canViewFollowLists(viewer.getId(), author)) {
            throw new PrivateAccountException();
        }
    }

    private User currentUser(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt);
    }
}
