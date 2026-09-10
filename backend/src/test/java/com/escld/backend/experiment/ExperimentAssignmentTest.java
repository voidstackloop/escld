package com.escld.backend.experiment;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class ExperimentAssignmentTest {

    private static final List<String> VARIANTS = List.of("control", "treatment");

    @Test
    void sameUserAndExperimentAlwaysGetTheSameVariant() {
        UUID userId = UUID.randomUUID();
        String first = ExperimentAssignment.assign(userId, "exp1", VARIANTS);
        String second = ExperimentAssignment.assign(userId, "exp1", VARIANTS);
        assertThat(first).isEqualTo(second);
    }

    @Test
    void differentExperimentsCanAssignTheSameUserDifferentVariants() {
        // Not guaranteed for every user, but across many users at least one
        // must differ, or the hash isn't actually incorporating experimentId.
        boolean sawDifference = false;
        for (int i = 0; i < 100; i++) {
            UUID userId = UUID.randomUUID();
            if (!ExperimentAssignment.assign(userId, "exp1", VARIANTS)
                    .equals(ExperimentAssignment.assign(userId, "exp2", VARIANTS))) {
                sawDifference = true;
                break;
            }
        }
        assertThat(sawDifference).isTrue();
    }

    @Test
    void bothVariantsGetSelectedAcrossManyUsers() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            seen.add(ExperimentAssignment.assign(UUID.randomUUID(), "exp1", VARIANTS));
        }
        assertThat(seen).containsExactlyInAnyOrder("control", "treatment");
    }
}
