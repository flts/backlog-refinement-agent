"""Programmatic alembic upgrades (startup auto-migrate and tests)."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

# Arbitrary constant key for pg_advisory_xact_lock, so concurrent replicas migrate one at a time.
_MIGRATION_LOCK_KEY = 0x6167656E746462  # "agentdb"


def alembic_config(alembic_ini: Path) -> Config:
    config = Config(str(alembic_ini))
    config.attributes["configure_logger"] = False
    return config


def _upgrade(connection: Connection, alembic_ini: Path, revision: str) -> None:
    config = alembic_config(alembic_ini)
    config.attributes["connection"] = connection
    command.upgrade(config, revision)


async def upgrade_database(engine: AsyncEngine, alembic_ini: Path, revision: str = "head") -> None:
    async with engine.begin() as connection:
        await connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _MIGRATION_LOCK_KEY})
        await connection.run_sync(_upgrade, alembic_ini, revision)
