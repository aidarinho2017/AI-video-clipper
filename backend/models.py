from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Score = Annotated[int, Field(strict=True, ge=0, le=100, description="0 = absent/weak, 100 = exceptional")]


class ClipCandidate(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False, str_strip_whitespace=True)
    start: float = Field(ge=0, description="Absolute seconds from the beginning of the source")
    end: float = Field(gt=0, description="Absolute seconds from the beginning of the source")
    title: str = Field(min_length=1, max_length=180)
    hook_score: Score
    emotion_score: Score
    standalone_score: Score
    insight_score: Score
    virality_score: Score
    reasoning: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def duration_is_valid(self):
        if not 15 <= self.end - self.start <= 30:
            raise ValueError("Clips must last 15–30 seconds")
        return self


class CandidateResponse(BaseModel):
    candidates: list[ClipCandidate]


class JobRequest(BaseModel):
    youtube_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(default="gemini-fast", min_length=1, max_length=80)
    instructions: str = Field(default="", max_length=2000)


class TranscriptSegment(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False, str_strip_whitespace=True)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1)

    @model_validator(mode="after")
    def timestamps_are_valid(self):
        if self.end <= self.start:
            raise ValueError("Transcript segment must end after it starts")
        return self


class TranscriptResponse(BaseModel):
    segments: list[TranscriptSegment]


class EditorModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)


class UploadSource(EditorModel):
    kind: Literal["upload"]
    id: UUID


class JobSource(EditorModel):
    kind: Literal["job"]
    job_id: UUID


EditorSource = Annotated[UploadSource | JobSource, Field(discriminator="kind")]


class VideoTransform(EditorModel):
    scale: float = Field(default=1, ge=1, le=3)
    position_x: float = Field(default=0, ge=-1, le=1)
    position_y: float = Field(default=0, ge=-1, le=1)


class VideoSegment(EditorModel):
    id: UUID
    source: EditorSource
    source_start: float = Field(ge=0)
    source_end: float = Field(gt=0)
    transform: VideoTransform = Field(default_factory=VideoTransform)

    @model_validator(mode="after")
    def duration_is_valid(self):
        if self.source_end - self.source_start < 0.5:
            raise ValueError("Segments must be at least 0.5 seconds long")
        return self


class Caption(EditorModel):
    id: UUID
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)
    position_x: float = Field(default=0.5, ge=0.05, le=0.95)
    position_y: float = Field(default=0.82, ge=0.05, le=0.95)

    @model_validator(mode="after")
    def duration_is_valid(self):
        if self.end - self.start < 0.1:
            raise ValueError("Captions must be at least 0.1 seconds long")
        return self


class CaptionStyle(EditorModel):
    preset: Literal["classic", "box", "yellow"] = "classic"
    font_size: int = Field(default=36, ge=16, le=72)


class AudioSettings(EditorModel):
    volume: float = Field(default=1, ge=0, le=1)
    muted: bool = False


class EditorExportRequest(EditorModel):
    segments: list[VideoSegment] = Field(min_length=1, max_length=100)
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    captions: list[Caption] = Field(default_factory=list, max_length=500)
    caption_style: CaptionStyle = Field(default_factory=CaptionStyle)
    audio: AudioSettings = Field(default_factory=AudioSettings)

    @model_validator(mode="after")
    def timeline_is_valid(self):
        duration = sum(segment.source_end - segment.source_start for segment in self.segments)
        previous_end = 0.0
        for caption in self.captions:
            if caption.start < previous_end:
                raise ValueError("Captions must be ordered and cannot overlap")
            if caption.end > duration:
                raise ValueError("Caption exceeds the edited timeline")
            previous_end = caption.end
        return self


class PipelineError(Exception):
    """An actionable message safe to display in the interface."""
