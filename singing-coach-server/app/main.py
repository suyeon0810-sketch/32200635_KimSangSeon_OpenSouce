from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from dataclasses import dataclass, asdict
from datetime import datetime
from app.services.pipeline_service import (
    run_pipeline_from_server,
    save_pipeline_result
)
from app.services.db_service import (
    init_db,
    calculate_file_hash,
    get_original_cache,
    save_original_cache,
    update_original_cache_usage,
    save_session_metadata,
    save_analysis_result,
    save_metadata_json
)

import uuid
import shutil
import queue
import threading
import json

app = FastAPI()

# 클라이언트 HTML/JS에서 접근 가능하게 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent.parent
SESSION_DIR = BASE_DIR / "sessions"

# StaticFiles 연결 전에 sessions 디렉토리 생성
SESSION_DIR.mkdir(
    parents=True,
    exist_ok=True
)

# 세션 디렉토리 안의 이미지, 결과 파일을 URL로 접근 가능하게 제공
app.mount(
    "/sessions",
    StaticFiles(directory=SESSION_DIR),
    name="sessions"
)

# 분석 작업을 저장하는 JobQueue 생성
job_queue = queue.Queue()

# session_id별 작업 상태를 저장하는 딕셔너리
job_status = {}

# 여러 worker thread가 동시에 job_status를 수정할 때 충돌 방지
job_lock = threading.Lock()


@dataclass
class AnalysisJob:
    session_id: str
    original_file_path: str
    user_file_path: str
    session_dir: str
    status: str = "queued"
    created_at: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    error_message: str | None = None
    original_hash: str | None = None
    cache_status: str | None = None
    cache_use_count: int | None = None


def update_job_status(session_id: str, **kwargs):
    # session_id에 해당하는 작업 상태를 안전하게 수정
    with job_lock:
        if session_id in job_status:
            for key, value in kwargs.items():
                setattr(job_status[session_id], key, value)


def get_visualization_urls(session_id: str) -> dict:
    # 클라이언트가 사용할 수 있는 시각화 자료 URL 생성
    session_path = SESSION_DIR / session_id

    pitch_path = session_path / "pitch.png"
    rhythm_path = session_path / "rhythm.png"

    return {
        "pitch": (
            f"/sessions/{session_id}/pitch.png"
            if pitch_path.exists()
            else None
        ),
        "rhythm": (
            f"/sessions/{session_id}/rhythm.png"
            if rhythm_path.exists()
            else None
        )
    }


def make_client_result_response(
    session_id: str,
    status: str,
    saved_files: list[str],
    result_data: dict | None = None,
    job: AnalysisJob | None = None
) -> dict:
    # 수연 클라이언트에서 바로 사용하기 위한 통일된 결과 응답 구조 생성

    if result_data is None:
        result_data = {}

    result = result_data.get("result", {})
    cache = result_data.get("cache", {})

    if job is not None and not cache:
        cache = {
            "original_hash": job.original_hash,
            "cache_status": job.cache_status,
            "use_count": job.cache_use_count
        }

    return {
        "session_id": session_id,
        "status": status,
        "scores": {
            "pitch_score": result.get("pitch_score", 0),
            "rhythm_score": result.get("rhythm_score", 0),
            "total_score": result.get("total_score", 0)
        },
        "feedback": result.get("feedback"),
        "pitch_data": result_data.get("pitch_data", []),
        "rhythm_data": result_data.get("rhythm_data", []),
        "visualization_urls": result_data.get(
            "visualization_urls",
            get_visualization_urls(session_id)
        ),
        "pipeline_status": result_data.get("pipeline_status"),
        "audio_info": result_data.get("audio_info"),
        "cache": cache,
        "saved_files": saved_files,
        "job": asdict(job) if job is not None else None
    }


