from __future__ import annotations

from backlog_skills import load_skills, template_headings, validate_template


def test_feature_template_headings() -> None:
    template = load_skills().template("feature")

    assert template_headings(template) == [
        "Summary",
        "Problem and outcome",
        "Beneficiaries",
        "Business value",
        "Scope",
        "Acceptance criteria",
        "Dependencies and constraints",
        "Assumptions",
        "Open questions",
    ]


def test_template_headings_ignore_hints_fenced_code_and_deeper_headings() -> None:
    template = "\n".join(
        [
            "# Title",
            "## First ##",
            "<!-- ## Hidden",
            "## Also hidden -->",
            "### Sub",
            "```markdown",
            "## In code",
            "```",
            "##   Second  ",
            "##NotAHeading",
        ]
    )

    assert template_headings(template) == ["First", "Second"]


def test_validate_template_rejects_placeholders() -> None:
    assert validate_template("# Feature\n\n## Summary\n") == []
    errors = validate_template("# Feature\n\n## Summary\n{{summary}}\n")

    assert len(errors) == 1
    assert errors[0].startswith("Line 4 ")
    assert "placeholder" in errors[0]
