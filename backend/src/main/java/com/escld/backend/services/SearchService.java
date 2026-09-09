package com.escld.backend.services;

import java.util.List;

import com.escld.backend.dto.UserSearchResult;

public interface SearchService {

    List<UserSearchResult> searchUsers(String query);
}
