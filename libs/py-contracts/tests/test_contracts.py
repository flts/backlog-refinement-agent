from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from backlog_contracts import (
    CONTRACT_MODELS,
    AgentState,
    AskUserArgs,
    ChildLastApply,
    ContractsNotFoundError,
    DocumentLastApply,
    ForwardedProps,
    ProposeDocumentChangesArgs,
    RunErrorCode,
    load_schema,
    resolve_contracts_root,
    schema_names,
)
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import ValidationError

CONTRACTS = resolve_contracts_root()
FIXTURES = CONTRACTS / "fixtures" / "tools"


def _fixtures(*kinds: str) -> list[Any]:
    return list(_iter_fixtures(*kinds))


def _iter_fixtures(*kinds: str) -> Iterator[Any]:
    for contract_dir in sorted(FIXTURES.iterdir()):
        for kind in kinds:
            for path in sorted((contract_dir / kind).glob("*.json")):
                yield pytest.param(contract_dir.name, path, id=f"{contract_dir.name}/{kind}/{path.stem}")


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(contract: str) -> Draft202012Validator:
    return Draft202012Validator(load_schema(contract), format_checker=Draft202012Validator.FORMAT_CHECKER)


def _parse(contract: str, data: Any) -> Any:
    model = CONTRACT_MODELS[contract]
    if model is RunErrorCode:
        return RunErrorCode(data)
    return model.model_validate(data)


def test_every_schema_is_valid_draft_2020_12_and_has_a_model_and_fixtures() -> None:
    names = schema_names()
    assert set(names) == set(CONTRACT_MODELS)
    assert {p.name for p in FIXTURES.iterdir()} == set(names)
    for name in names:
        schema = load_schema(name)
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as error:  # pragma: no cover - failure path
            pytest.fail(f"{name}: {error.message}")
        assert schema["$id"].endswith(f"/{name}.schema.json")
        assert schema["title"]
        assert schema["description"]


@pytest.mark.parametrize(("contract", "path"), _fixtures("valid"))
def test_valid_fixture_matches_schema_and_model(contract: str, path: Path) -> None:
    data = _load(path)
    assert list(_validator(contract).iter_errors(data)) == []
    parsed = _parse(contract, data)
    if hasattr(parsed, "to_wire"):
        # Round trip: the wire form of the model validates against the schema again.
        assert list(_validator(contract).iter_errors(parsed.to_wire())) == []


@pytest.mark.parametrize(("contract", "path"), _fixtures("invalid"))
def test_invalid_fixture_fails_schema_and_model(contract: str, path: Path) -> None:
    data = _load(path)
    assert list(_validator(contract).iter_errors(data)), "JSON Schema accepted an invalid fixture"
    with pytest.raises((ValidationError, ValueError)):
        _parse(contract, data)


@pytest.mark.parametrize(("contract", "path"), _fixtures("semantic-invalid"))
def test_semantic_invalid_fixture_passes_schema_but_fails_model(contract: str, path: Path) -> None:
    data = _load(path)
    assert list(_validator(contract).iter_errors(data)) == []
    with pytest.raises(ValidationError):
        _parse(contract, data)


def _properties(schema: dict[str, Any]) -> set[str]:
    return set(schema.get("properties", {}))


@pytest.mark.parametrize("contract", [n for n, m in CONTRACT_MODELS.items() if m is not RunErrorCode])
def test_model_fields_and_required_agree_with_schema(contract: str) -> None:
    schema = load_schema(contract)
    model = CONTRACT_MODELS[contract]
    fields = model.model_fields
    aliases = {f.alias or name for name, f in fields.items()}
    assert aliases == _properties(schema)
    required = {f.alias or name for name, f in fields.items() if f.is_required()}
    assert required == set(schema.get("required", []))
    expect_extra = schema.get("additionalProperties", True)
    assert (model.model_config.get("extra") != "forbid") == (expect_extra is not False)


def test_json_schema_generated_from_models_has_same_enums_and_limits() -> None:
    generated = AskUserArgs.model_json_schema(by_alias=True)
    question = generated["$defs"]["AskUserQuestion"]["properties"]
    assert question["header"]["maxLength"] == 24
    assert question["options"]["maxItems"] == 4 and question["options"]["minItems"] == 1
    assert question["recommended"]["anyOf"][0]["maximum"] == 3
    published = load_schema("ask-user.args")["properties"]["questions"]
    assert (published["minItems"], published["maxItems"]) == (1, 3)
    section = ProposeDocumentChangesArgs.model_json_schema(by_alias=True)["$defs"]["SectionChange"]["properties"]
    published_section = load_schema("propose-document-changes.args")["properties"]["sections"]["items"]
    assert section["mode"]["enum"] == published_section["properties"]["mode"]["enum"]


def test_run_error_codes_enum_matches_schema() -> None:
    assert [c.value for c in RunErrorCode] == load_schema("run-error-codes")["enum"]
    assert RunErrorCode.normalize("ValueError") is RunErrorCode.INTERNAL
    assert RunErrorCode.normalize("RATE_LIMITED") is RunErrorCode.RATE_LIMITED
    assert RunErrorCode.normalize(None) is RunErrorCode.INTERNAL


def test_state_initial_has_preview_null_and_camel_case_wire_form() -> None:
    wire = AgentState.initial("p1", "i1", "feature").to_wire()
    assert wire == {"schemaVersion": 1, "projectId": "p1", "itemId": "i1", "itemType": "feature", "preview": None}
    assert list(_validator("agent-state").iter_errors(wire)) == []
    assert "itemType" not in AgentState.initial("p1", "i1").to_wire()


def test_last_apply_variant_is_chosen_by_key_presence_and_round_trips() -> None:
    base = {"schemaVersion": 1, "projectId": "p", "itemId": "i", "preview": None}
    for name, variant in (("last-apply-document", DocumentLastApply), ("last-apply-children", ChildLastApply)):
        wire = _load(FIXTURES / "agent-state" / "valid" / f"{name}.json")
        state = AgentState.model_validate(wire)
        assert isinstance(state.last_apply, variant)
        assert state.to_wire() == wire
    assert AgentState.model_validate({**base, "lastApply": None}).last_apply is None


def test_snake_case_names_are_accepted_too() -> None:
    state = AgentState.model_validate({"schema_version": 1, "project_id": "p", "item_id": "i", "preview": None})
    assert state.project_id == "p"


def test_forwarded_props_length_guard() -> None:
    assert ForwardedProps(intent="refine").to_wire() == {"intent": "refine"}
    with pytest.raises(ValidationError):
        ForwardedProps.model_validate({"intent": "refine", "note": "x"})


def test_loader_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ContractsNotFoundError):
        load_schema("nope")
    with pytest.raises(ContractsNotFoundError):
        load_schema("../agent-state")
    with pytest.raises(ContractsNotFoundError):
        resolve_contracts_root(tmp_path)
    monkeypatch.setenv("BACKLOG_CONTRACTS_DIR", str(CONTRACTS))
    assert resolve_contracts_root() == CONTRACTS
    monkeypatch.setenv("BACKLOG_CONTRACTS_DIR", str(tmp_path))
    with pytest.raises(ContractsNotFoundError):
        resolve_contracts_root()
