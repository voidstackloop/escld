package com.escld.backend.post;

import java.util.List;

import com.escld.backend.entities.Post;

public record PostPage(List<Post> items, String nextCursor) {
}
