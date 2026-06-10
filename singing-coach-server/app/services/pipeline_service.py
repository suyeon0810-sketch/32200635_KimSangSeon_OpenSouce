from pathlib import Path
import sys
import json
from datetime import datetime


BASE_DIR = Path(__file__).resolve().parent.parent.parent
PROJECT_DIR = BASE_DIR.parent
PIPELINE_DIR = PROJECT_DIR / "opensource_pipeline"


def run_pipeline_from_server(
    session_id: str,
    original_file_path: str,
    user_file_path: str,
    session_dir: str
) -> dict:
    """
    서버에서 파이프라인을 호출하기 위한 연결 함수.
    파이프라인 코드는 수정하지 않고, 서버에서 import 가능한 함수만 사용한다.
    """

    session_path = Path(session_dir)

    result_data = {
        "session_id": session_id,
        "status": "completed",
        "pipeline_status": "pipeline_connected",
        "message": "서버에서 파이프라인 모듈 연결을 시도했습니다.",
        "created_at": datetime.now().isoformat(),

        "input_files": {
            "original_file": original_file_path,
            "user_file": user_file_path
        },

        "saved_files": [
            file.name for file in session_path.iterdir() if file.is_file()
        ],

        "result": {
            "pitch_score": 0,
            "rhythm_score": 0,
            "total_score": 0,
            "feedback": "파이프라인 연결 구조가 서버에 추가되었습니다."
        }
    }

    # 1. 파이프라인 폴더 존재 여부 확인
    if not PIPELINE_DIR.exists():
        result_data["pipeline_status"] = "pipeline_dir_not_found"
        result_data["message"] = "opensource_pipeline 폴더를 찾을 수 없습니다."
        return result_data

    # 2. 파이프라인 폴더를 import 경로에 추가
    if str(PIPELINE_DIR) not in sys.path:
        sys.path.append(str(PIPELINE_DIR))

    try:
        # 3. WavePipeline.py import 시도
        import WavePipeline

        result_data["pipeline_status"] = "pipeline_import_success"
        result_data["message"] = "WavePipeline.py import에 성공했습니다."

        # 4. 기존 파이프라인 함수 호출
        if hasattr(WavePipeline, "load_audio_from_path"):

            original_audio, original_sr = WavePipeline.load_audio_from_path(
                original_file_path
            )

            user_audio, user_sr = WavePipeline.load_audio_from_path(
                user_file_path
            )

            result_data["pipeline_status"] = "pipeline_audio_load_success"

            result_data["message"] = (
                "서버에서 파이프라인의 "
                "load_audio_from_path 함수를 호출했습니다."
            )

            result_data["audio_info"] = {
                "original_duration": round(
                    len(original_audio) / original_sr,
                    2
                ),

                "original_sample_rate": original_sr,

                "user_duration": round(
                    len(user_audio) / user_sr,
                    2
                ),

                "user_sample_rate": user_sr
            }

            result_data["result"]["feedback"] = (
                "서버와 파이프라인 연결이 완료되었고, "
                "업로드된 음성 파일을 "
                "파이프라인 함수로 읽는 데 성공했습니다."
            )

        else:
            result_data["pipeline_status"] = (
                "pipeline_function_not_found"
            )

            result_data["message"] = (
                "WavePipeline.py에 "
                "load_audio_from_path 함수가 없습니다."
            )

            result_data["result"]["feedback"] = (
                "파이프라인 담당자에게 "
                "서버 호출용 함수 제공을 요청해야 합니다."
            )

    except Exception as e:

        result_data["status"] = "failed"

        result_data["pipeline_status"] = "pipeline_error"

        result_data["message"] = (
            "파이프라인 연결 중 오류가 발생했습니다."
        )

        result_data["error_message"] = str(e)

        result_data["result"]["feedback"] = (
            "파이프라인 import 또는 함수 호출 중 오류가 발생했습니다."
        )

    return result_data


def save_pipeline_result(
    session_dir: str,
    result_data: dict
) -> None:
    """
    파이프라인 실행 결과를
    세션 디렉토리의 result.json에 저장한다.
    """

    result_path = Path(session_dir) / "result.json"

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(
            result_data,
            f,
            ensure_ascii=False,
            indent=4
        )