from pathlib import Path
import sqlite3
import json
import hashlib
from datetime import datetime


BASE_DIR = Path(__file__).resolve().parent.parent.parent
DB_PATH = BASE_DIR / "app.db"


def get_connection():
    return sqlite3.connect(DB_PATH)


def calculate_file_hash(file_path: str) -> str:
    # 원곡 파일 내용을 기준으로 SHA256 hash 생성
    hash_object = hashlib.sha256()

    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_object.update(chunk)

    return hash_object.hexdigest()


def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            original_file_path TEXT NOT NULL,
            user_file_path TEXT NOT NULL,
            session_dir TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS analysis_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            result_json_path TEXT NOT NULL,
            pipeline_status TEXT,
            pitch_score REAL,
            rhythm_score REAL,
            total_score REAL,
            feedback TEXT,
            original_hash TEXT,
            cache_status TEXT,
            cache_use_count INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS original_cache (
            original_hash TEXT PRIMARY KEY,
            original_file_path TEXT NOT NULL,
            cache_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            use_count INTEGER NOT NULL
        )
    """)

    conn.commit()
    conn.close()


def get_original_cache(original_hash: str) -> dict | None:
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            original_hash,
            original_file_path,
            cache_status,
            created_at,
            last_used_at,
            use_count
        FROM original_cache
        WHERE original_hash = ?
    """, (original_hash,))

    row = cursor.fetchone()
    conn.close()

    if row is None:
        return None

    return {
        "original_hash": row[0],
        "original_file_path": row[1],
        "cache_status": row[2],
        "created_at": row[3],
        "last_used_at": row[4],
        "use_count": row[5]
    }


def save_original_cache(
    original_hash: str,
    original_file_path: str
) -> int:
    conn = get_connection()
    cursor = conn.cursor()

    now = datetime.now().isoformat()

    cursor.execute("""
        INSERT OR REPLACE INTO original_cache (
            original_hash,
            original_file_path,
            cache_status,
            created_at,
            last_used_at,
            use_count
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        original_hash,
        original_file_path,
        "cached",
        now,
        now,
        1
    ))

    conn.commit()
    conn.close()

    return 1


def update_original_cache_usage(original_hash: str) -> int:
    conn = get_connection()
    cursor = conn.cursor()

    now = datetime.now().isoformat()

    cursor.execute("""
        UPDATE original_cache
        SET
            last_used_at = ?,
            use_count = use_count + 1
        WHERE original_hash = ?
    """, (
        now,
        original_hash
    ))

    conn.commit()

    cursor.execute("""
        SELECT use_count
        FROM original_cache
        WHERE original_hash = ?
    """, (original_hash,))

    row = cursor.fetchone()
    conn.close()

    if row is None:
        return 0

    return row[0]


def save_session_metadata(
    session_id: str,
    original_file_path: str,
    user_file_path: str,
    session_dir: str,
    status: str,
    created_at: str,
    completed_at: str | None = None
):
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        INSERT OR REPLACE INTO sessions (
            session_id,
            original_file_path,
            user_file_path,
            session_dir,
            status,
            created_at,
            completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id,
        original_file_path,
        user_file_path,
        session_dir,
        status,
        created_at,
        completed_at
    ))

    conn.commit()
    conn.close()


def save_analysis_result(
    session_id: str,
    session_dir: str,
    result_data: dict
):
    conn = get_connection()
    cursor = conn.cursor()

    result_path = Path(session_dir) / "result.json"

    result = result_data.get("result", {})
    pipeline_status = result_data.get("pipeline_status")
    cache = result_data.get("cache", {})

    cursor.execute("""
        INSERT INTO analysis_results (
            session_id,
            result_json_path,
            pipeline_status,
            pitch_score,
            rhythm_score,
            total_score,
            feedback,
            original_hash,
            cache_status,
            cache_use_count,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id,
        str(result_path),
        pipeline_status,
        result.get("pitch_score"),
        result.get("rhythm_score"),
        result.get("total_score"),
        result.get("feedback"),
        cache.get("original_hash"),
        cache.get("cache_status"),
        cache.get("use_count"),
        datetime.now().isoformat()
    ))

    conn.commit()
    conn.close()


def save_metadata_json(
    session_id: str,
    original_file_path: str,
    user_file_path: str,
    session_dir: str,
    status: str,
    created_at: str,
    completed_at: str | None = None,
    original_hash: str | None = None,
    cache_status: str | None = None,
    cache_use_count: int | None = None
):
    metadata_path = Path(session_dir) / "metadata.json"

    metadata = {
        "session_id": session_id,
        "original_file_path": original_file_path,
        "user_file_path": user_file_path,
        "session_dir": session_dir,
        "status": status,
        "created_at": created_at,
        "completed_at": completed_at,
        "cache": {
            "original_hash": original_hash,
            "cache_status": cache_status,
            "use_count": cache_use_count
        }
    }

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=4)

def get_latest_score(session_id: str):

    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            pitch_score,
            rhythm_score,
            total_score,
            feedback,
            cache_status,
            cache_use_count
        FROM analysis_results
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 1
    """, (session_id,))

    row = cursor.fetchone()

    conn.close()

    if row is None:
        return None

    return {
        "pitch_score": row[0],
        "rhythm_score": row[1],
        "total_score": row[2],
        "feedback": row[3],
        "cache_status": row[4],
        "cache_use_count": row[5]
    }