def process_analysis_job(job: AnalysisJob):

    try:
        # 1. 작업 상태를 processing으로 변경
        update_job_status(
            job.session_id,
            status="processing",
            started_at=datetime.now().isoformat()
        )

        print(f"[Worker] 분석 시작: {job.session_id}")

        # 2. 서버에서 파이프라인 연결 함수 호출
        result_data = run_pipeline_from_server(
            session_id=job.session_id,
            original_file_path=job.original_file_path,
            user_file_path=job.user_file_path,
            session_dir=job.session_dir
        )

        # 3. 원곡 캐시 정보를 분석 결과에 추가
        result_data["cache"] = {
            "original_hash": job.original_hash,
            "cache_status": job.cache_status,
            "use_count": job.cache_use_count
        }

        # 4. 클라이언트 전달용 시각화 URL 추가
        result_data["visualization_urls"] = get_visualization_urls(
            job.session_id
        )

        # 5. 파이프라인 연결 결과를 result.json으로 저장
        save_pipeline_result(
            session_dir=job.session_dir,
            result_data=result_data
        )

        # 6. 분석 결과를 DB에 저장
        save_analysis_result(
            session_id=job.session_id,
            session_dir=job.session_dir,
            result_data=result_data
        )

        # 7. cache_miss인 경우 원곡 캐시 정보를 DB에 저장
        if job.cache_status == "cache_miss":
            cache_use_count = save_original_cache(
                original_hash=job.original_hash,
                original_file_path=job.original_file_path
            )

            job.cache_status = "cache_miss_saved"
            job.cache_use_count = cache_use_count

            result_data["cache"] = {
                "original_hash": job.original_hash,
                "cache_status": job.cache_status,
                "use_count": job.cache_use_count
            }

            result_data["visualization_urls"] = get_visualization_urls(
                job.session_id
            )

            save_pipeline_result(
                session_dir=job.session_dir,
                result_data=result_data
            )

        # 8. 파이프라인 연결 실패 시 예외 발생
        if result_data.get("status") == "failed":
            raise Exception(
                result_data.get(
                    "error_message",
                    "파이프라인 연결 실패"
                )
            )

        completed_at = datetime.now().isoformat()

        # 9. 작업 상태를 completed로 변경
        update_job_status(
            job.session_id,
            status="completed",
            completed_at=completed_at,
            cache_status=job.cache_status,
            cache_use_count=job.cache_use_count
        )

        # 10. 완료된 세션 정보를 metadata.json과 DB에 다시 저장
        save_metadata_json(
            session_id=job.session_id,
            original_file_path=job.original_file_path,
            user_file_path=job.user_file_path,
            session_dir=job.session_dir,
            status="completed",
            created_at=job.created_at,
            completed_at=completed_at,
            original_hash=job.original_hash,
            cache_status=job.cache_status,
            cache_use_count=job.cache_use_count
        )

        save_session_metadata(
            session_id=job.session_id,
            original_file_path=job.original_file_path,
            user_file_path=job.user_file_path,
            session_dir=job.session_dir,
            status="completed",
            created_at=job.created_at,
            completed_at=completed_at
        )

        print(f"[Worker] 분석 완료: {job.session_id}")

    except Exception as e:

        failed_at = datetime.now().isoformat()

        # 11. 분석 실패 시 failed 상태로 변경
        update_job_status(
            job.session_id,
            status="failed",
            error_message=str(e),
            completed_at=failed_at
        )

        # 12. 실패한 세션 정보를 metadata.json과 DB에 저장
        save_metadata_json(
            session_id=job.session_id,
            original_file_path=job.original_file_path,
            user_file_path=job.user_file_path,
            session_dir=job.session_dir,
            status="failed",
            created_at=job.created_at,
            completed_at=failed_at,
            original_hash=job.original_hash,
            cache_status=job.cache_status,
            cache_use_count=job.cache_use_count
        )

        save_session_metadata(
            session_id=job.session_id,
            original_file_path=job.original_file_path,
            user_file_path=job.user_file_path,
            session_dir=job.session_dir,
            status="failed",
            created_at=job.created_at,
            completed_at=failed_at
        )

        print(
            f"[Worker] 분석 실패: "
            f"{job.session_id}, error={e}"
        )


def worker_loop():
    # Worker Thread가 JobQueue에서 작업을 하나씩 꺼내 처리
    while True:

        job = job_queue.get()

        if job is None:
            break

        process_analysis_job(job)

        job_queue.task_done()


@app.on_event("startup")
def startup_event():

    # 서버 시작 시 sessions 디렉토리 생성
    SESSION_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    # 서버 시작 시 DB 테이블 생성
    init_db()

    # 서버 시작 시 Worker Thread 생성
    worker_count = 2

    for i in range(worker_count):

        worker = threading.Thread(
            target=worker_loop,
            daemon=True,
            name=f"analysis-worker-{i + 1}"
        )

        worker.start()

    print(
        f"[Server] "
        f"Worker Thread {worker_count}개 실행 완료"
    )


@app.get("/")
def root():

    return {
        "message": "Singing Coach Server is running"
    }


