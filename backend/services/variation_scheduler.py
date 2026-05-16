from __future__ import annotations

import random
from dataclasses import dataclass, replace
from enum import Enum
from typing import Protocol, Sequence


class TransitionType(str, Enum):
    CROSSFADE = "crossfade"


@dataclass(frozen=True, slots=True)
class LoopSegment:
    segment_id: str
    source_path: str
    loop_start_ms: int
    loop_end_ms: int
    canonical_duration_ms: int
    play_duration_ms: int
    crossfade_duration_ms: int
    trim_tail_ms: int
    raw_analyzer_score: float
    validator_score: float
    repetition_salience_score: float


@dataclass(frozen=True, slots=True)
class TransitionSpec:
    from_segment_id: str
    to_segment_id: str
    transition_type: TransitionType
    crossfade_duration_ms: int
    trim_tail_ms: int


@dataclass(frozen=True, slots=True)
class AssemblyPlan:
    segments: list[LoopSegment]
    transitions: list[TransitionSpec]
    total_duration_seconds: float
    final_trim_seconds: float


class VariationScheduler(Protocol):
    def schedule(
        self,
        segments: Sequence[LoopSegment],
        target_duration_seconds: float,
    ) -> AssemblyPlan:
        """
        Build an AssemblyPlan that satisfies four invariants:

        1. Every emitted segment must originate from the provided palette, and
           segment boundary coordinates must remain unchanged.
        2. Temporal jitter may only modify play_duration_ms; it must never move
           loop_start_ms or loop_end_ms.
        3. No segment_id may exceed max_consecutive_repeats when more than one
           unique segment is available.
        4. The assembled sequence must cover the target duration and report any
           overshoot as final_trim_seconds.
        """


