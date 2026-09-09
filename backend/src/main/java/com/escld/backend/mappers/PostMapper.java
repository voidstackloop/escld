package com.escld.backend.mappers;

import org.springframework.stereotype.Component;

import com.escld.backend.dto.PostResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;

import lombok.RequiredArgsConstructor;

@Component
@RequiredArgsConstructor
public class PostMapper {

    public PostResponse toResponse(Post post, User author, boolean likedByViewer) {
        return toResponse(post, author, likedByViewer, false);
    }

    public PostResponse toResponse(Post post, User author, boolean likedByViewer, boolean trending) {
        return new PostResponse(
                post.getId(),
                author.getId(),
                author.getUsername(),
                author.getDisplayName(),
                author.getAvatarUrl(),
                post.getText(),
                post.getDescription(),
                post.getMediaType(),
                post.getMediaUrl(),
                post.getMediaStatus(),
                post.getTags(),
                post.getCommentCount(),
                post.getLikeCount(),
                likedByViewer,
                trending,
                post.getLiveStatus(),
                post.getLiveStartedAt(),
                post.getLiveEndedAt(),
                post.getPeakViewerCount(),
                post.getCreatedAt());
    }
}
