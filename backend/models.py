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
        if not 15 <= self.end - self.start <= 90:
            raise ValueError("Clips must last 15–90 seconds")
        return self


class CandidateResponse(BaseModel):
    candidates: list[ClipCandidate]


class JobRequest(BaseModel):
    youtube_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(default="gemini-fast", min_length=1, max_length=80)
    instructions: str = Field(default="", max_length=2000)
    clip_length: Literal["short", "medium", "long"] = "short"
    clip_count: Literal[1, 3, 5, 10] = 5


class GoogleCredential(BaseModel):
    credential: str = Field(min_length=100, max_length=10000)


class MediaTokenRequest(BaseModel):
    path: str = Field(min_length=1, max_length=500, pattern=r"^/")


class CheckoutRequest(BaseModel):
    plan: Literal["starter", "pro", "studio"]


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


class ClipAudioSettings(EditorModel):
    volume: float = Field(default=1, ge=0, le=1)
    muted: bool = False
    fade_in: float = Field(default=0, ge=0, le=5)
    fade_out: float = Field(default=0, ge=0, le=5)


class VideoSegment(EditorModel):
    id: UUID
    source: EditorSource
    source_start: float = Field(ge=0)
    source_end: float = Field(gt=0)
    transition_duration: float = Field(default=0, ge=0, le=1.5)
    transform: VideoTransform = Field(default_factory=VideoTransform)
    audio: ClipAudioSettings = Field(default_factory=ClipAudioSettings)

    @model_validator(mode="after")
    def duration_is_valid(self):
        if self.source_end - self.source_start < 0.5:
            raise ValueError("Segments must be at least 0.5 seconds long")
        if self.audio.fade_in + self.audio.fade_out > self.source_end - self.source_start:
            raise ValueError("Audio fades cannot exceed the segment duration")
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


class AudioClip(EditorModel):
    id: UUID
    source: UploadSource
    timeline_start: float = Field(ge=0)
    source_start: float = Field(ge=0)
    source_end: float = Field(gt=0)
    audio: ClipAudioSettings = Field(default_factory=ClipAudioSettings)

    @model_validator(mode="after")
    def duration_is_valid(self):
        duration = self.source_end - self.source_start
        if duration < 0.1:
            raise ValueError("Audio clips must be at least 0.1 seconds long")
        if self.audio.fade_in + self.audio.fade_out > duration:
            raise ValueError("Audio fades cannot exceed the clip duration")
        return self


class AudioTrack(EditorModel):
    id: UUID
    name: str = Field(min_length=1, max_length=200)
    clips: list[AudioClip] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def clips_do_not_overlap(self):
        previous_end = 0.0
        for clip in sorted(self.clips, key=lambda value: value.timeline_start):
            if clip.timeline_start < previous_end:
                raise ValueError("Audio clips on the same track cannot overlap")
            previous_end = clip.timeline_start + clip.source_end - clip.source_start
        return self


class EditorExportRequest(EditorModel):
    segments: list[VideoSegment] = Field(min_length=1, max_length=100)
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    captions: list[Caption] = Field(default_factory=list, max_length=500)
    caption_style: CaptionStyle = Field(default_factory=CaptionStyle)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    audio_tracks: list[AudioTrack] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def timeline_is_valid(self):
        if self.segments[0].transition_duration:
            raise ValueError("The first segment cannot have a transition")
        for index, segment in enumerate(self.segments[1:], 1):
            transition = segment.transition_duration
            if 0 < transition < 0.1:
                raise ValueError("Transitions must be at least 0.1 seconds long")
            previous = self.segments[index - 1]
            limit = min(1.5, (previous.source_end - previous.source_start) / 2,
                        (segment.source_end - segment.source_start) / 2)
            if transition > limit:
                raise ValueError("Transition is too long for its adjacent segments")
        duration = sum(segment.source_end - segment.source_start - segment.transition_duration
                       for segment in self.segments)
        if sum(len(track.clips) for track in self.audio_tracks) > 100:
            raise ValueError("Audio projects can contain at most 100 standalone clips")
        for track in self.audio_tracks:
            for clip in track.clips:
                if clip.timeline_start >= duration:
                    raise ValueError("Audio clip starts after the video timeline ends")
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
