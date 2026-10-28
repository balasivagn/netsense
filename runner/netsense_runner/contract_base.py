"""Strict base for schema-generated models; JSON inputs never coerce strings to numbers."""

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
