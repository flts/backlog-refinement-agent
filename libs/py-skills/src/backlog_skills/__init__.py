"""Parse and validate the Agent Skills in ``skills/`` and expose the default backlog guidance."""

from .catalog import (
    CHILD_TYPES,
    CORE_SKILL,
    DOCUMENT_FORMAT_RESOURCE,
    ITEM_TYPES,
    SKILLS_DIR_ENV,
    TEMPLATE_RESOURCE,
    DefaultGuidance,
    ItemType,
    Skill,
    SkillCatalog,
    SkillError,
    SkillsNotFoundError,
    load_skills,
    resolve_skills_root,
    type_skill_name,
)
from .templates import strip_hints, template_headings, validate_template

__all__ = [
    "CHILD_TYPES",
    "CORE_SKILL",
    "DOCUMENT_FORMAT_RESOURCE",
    "ITEM_TYPES",
    "SKILLS_DIR_ENV",
    "TEMPLATE_RESOURCE",
    "DefaultGuidance",
    "ItemType",
    "Skill",
    "SkillCatalog",
    "SkillError",
    "SkillsNotFoundError",
    "load_skills",
    "resolve_skills_root",
    "strip_hints",
    "template_headings",
    "type_skill_name",
    "validate_template",
]
