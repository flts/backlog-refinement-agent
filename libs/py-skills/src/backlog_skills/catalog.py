"""Discovery, parsing and validation of the Agent Skills in ``skills/`` (https://agentskills.io)."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Final, Literal, cast, get_args

import yaml

from .templates import validate_template

ItemType = Literal["capability", "feature", "user-story", "enabler"]
ITEM_TYPES: Final[tuple[ItemType, ...]] = get_args(ItemType)
CHILD_TYPES: Final[Mapping[ItemType, tuple[ItemType, ...]]] = MappingProxyType(
    {
        "capability": ("feature", "enabler"),
        "feature": ("user-story", "enabler"),
        "user-story": (),
        "enabler": (),
    }
)

SKILLS_DIR_ENV: Final = "BACKLOG_SKILLS_DIR"
SKILL_FILE: Final = "SKILL.md"
CORE_SKILL: Final = "backlog-refinement"
DOCUMENT_FORMAT_RESOURCE: Final = "references/document-format.md"
TEMPLATE_RESOURCE: Final = "assets/template.md"

_MAX_NAME_LENGTH: Final = 64
_MAX_DESCRIPTION_LENGTH: Final = 1024
_MAX_RESOURCE_DEPTH: Final = 3
_MAX_FILE_BYTES: Final = 1024 * 1024
_ALLOWED_FIELDS: Final = frozenset({"name", "description", "license", "compatibility", "metadata", "allowed-tools"})
_NAME_RE: Final = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VERSION_RE: Final = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
_FRONTMATTER_RE: Final = re.compile(r"\A\ufeff?---[ \t]*\r?\n(.*?)^---[ \t]*\r?$\n?", re.MULTILINE | re.DOTALL)


class SkillError(Exception):
    """A skill directory or ``SKILL.md`` file is missing, unsafe or invalid."""


class SkillsNotFoundError(SkillError):
    """The skills root directory could not be located."""


def type_skill_name(item_type: ItemType) -> str:
    """Name of the skill holding the instructions and template of a backlog item type."""
    return f"backlog-{_check_item_type(item_type)}"


@dataclass(frozen=True, slots=True)
class Skill:
    """One parsed skill: frontmatter, Markdown body and text resources (``references/``, ``assets/``, …)."""

    name: str
    description: str
    version: str
    metadata: Mapping[str, str]
    body: str
    path: Path
    resources: Mapping[str, str]

    def resource(self, name: str) -> str:
        """Return a resource by its POSIX path relative to the skill directory, e.g. ``assets/template.md``."""
        key = _normalize_resource_name(name)
        try:
            return self.resources[key]
        except KeyError:
            raise SkillError(f"Skill '{self.name}' has no resource '{name}'.") from None


@dataclass(frozen=True, slots=True)
class DefaultGuidance:
    """The default guidance shipped as skills; texts are trimmed like the SPA defaults."""

    principles: str
    document_format: str
    type_instructions: dict[ItemType, str]
    templates: dict[ItemType, str]
    versions: dict[str, str]
    """Skill name → ``metadata.version``; see :func:`type_skill_name` and :data:`CORE_SKILL`."""


class SkillCatalog(Mapping[str, Skill]):
    """Read-only mapping of skill name to :class:`Skill`, with typed accessors for backlog guidance."""

    def __init__(self, root: Path, skills: Mapping[str, Skill]) -> None:
        self._root = root
        self._skills = dict(skills)

    @property
    def root(self) -> Path:
        return self._root

    def __getitem__(self, name: str) -> Skill:
        try:
            return self._skills[name]
        except KeyError:
            raise SkillError(f"Skill '{name}' was not found in {self._root}.") from None

    def __iter__(self) -> Iterator[str]:
        return iter(self._skills)

    def __len__(self) -> int:
        return len(self._skills)

    def __contains__(self, name: object) -> bool:
        return name in self._skills

    def skill_dir(self, name: str) -> Path:
        return self[name].path

    def version(self, skill_name: str) -> str:
        return self[skill_name].version

    def principles(self) -> str:
        return self[CORE_SKILL].body.strip()

    def document_format(self) -> str:
        return self[CORE_SKILL].resource(DOCUMENT_FORMAT_RESOURCE).strip()

    def type_instructions(self, item_type: ItemType) -> str:
        return self[type_skill_name(item_type)].body.strip()

    def template(self, item_type: ItemType) -> str:
        skill = self[type_skill_name(item_type)]
        template = skill.resource(TEMPLATE_RESOURCE).strip()
        errors = validate_template(template)
        if errors:
            raise SkillError(f"Invalid template in skill '{skill.name}': {' '.join(errors)}")
        return template

    def default_guidance(self) -> DefaultGuidance:
        """Collect all default guidance; raises :class:`SkillError` if a required skill or resource is missing."""
        names = (CORE_SKILL, *(type_skill_name(item_type) for item_type in ITEM_TYPES))
        return DefaultGuidance(
            principles=self.principles(),
            document_format=self.document_format(),
            type_instructions={t: self.type_instructions(t) for t in ITEM_TYPES},
            templates={t: self.template(t) for t in ITEM_TYPES},
            versions={name: self.version(name) for name in names},
        )


def resolve_skills_root(root: Path | None = None) -> Path:
    """Locate the skills directory: explicit ``root``, ``$BACKLOG_SKILLS_DIR``, or the repository's ``skills/``."""
    if root is not None:
        return _existing_dir(Path(root), "The skills directory")
    configured = os.environ.get(SKILLS_DIR_ENV, "").strip()
    if configured:
        return _existing_dir(Path(configured), f"{SKILLS_DIR_ENV}")
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "skills"
        if candidate.is_dir() and any(candidate.glob(f"*/{SKILL_FILE}")):
            return candidate.resolve()
    raise SkillsNotFoundError(
        f"Could not locate the skills directory. Set {SKILLS_DIR_ENV} to the directory that contains "
        f"the */{SKILL_FILE} skills."
    )


