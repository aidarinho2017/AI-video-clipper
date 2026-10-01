from pydantic import ValidationError

from ..models import ClipCandidate


def select(candidates: list, duration: float, minimum: int = 15, maximum: int = 30,
           limit: int = 5) -> list[ClipCandidate]:
    valid = []
    for value in candidates:
        try:
            clip = ClipCandidate.model_validate(value)
            if clip.end <= duration and minimum <= clip.end - clip.start <= maximum:
                valid.append(clip)
        except ValidationError:
            continue
    valid.sort(key=lambda c: (-c.virality_score, -c.standalone_score, -c.hook_score, c.start))
    selected = []
    for clip in valid:
        if all(clip.end <= other.start or clip.start >= other.end for other in selected):
            selected.append(clip)
        if len(selected) == limit:
            break
    return selected