@app.post("/upload")
async def upload_files(
    original_file: UploadFile = File(...),
    user_file: UploadFile = File(...)
):

    # 1. 세션 ID 생성
    session_id = str(uuid.uuid4())

    # 2. 세션 디렉토리 생성
    current_session_dir = SESSION_DIR / session_id

    current_session_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    # 3. 저장 경로 생성
    original_path = (
        current_session_dir /
        original_file.filename
    )

    user_path = (
        current_session_dir /
        user_file.filename
    )

    # 4. 원곡 파일 저장
    with open(original_path, "wb") as buffer:

        shutil.copyfileobj(
            original_file.file,
            buffer
        )

    # 5. 사용자 녹음 파일 저장
    with open(user_path, "wb") as buffer:

        shutil.copyfileobj(
            user_file.file,
            buffer
        )

    # 6. 원곡 파일 hash 생성
    original_hash = calculate_file_hash(str(original_path))

    # 7. 원곡 캐시 조회
    cached_original = get_original_cache(original_hash)

    if cached_original is None:
        cache_status = "cache_miss"
        cache_use_count = 0
    else:
        cache_status = "cache_hit"
        cache_use_count = update_original_cache_usage(original_hash)

    # 8. 분석 작업 Job 생성
    job = AnalysisJob(
        session_id=session_id,
        original_file_path=str(original_path),
        user_file_path=str(user_path),
        session_dir=str(current_session_dir),
        status="queued",
        created_at=datetime.now().isoformat(),
        original_hash=original_hash,
        cache_status=cache_status,
        cache_use_count=cache_use_count
    )

    # 9. 작업 상태 저장
    with job_lock:
        job_status[session_id] = job

    # 10. 세션 정보를 metadata.json과 DB에 저장
    save_metadata_json(
        session_id=session_id,
        original_file_path=str(original_path),
        user_file_path=str(user_path),
        session_dir=str(current_session_dir),
        status="queued",
        created_at=job.created_at,
        original_hash=original_hash,
        cache_status=cache_status,
        cache_use_count=cache_use_count
    )

    save_session_metadata(
        session_id=session_id,
        original_file_path=str(original_path),
        user_file_path=str(user_path),
        session_dir=str(current_session_dir),
        status="queued",
        created_at=job.created_at
    )

    # 11. JobQueue에 분석 작업 추가
    job_queue.put(job)

    # 12. 클라이언트에게 결과 반환
    return {
        "message": (
            "파일 업로드 성공. "
            "분석 작업이 JobQueue에 등록되었습니다."
        ),

        "session_id": session_id,
        "status": "queued",

        "original_file": str(original_path),
        "user_file": str(user_path),

        "cache": {
            "original_hash": original_hash,
            "cache_status": cache_status,
            "use_count": cache_use_count
        }
    }


@app.get("/result/{session_id}")
def get_result(session_id: str):
    # 1. session_id에 해당하는 세션 폴더 경로 만들기
    session_path = SESSION_DIR / session_id

    # 2. 해당 세션 폴더가 없으면 404 에러 반환
    if not session_path.exists():

        raise HTTPException(
            status_code=404,
            detail=(
                "해당 session_id를 가진 "
                "세션이 존재하지 않습니다."
            )
        )

    # 3. 세션 폴더 안의 파일 목록 확인
    saved_files = [
        file.name
        for file in session_path.iterdir()
        if file.is_file()
    ]

    # 4. result.json이 있으면 실제 저장된 결과 반환
    result_path = session_path / "result.json"

    if result_path.exists():

        with open(
            result_path,
            "r",
            encoding="utf-8"
        ) as f:

            result_data = json.load(f)

        return make_client_result_response(
            session_id=session_id,
            status=result_data.get("status", "completed"),
            saved_files=saved_files,
            result_data=result_data
        )

    # 5. session_id에 해당하는 작업 상태 확인
    with job_lock:
        job = job_status.get(session_id)

    if job is None:

        raise HTTPException(
            status_code=404,
            detail=(
                "해당 session_id의 "
                "작업 상태를 찾을 수 없습니다."
            )
        )

    # 6. 분석 실패 상태이면 failed 응답 반환
    if job.status == "failed":

        return {
            "session_id": session_id,
            "status": "failed",
            "error_message": job.error_message,
            "saved_files": saved_files,
            "cache": {
                "original_hash": job.original_hash,
                "cache_status": job.cache_status,
                "use_count": job.cache_use_count
            },
            "job": asdict(job)
        }

    # 7. 아직 분석이 끝나지 않았으면 현재 상태 반환
    return make_client_result_response(
        session_id=session_id,
        status=job.status,
        saved_files=saved_files,
        job=job
    )