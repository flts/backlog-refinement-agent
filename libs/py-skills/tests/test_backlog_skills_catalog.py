from __future__ import annotations

import os
from pathlib import Path

import pytest
from backlog_skills import (
    CHILD_TYPES,
    CORE_SKILL,
    ITEM_TYPES,
    SKILLS_DIR_ENV,
    SkillError,
    SkillsNotFoundError,
    load_skills,
    resolve_skills_root,
    template_headings,
    type_skill_name,
    validate_template,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = REPO_ROOT / "skills"
EXPECTED_SKILLS = {CORE_SKILL, *(type_skill_name(item_type) for item_type in ITEM_TYPES)}


def write_skill(root: Path, directory: str, frontmatter: str, body: str = "# Body\n") -> Path:
    skill_dir = root / directory
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(f"---\n{frontmatter}---\n\n{body}", encoding="utf-8")
    return skill_dir


VALID = 'name: demo\ndescription: Demo skill. Use in tests.\nmetadata:\n  version: "1.0.0"\n'


def test_repository_skills_parse_with_matching_names_and_versions() -> None:
    catalog = load_skills(SKILLS_ROOT)

    assert set(catalog) == EXPECTED_SKILLS
    for name, skill in catalog.items():
        assert skill.name == name == skill.path.name
        assert skill.description
        assert skill.version == "1.0.0"
        assert skill.body.startswith("# ")


def test_default_root_resolves_to_repository_skills(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SKILLS_DIR_ENV, raising=False)

    assert resolve_skills_root() == SKILLS_ROOT.resolve()
    assert set(load_skills()) == EXPECTED_SKILLS


def test_env_variable_overrides_default_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_skill(tmp_path, "demo", VALID)
    monkeypatch.setenv(SKILLS_DIR_ENV, str(tmp_path))

    assert set(load_skills()) == {"demo"}


def test_missing_env_directory_is_a_clear_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(SKILLS_DIR_ENV, str(tmp_path / "missing"))

    with pytest.raises(SkillsNotFoundError, match=SKILLS_DIR_ENV):
        load_skills()


def test_default_guidance_is_trimmed_skill_content() -> None:
    catalog = load_skills(SKILLS_ROOT)
    guidance = catalog.default_guidance()

    assert guidance.principles == catalog[CORE_SKILL].body.strip()
    assert "Child items" in guidance.document_format
    assert set(guidance.versions) == EXPECTED_SKILLS
    for item_type in ITEM_TYPES:
        template = SKILLS_ROOT / f"backlog-{item_type}" / "assets" / "template.md"
        assert guidance.templates[item_type] == template.read_text(encoding="utf-8").strip()
        assert guidance.type_instructions[item_type] == catalog[type_skill_name(item_type)].body.strip()
        assert guidance.type_instructions[item_type].startswith("# ")
        assert validate_template(guidance.templates[item_type]) == []
        assert {"Assumptions", "Open questions"} <= set(template_headings(guidance.templates[item_type]))


def test_typed_accessors() -> None:
    catalog = load_skills(SKILLS_ROOT)

    assert catalog.skill_dir("backlog-feature") == SKILLS_ROOT.resolve() / "backlog-feature"
    assert catalog.version("backlog-feature") == "1.0.0"
    assert catalog.type_instructions("user-story").startswith("# User Story Instructions")
    assert catalog.template("enabler").startswith("# Enabler")
    assert catalog.document_format().startswith("# Backlog Item Document Format")
    assert "references/document-format.md" in catalog[CORE_SKILL].description
    assert CHILD_TYPES["capability"] == ("feature", "enabler")
    with pytest.raises(ValueError, match="Unknown backlog item type"):
        catalog.template("epic")  # type: ignore[arg-type]
    with pytest.raises(SkillError, match="not found"):
        catalog.skill_dir("missing")


def test_resource_names_must_stay_inside_the_skill() -> None:
    skill = load_skills(SKILLS_ROOT)["backlog-feature"]

    assert skill.resource("assets/template.md").startswith("# Feature")
    for name in ("../backlog-enabler/assets/template.md", "/etc/passwd", "assets\\template.md", "missing.md"):
        with pytest.raises(SkillError):
            skill.resource(name)


@pytest.mark.parametrize(
    ("frontmatter", "message"),
    [
        ('name: other\ndescription: Demo.\nmetadata:\n  version: "1.0.0"\n', "must match its directory"),
        ('name: Demo\ndescription: Demo.\nmetadata:\n  version: "1.0.0"\n', "lowercase"),
        ('name: demo\ndescription: "  "\nmetadata:\n  version: "1.0.0"\n', "'description' must be a non-empty"),
        ('name: demo\nmetadata:\n  version: "1.0.0"\n', "'description' must be a non-empty"),
        ("name: demo\ndescription: Demo.\n", "'metadata' must be a mapping"),
        ("name: demo\ndescription: Demo.\nmetadata:\n  owner: me\n", "metadata.version"),
        ("name: demo\ndescription: Demo.\nmetadata:\n  version: 1.0\n", "must be strings"),
        ('name: demo\ndescription: Demo.\nversion: "1.0.0"\nmetadata:\n  version: "1.0.0"\n', "unsupported"),
        ('name: demo\nname: demo\ndescription: Demo.\nmetadata:\n  version: "1.0.0"\n', "duplicate"),
        ("name: [demo\n", "invalid YAML"),
        ("- demo\n", "must be a YAML mapping"),
    ],
)
def test_invalid_frontmatter_is_rejected(tmp_path: Path, frontmatter: str, message: str) -> None:
    write_skill(tmp_path, "demo", frontmatter)

    with pytest.raises(SkillError, match=message):
        load_skills(tmp_path)


def test_missing_frontmatter_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "SKILL.md").write_text("# No frontmatter\n", encoding="utf-8")

    with pytest.raises(SkillError, match="missing YAML frontmatter"):
        load_skills(tmp_path)


def test_empty_root_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(SkillError, match="No skills"):
        load_skills(tmp_path)


def test_resources_are_loaded_with_posix_names(tmp_path: Path) -> None:
    skill_dir = write_skill(tmp_path, "demo", VALID)
    (skill_dir / "references").mkdir()
    (skill_dir / "references" / "guide.md").write_text("Guide", encoding="utf-8")

    skill = load_skills(tmp_path)["demo"]

    assert dict(skill.resources) == {"references/guide.md": "Guide"}
    assert skill.body == "# Body\n"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_symlinked_skill_directory_is_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    write_skill(outside, "demo", VALID)
    root = tmp_path / "skills"
    root.mkdir()
    (root / "demo").symlink_to(outside / "demo", target_is_directory=True)

    with pytest.raises(SkillError, match="symbolic links"):
        load_skills(root)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_symlinked_skill_file_is_rejected(tmp_path: Path) -> None:
    secret = tmp_path / "secret.md"
    secret.write_text(f"---\n{VALID}---\nsecret", encoding="utf-8")
    root = tmp_path / "skills"
    (root / "demo").mkdir(parents=True)
    (root / "demo" / "SKILL.md").symlink_to(secret)

    with pytest.raises(SkillError, match="symbolic links"):
        load_skills(root)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_symlinked_resource_is_rejected(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("secret", encoding="utf-8")
    root = tmp_path / "skills"
    skill_dir = write_skill(root, "demo", VALID)
    (skill_dir / "assets").mkdir()
    (skill_dir / "assets" / "template.md").symlink_to(secret)

    with pytest.raises(SkillError, match="symbolic links"):
        load_skills(root)
