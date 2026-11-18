"""Convert database connection strings to SQLAlchemy asyncpg URLs.

Accepted inputs:

* URIs: ``postgres://``, ``postgresql://`` and ``postgresql+<driver>://`` (for example
  ``DATABASE_URL`` or Aspire's ``<NAME>_URI``).
* ADO.NET/Npgsql key-value strings as injected by Aspire in ``ConnectionStrings__<name>``, for example
  ``Host=localhost;Port=5432;Username=postgres;Password=secret;Database=backlogdb``.

The result is a :class:`sqlalchemy.URL` object, so credentials never have to be rendered or escaped by hand.
"""

from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy.engine import URL, make_url

ASYNC_DRIVER = "postgresql+asyncpg"

_URI_SCHEMES = ("postgres://", "postgresql://", "postgresql+")

_KEY_ALIASES: Mapping[str, str] = {
    "host": "host",
    "server": "host",
    "port": "port",
    "username": "username",
    "user": "username",
    "userid": "username",
    "uid": "username",
    "username(userid)": "username",
    "password": "password",
    "pwd": "password",
    "database": "database",
    "db": "database",
    "initialcatalog": "database",
    "sslmode": "ssl",
    "ssl": "ssl",
    "targetsessionattributes": "target_session_attrs",
}

_SSL_MODES: Mapping[str, str] = {
    "disable": "disable",
    "allow": "allow",
    "prefer": "prefer",
    "require": "require",
    "verifyca": "verify-ca",
    "verify-ca": "verify-ca",
    "verifyfull": "verify-full",
    "verify-full": "verify-full",
}

# Query parameters that the SQLAlchemy asyncpg dialect forwards to ``asyncpg.connect``.
_ASYNCPG_QUERY_KEYS = frozenset({"ssl", "target_session_attrs"})


def to_async_database_url(value: str) -> URL:
    """Return an asyncpg URL for a URI or an ADO.NET-style key-value connection string."""
    raw = value.strip()
    if not raw:
        raise ValueError("The database connection string is empty.")
    if raw.lower().startswith(_URI_SCHEMES):
        return _from_uri(raw)
    if "=" in raw:
        return _from_key_value(raw)
    raise ValueError("Unsupported database connection string format; expected a postgresql:// URI or Host=...;")


def _from_uri(raw: str) -> URL:
    try:
        url = make_url(raw)
    except Exception as exc:  # sqlalchemy raises ArgumentError with the full value; do not echo credentials
        raise ValueError("The database URL could not be parsed.") from exc
    backend = url.drivername.split("+", 1)[0]
    if backend not in {"postgres", "postgresql"}:
        raise ValueError(f"Unsupported database backend '{backend}'; only PostgreSQL is supported.")
    query: dict[str, str] = {}
    for key, raw_value in url.query.items():
        item = raw_value[-1] if isinstance(raw_value, tuple) else raw_value
        normalized_key = "ssl" if key.lower() == "sslmode" else key.lower()
        if normalized_key == "ssl":
            query["ssl"] = _ssl_mode(item)
        elif normalized_key in _ASYNCPG_QUERY_KEYS:
            query[normalized_key] = item
    return url.set(drivername=ASYNC_DRIVER, query=query)


def _from_key_value(raw: str) -> URL:
    values: dict[str, str] = {}
    for key, item in _parse_key_value(raw).items():
        canonical = _KEY_ALIASES.get(key.replace(" ", "").replace("_", "").lower())
        if canonical is not None:
            values[canonical] = item
    host = values.get("host", "").strip()
    if not host:
        raise ValueError("The database connection string has no Host.")
    if "," in host:
        raise ValueError("Multiple hosts in the database connection string are not supported.")
    port: int | None = None
    if values.get("port"):
        try:
            port = int(values["port"])
        except ValueError as exc:
            raise ValueError("The database connection string has an invalid Port.") from exc
    query: dict[str, str] = {}
    if values.get("ssl"):
        query["ssl"] = _ssl_mode(values["ssl"])
    if values.get("target_session_attrs"):
        query["target_session_attrs"] = values["target_session_attrs"].lower()
    return URL.create(
        drivername=ASYNC_DRIVER,
        username=values.get("username") or None,
        password=values.get("password") or None,
        host=host,
        port=port,
        database=values.get("database") or None,
        query=query,
    )


def _ssl_mode(value: str) -> str:
    mode = _SSL_MODES.get(value.strip().lower())
    if mode is None:
        raise ValueError(f"Unsupported SSL mode '{value}'.")
    return mode


def _parse_key_value(raw: str) -> dict[str, str]:
    """Parse ``key=value;key="quoted;value"`` pairs (Npgsql syntax, quotes doubled to escape)."""
    result: dict[str, str] = {}
    index, length = 0, len(raw)
    while index < length:
        while index < length and raw[index] in " \t\r\n;":
            index += 1
        if index >= length:
            break
        equals = raw.find("=", index)
        if equals == -1:
            raise ValueError("Malformed database connection string: expected key=value pairs.")
        key = raw[index:equals].strip().lower()
        if not key:
            raise ValueError("Malformed database connection string: empty key.")
        index = equals + 1
        while index < length and raw[index] in " \t":
            index += 1
        if index < length and raw[index] in "\"'":
            quote = raw[index]
            index += 1
            chars: list[str] = []
            while True:
                if index >= length:
                    raise ValueError("Malformed database connection string: unterminated quoted value.")
                char = raw[index]
                if char == quote:
                    if index + 1 < length and raw[index + 1] == quote:
                        chars.append(quote)
                        index += 2
                        continue
                    index += 1
                    break
                chars.append(char)
                index += 1
            while index < length and raw[index] != ";":
                if not raw[index].isspace():
                    raise ValueError("Malformed database connection string: text after a quoted value.")
                index += 1
            value = "".join(chars)
        else:
            end = raw.find(";", index)
            end = length if end == -1 else end
            value = raw[index:end].strip()
            index = end
        result[key] = value
    return result
