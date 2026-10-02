from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    gemini_api_key: SecretStr = SecretStr("")
    anthropic_api_key: SecretStr = SecretStr("")
    openai_api_key: SecretStr = SecretStr("")
    google_client_id: str = ""
    auth_secret: SecretStr = SecretStr("")
    auth_cookie_secure: bool = False
    max_video_seconds: int = Field(default=7200, ge=75)
    max_upload_bytes: int = Field(default=2_147_483_648, gt=0)
    data_dir: Path = ROOT / "data"


settings = Settings()
