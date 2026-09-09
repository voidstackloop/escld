package com.escld.backend.services;

import java.util.List;
import java.util.UUID;

import com.escld.backend.dto.ReportSummary;
import com.escld.backend.moderation.ReportTargetType;

public interface ModerationService {

    ReportSummary fileReport(UUID reporterId, ReportTargetType targetType, UUID targetId, String reason);

    List<ReportSummary> listOpenReports();

    void resolveReport(UUID reportId, UUID moderatorId, String note);

    void suspendUser(UUID moderatorId, String username);

    void reinstateUser(UUID moderatorId, String username);

    void removePost(UUID moderatorId, UUID postId);

    void removeComment(UUID moderatorId, UUID commentId);
}
