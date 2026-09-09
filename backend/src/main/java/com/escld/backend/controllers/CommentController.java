package com.escld.backend.controllers;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.cache.RedisBatchCache;
import com.escld.backend.config.CacheConfig;
import com.escld.backend.dto.CommentResponse;
import com.escld.backend.dto.CreateCommentRequest;
import com.escld.backend.entities.Comment;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.PrivateAccountException;
import com.escld.backend.mappers.CommentMapper;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.services.CommentService;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class CommentController {

    private final CommentService commentService;
    private final PostService postService;
    private final UserService userService;
    private final UserRepository userRepository;
    private final FollowService followService;
    private final CommentMapper commentMapper;
    private final RedisBatchCache redisBatchCache;

    @PostMapping("/posts/{postId}/comments")
    @ResponseStatus(HttpStatus.CREATED)
    public CommentResponse createComment(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID postId,
            @Valid @RequestBody CreateCommentRequest request) {
        User viewer = currentUser(jwt);
        requireVisible(viewer, postAuthor(postId));
        return commentMapper.toResponse(commentService.createComment(postId, viewer.getId(), request.text()));
    }

    @GetMapping("/posts/{postId}/comments")
    public List<CommentResponse> getComments(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        requireVisible(currentUser(jwt), postAuthor(postId));

        List<Comment> comments = commentService.getByPostId(postId);

        // Batch-fetch authors instead of one query per comment — a post's
        // comments typically come from many different users. Routed through
        // the same "usersById" cache FeedServiceImpl already shares with
        // UserServiceImpl#getById, rather than hitting Postgres cold on
        // every comment-thread view.
        List<UUID> authorIds = comments.stream().map(Comment::getUserId).distinct().toList();
        Map<UUID, User> authorsById = redisBatchCache.getAll(
                "usersById",
                authorIds,
                UUID::toString,
                CacheConfig.USER_CACHE_TTL,
                missingIds -> {
                    Map<UUID, User> loaded = new HashMap<>();
                    userRepository.findAllById(missingIds).forEach(author -> loaded.put(author.getId(), author));
                    return loaded;
                });

        return comments.stream()
                .map(comment -> commentMapper.toResponse(comment, authorsById.get(comment.getUserId())))
                .toList();
    }

    @DeleteMapping("/comments/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteComment(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        commentService.deleteComment(id, currentUser(jwt).getId());
    }

    private User postAuthor(UUID postId) {
        Post post = postService.getById(postId);
        return userService.getById(post.getUserId());
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