class StochasticVariationScheduler:
    def __init__(
        self,
        *,
        max_consecutive_repeats: int = 2,
        salience_budget: float = 0.55,
        seed: int | None = None,
    ) -> None:
        if max_consecutive_repeats < 1:
            raise ValueError("max_consecutive_repeats must be at least 1")
        if not 0.0 <= salience_budget <= 1.0:
            raise ValueError("salience_budget must be within [0, 1]")

        self.max_consecutive_repeats = max_consecutive_repeats
        self.salience_budget = salience_budget
        self._rng = random.Random(seed)

    def estimate_perceptual_period(self, segment: LoopSegment) -> int:
        salience = min(max(segment.repetition_salience_score, 0.0), 1.0)
        base_duration_ms = max(1, segment.canonical_duration_ms)
        floor_ms = max(segment.crossfade_duration_ms * 2, int(base_duration_ms * 0.40))
        estimated_ms = int(round(base_duration_ms * (1.0 - 0.35 * salience)))
        return min(base_duration_ms, max(floor_ms, estimated_ms))

    def schedule(
        self,
        segments: Sequence[LoopSegment],
        target_duration_seconds: float,
    ) -> AssemblyPlan:
        if not segments:
            raise ValueError("segments must not be empty")
        if target_duration_seconds <= 0:
            raise ValueError("target_duration_seconds must be greater than zero")

        palette = list(segments)
        target_duration_ms = int(round(target_duration_seconds * 1000.0))
        scheduled_segments: list[LoopSegment] = []
        transitions: list[TransitionSpec] = []
        assembled_duration_ms = 0
        cumulative_salience = 0.0

        while assembled_duration_ms < target_duration_ms:
            candidate = self._select_next_segment(
                palette=palette,
                scheduled_segments=scheduled_segments,
                cumulative_salience=cumulative_salience,
            )

            jitter_factor = self._rng.uniform(0.60, 1.00)
            perceptual_floor_ms = self.estimate_perceptual_period(candidate)
            jittered_play_ms = int(round(candidate.canonical_duration_ms * jitter_factor))
            play_duration_ms = min(
                candidate.canonical_duration_ms,
                max(perceptual_floor_ms, jittered_play_ms),
            )

            scheduled_segment = replace(
                candidate,
                play_duration_ms=max(1, play_duration_ms),
                trim_tail_ms=max(0, candidate.canonical_duration_ms - max(1, play_duration_ms)),
            )

            if not scheduled_segments:
                assembled_duration_ms += scheduled_segment.play_duration_ms
            else:
                previous_segment = scheduled_segments[-1]
                crossfade_ms = min(
                    previous_segment.crossfade_duration_ms,
                    scheduled_segment.crossfade_duration_ms,
                    max(0, previous_segment.play_duration_ms - 1),
                    max(0, scheduled_segment.play_duration_ms - 1),
                )
                transitions.append(
                    TransitionSpec(
                        from_segment_id=previous_segment.segment_id,
                        to_segment_id=scheduled_segment.segment_id,
                        transition_type=TransitionType.CROSSFADE,
                        crossfade_duration_ms=max(0, crossfade_ms),
                        trim_tail_ms=0,
                    )
                )
                assembled_duration_ms += scheduled_segment.play_duration_ms - max(0, crossfade_ms)

            scheduled_segments.append(scheduled_segment)
            cumulative_salience += scheduled_segment.repetition_salience_score

        final_trim_ms = max(0, assembled_duration_ms - target_duration_ms)
        return AssemblyPlan(
            segments=scheduled_segments,
            transitions=transitions,
            total_duration_seconds=target_duration_seconds,
            final_trim_seconds=final_trim_ms / 1000.0,
        )

    def _select_next_segment(
        self,
        *,
        palette: Sequence[LoopSegment],
        scheduled_segments: Sequence[LoopSegment],
        cumulative_salience: float,
    ) -> LoopSegment:
        if len(palette) == 1:
            return palette[0]

        prev_segment_id = scheduled_segments[-1].segment_id if scheduled_segments else None
        repeat_count = 0
        if prev_segment_id is not None:
            for segment in reversed(scheduled_segments):
                if segment.segment_id != prev_segment_id:
                    break
                repeat_count += 1

        stratified_palettes = self._stratify_palette(palette)
        candidate_groups = self._ordered_candidate_groups(
            stratified_palettes=stratified_palettes,
            scheduled_segments=scheduled_segments,
            cumulative_salience=cumulative_salience,
        )

        for group in candidate_groups:
            repeat_safe = self._filter_repeat_violations(group, prev_segment_id, repeat_count, palette)
            budget_safe = [
                candidate
                for candidate in repeat_safe
                if self._fits_salience_budget(
                    scheduled_segments=scheduled_segments,
                    cumulative_salience=cumulative_salience,
                    candidate=candidate,
                )
            ]
            if budget_safe:
                return self._weighted_choice(budget_safe)
            if repeat_safe:
                return self._weighted_choice(repeat_safe)

        repeat_safe_full_palette = self._filter_repeat_violations(
            palette,
            prev_segment_id,
            repeat_count,
            palette,
        )
        if repeat_safe_full_palette:
            return self._weighted_choice(repeat_safe_full_palette)
        return self._weighted_choice(palette)

    def _stratify_palette(self, palette: Sequence[LoopSegment]) -> list[list[LoopSegment]]:
        ordered = sorted(palette, key=lambda segment: segment.repetition_salience_score)
        if len(ordered) <= 2:
            return [ordered[:], [], []]

        first_cut = max(1, len(ordered) // 3)
        second_cut = max(first_cut + 1, (2 * len(ordered)) // 3)
        return [
            ordered[:first_cut],
            ordered[first_cut:second_cut],
            ordered[second_cut:],
        ]

    def _ordered_candidate_groups(
        self,
        *,
        stratified_palettes: Sequence[Sequence[LoopSegment]],
        scheduled_segments: Sequence[LoopSegment],
        cumulative_salience: float,
    ) -> list[list[LoopSegment]]:
        non_empty = [list(group) for group in stratified_palettes if group]
        if not non_empty:
            return []
        if not scheduled_segments:
            return non_empty

        running_average_salience = cumulative_salience / max(1, len(scheduled_segments))
        if running_average_salience >= self.salience_budget:
            return sorted(non_empty, key=lambda group: sum(s.repetition_salience_score for s in group) / len(group))

        weighted_order = list(non_empty)
        self._rng.shuffle(weighted_order)
        weighted_order.sort(
            key=lambda group: sum(s.repetition_salience_score for s in group) / len(group)
        )
        return weighted_order

    def _filter_repeat_violations(
        self,
        group: Sequence[LoopSegment],
        previous_segment_id: str | None,
        repeat_count: int,
        full_palette: Sequence[LoopSegment],
    ) -> list[LoopSegment]:
        if previous_segment_id is None:
            return list(group)
        unique_ids = {segment.segment_id for segment in full_palette}
        if len(unique_ids) <= 1:
            return list(group)
        if repeat_count < self.max_consecutive_repeats:
            return list(group)
        filtered = [segment for segment in group if segment.segment_id != previous_segment_id]
        return filtered or list(group)

    def _fits_salience_budget(
        self,
        *,
        scheduled_segments: Sequence[LoopSegment],
        cumulative_salience: float,
        candidate: LoopSegment,
    ) -> bool:
        projected_count = len(scheduled_segments) + 1
        projected_average_salience = (cumulative_salience + candidate.repetition_salience_score) / projected_count
        return projected_average_salience <= self.salience_budget

    def _weighted_choice(self, candidates: Sequence[LoopSegment]) -> LoopSegment:
        weights = [max(1e-6, 1.0 - candidate.repetition_salience_score) for candidate in candidates]
        return self._rng.choices(list(candidates), weights=weights, k=1)[0]
