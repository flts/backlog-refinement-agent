# Backlog guidance skills

These [Agent Skills](https://agentskills.io) are the single source of the **default guidance** for backlog refinement. `backlog-api` uses them for default templates and to compute a project's effective guidance (project override, else skill default). `agent-service` loads the same directories as skills for the agent. Both read them through the shared Python package [`libs/py-skills`](../libs/py-skills) (`backlog_skills`), which validates them.

## Structure

```text
skills/
├─ backlog-refinement/                core principles (SKILL.md body)
│  └─ references/document-format.md   document, section-update, checklist, quality and child-item rules
├─ backlog-capability/   SKILL.md (type instructions) + assets/template.md
├─ backlog-feature/      SKILL.md (type instructions) + assets/template.md
├─ backlog-user-story/   SKILL.md (type instructions) + assets/template.md
└─ backlog-enabler/      SKILL.md (type instructions) + assets/template.md
```

Each `SKILL.md` starts with YAML frontmatter:

```yaml
---
name: backlog-feature          # lowercase-hyphen, equal to the directory name
description: "What the skill contains and when to use it."
metadata:
  version: "1.0.0"             # quoted semantic version
---
```

The Markdown body follows the frontmatter. Templates (`assets/template.md`) are placeholder-free Markdown (no `{{…}}`); their `##` headings define the sections of an item document, and HTML comments are hints for the agent. Symbolic links are not allowed.

Until the web app is switched to the backend, the same texts also live in `apps/web/src/defaults/`; the `backlog_skills` tests check that the two stay identical, so change both together.

## Versioning

- Bump `metadata.version` whenever you change a skill's content (body, references or template): patch for wording, minor for added guidance or sections, major for changes that break existing documents (for example renamed or removed template headings).
- Project overrides record the `base_skill_version` they were edited from, so the settings screen can show "differs from skill default vX" and owners can compare with or reset to the current default.

## Checks

```sh
uv run --package backlog-skills pytest libs/py-skills -q
```

Services locate this directory through `BACKLOG_SKILLS_DIR`; in a development checkout it is found automatically.