def load_skills(root: Path | None = None) -> SkillCatalog:
    """Discover and parse ``<root>/*/SKILL.md``; see :func:`resolve_skills_root` for the default root.

    Symbolic links and paths outside the root are rejected. Call :meth:`SkillCatalog.default_guidance`
    at startup to also verify that all backlog guidance skills are present and valid.
    """
    base = resolve_skills_root(root)
    skills: dict[str, Skill] = {}
    for entry in sorted(base.iterdir()):
        if entry.name.startswith("."):
            continue
        _reject_unsafe(entry, base)
        if not entry.is_dir():
            continue
        skill_file = entry / SKILL_FILE
        if not skill_file.exists() and not skill_file.is_symlink():
            continue
        skill = _load_skill(entry, base)
        skills[skill.name] = skill
    if not skills:
        raise SkillError(f"No skills (*/{SKILL_FILE}) found in {base}.")
    return SkillCatalog(base, skills)


def _load_skill(directory: Path, base: Path) -> Skill:
    skill_file = directory / SKILL_FILE
    _reject_unsafe(skill_file, base)
    text = _read_text(skill_file)
    match = _FRONTMATTER_RE.match(text)
    if not match:
        raise SkillError(f"{skill_file}: missing YAML frontmatter delimited by '---' lines.")
    frontmatter = _parse_frontmatter(match.group(1), skill_file)

    name = _required_string(frontmatter, "name", skill_file)
    if len(name) > _MAX_NAME_LENGTH or not _NAME_RE.match(name):
        raise SkillError(
            f"{skill_file}: name '{name}' must be at most {_MAX_NAME_LENGTH} lowercase letters, digits and "
            "single hyphens, without a leading or trailing hyphen."
        )
    if name != directory.name:
        raise SkillError(f"{skill_file}: name '{name}' must match its directory name '{directory.name}'.")
    description = _required_string(frontmatter, "description", skill_file)
    if len(description) > _MAX_DESCRIPTION_LENGTH:
        raise SkillError(f"{skill_file}: description must be at most {_MAX_DESCRIPTION_LENGTH} characters.")
    metadata = _parse_metadata(frontmatter.get("metadata"), skill_file)
    version = metadata.get("version", "")
    if not _VERSION_RE.match(version):
        raise SkillError(f'{skill_file}: metadata.version must be a quoted semantic version such as "1.0.0".')

    return Skill(
        name=name,
        description=description,
        version=version,
        metadata=MappingProxyType(metadata),
        body=text[match.end() :].lstrip("\r\n"),
        path=directory,
        resources=MappingProxyType(_load_resources(directory, base)),
    )


