"""
db.py — SQLAlchemy engine and table definitions for the Render Postgres database.

Reads the connection string from the DATABASE_URL environment variable
(Render sets this automatically when a web service and a Postgres instance
are linked; a local `.env` can set it for development — see .env.example).
"""

import os

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import (
    Column, Integer, MetaData, Table, Text, TIMESTAMP, create_engine, func,
)
from sqlalchemy.dialects.postgresql import JSONB

load_dotenv()


def _normalize_url(url: str) -> str:
    """Render (like Heroku) hands out `postgres://` URLs; SQLAlchemy's
    psycopg2 dialect requires the `postgresql://` scheme."""
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


def get_engine():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Point it at your Render Postgres "
            "instance (Dashboard → your database → Connections → "
            "Internal/External Database URL)."
        )
    return create_engine(_normalize_url(url), pool_pre_ping=True)


metadata = MetaData()

schedule_shifts = Table(
    "schedule_shifts", metadata,
    Column("id", Integer, primary_key=True),
    Column("day_type", Text, nullable=False),
    Column("team", Text, nullable=False),
    Column("role_type", Text, nullable=False),
    Column("role_detail", Text),
    Column("start_time", Text, nullable=False),
    Column("end_time", Text, nullable=False),
)

pipeline_outputs = Table(
    "pipeline_outputs", metadata,
    Column("key", Text, primary_key=True),
    Column("payload", JSONB, nullable=False),
    Column("generated_at", TIMESTAMP(timezone=True),
           server_default=func.now(), nullable=False),
)


def init_schema(engine) -> None:
    """Create the tables if they don't already exist (idempotent)."""
    metadata.create_all(engine)


def read_schedule_df(engine):
    """Full schedule_shifts table, including role_detail, as a DataFrame."""
    return pd.read_sql_table("schedule_shifts", engine)
