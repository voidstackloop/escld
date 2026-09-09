package com.escld.backend.services;

import java.util.UUID;

/**
 * GDPR "right to be forgotten" — deliberately a separate service from
 * UserService, not an addition to activate/suspend/deactivate: unlike those,
 * this is a cross-store orchestration (Postgres + DynamoDB x3 + Elasticsearch
 * + S3), and unlike a normal soft-delete it must actually scrub PII, not just
 * hide it (see docs/DATA_CLASSIFICATION.md for what's PII where).
 *
 * Deliberately out of scope, by design, not oversight: the moderation audit
 * trail (DynamoDB `MOD#<moderatorId>` items in ModerationStore) — the point
 * of an audit trail is to survive the actor being deleted elsewhere. Reports
 * (`REPORT#`/`MODQUEUE#OPEN` items) are also left untouched — a governance
 * record, not this user's own data to delete on request. The retention-
 * period and anonymize-vs-hard-delete policy question itself is a product/
 * legal decision, not resolved here — this only builds the minimal technical
 * capability to actually execute a deletion once that policy exists (see the
 * enterprise-hardening plan).
 */
public interface AccountDeletionService {

    void deleteAccount(UUID userId);
}