def _parse_frontmatter(source: str, skill_file: Path) -> dict[str, object]:
    try:
        _reject_duplicate_keys(yaml.compose(source, Loader=yaml.SafeLoader), skill_file)
        data: object = yaml.safe_load(source)
    except yaml.YAMLError as error:
        raise SkillError(f"{skill_file}: invalid YAML frontmatter: {error}") from error
    if not isinstance(data, dict):
        raise SkillError(f"{skill_file}: frontmatter must be a YAML mapping.")
    fields = cast(dict[object, object], data)
    unknown = sorted(str(key) for key in fields if key not in _ALLOWED_FIELDS)
    if unknown:
        raise SkillError(
            f"{skill_file}: unsupported frontmatter field(s) {', '.join(unknown)}; "
            "put custom fields such as version under 'metadata'."
        )
    return {str(key): value for key, value in fields.items()}


def _reject_duplicate_keys(node: yaml.Node | None, skill_file: Path) -> None:
    if isinstance(node, yaml.MappingNode):
        seen: set[str] = set()
        for key_node, value_node in node.value:
            if isinstance(key_node, yaml.ScalarNode):
                key = str(key_node.value)
                if key in seen:
                    raise SkillError(f"{skill_file}: duplicate frontmatter key '{key}'.")
                seen.add(key)
            _reject_duplicate_keys(value_node, skill_file)
    elif isinstance(node, yaml.SequenceNode):
        for item in node.value:
            _reject_duplicate_keys(item, skill_file)


def _required_string(frontmatter: Mapping[str, object], field: str, skill_file: Path) -> str:
    value = frontmatter.get(field)
    if not isinstance(value, str) or not value.strip():
        raise SkillError(f"{skill_file}: '{field}' must be a non-empty string.")
    return value.strip()


def _parse_metadata(value: object, skill_file: Path) -> dict[str, str]:
    if not isinstance(value, dict):
        raise SkillError(f"{skill_file}: 'metadata' must be a mapping that contains 'version'.")
    metadata: dict[str, str] = {}
    for key, item in cast(dict[object, object], value).items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise SkillError(f"{skill_file}: metadata keys and values must be strings (quote '{key}').")
        metadata[key] = item
    return metadata


def _load_resources(directory: Path, base: Path) -> dict[str, str]:
    resources: dict[str, str] = {}

    def walk(current: Path, depth: int) -> None:
        for entry in sorted(current.iterdir()):
            if entry.name.startswith("."):
                continue
            _reject_unsafe(entry, base)
            if entry.is_dir():
                if depth >= _MAX_RESOURCE_DEPTH:
                    raise SkillError(f"{entry}: skill resources may be nested at most {_MAX_RESOURCE_DEPTH} levels.")
                walk(entry, depth + 1)
            elif entry.is_file() and not (current == directory and entry.name == SKILL_FILE):
                resources[entry.relative_to(directory).as_posix()] = _read_text(entry)

    walk(directory, 1)
    return resources


def _read_text(path: Path) -> str:
    if path.stat().st_size > _MAX_FILE_BYTES:
        raise SkillError(f"{path}: file is larger than {_MAX_FILE_BYTES} bytes.")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise SkillError(f"{path}: skill files must be UTF-8 text.") from error


def _reject_unsafe(path: Path, base: Path) -> None:
    if path.is_symlink():
        raise SkillError(f"{path}: symbolic links are not allowed in skills.")
    if not path.resolve().is_relative_to(base):
        raise SkillError(f"{path}: resolves outside the skills directory {base}.")


def _existing_dir(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_dir():
        raise SkillsNotFoundError(f"{label} '{path}' is not a directory.")
    return resolved


def _normalize_resource_name(name: str) -> str:
    candidate = PurePosixPath(name)
    if (
        "\\" in name
        or candidate.is_absolute()
        or not candidate.parts
        or any(part in ("", ".", "..") for part in candidate.parts)
    ):
        raise SkillError(f"Invalid resource name '{name}': use a relative path inside the skill directory.")
    return candidate.as_posix()


def _check_item_type(item_type: str) -> ItemType:
    if item_type not in ITEM_TYPES:
        raise ValueError(f"Unknown backlog item type '{item_type}'; expected one of {', '.join(ITEM_TYPES)}.")
    return cast(ItemType, item_type)
