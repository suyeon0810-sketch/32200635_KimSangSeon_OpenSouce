from pathlib import Path
import sys
import json
from datetime import datetime


PIPELINE_DIR = Path("/mnt/d/opensoure/opensource_pipeline")


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
        # 3. WavePipelineServer.py import 시도
        import WavePipelineServer as WavePipeline

        result_data["pipeline_status"] = "pipeline_import_success"
        result_data["message"] = "WavePipelineServer.py import에 성공했습니다."

        # ──────────────────────────────────────────────────────
        # 4. run_analysis() 호출 (전체 파이프라인 실행 + JSON 반환)
        # ──────────────────────────────────────────────────────
        if hasattr(WavePipeline, "run_analysis"):

            analysis = WavePipeline.run_analysis(
                original_file_path,
                user_file_path,
                output_dir=session_dir
            )

            result_data["result"]        = analysis["result"]
            result_data["rhythm_data"]   = analysis.get("rhythm_data",   [])
            result_data["pitch_data"]    = analysis.get("pitch_data",    [])
            result_data["waveform_data"] = analysis.get("waveform_data", {})
            result_data["audio_info"]    = analysis.get("audio_info",    {})

            result_data["pipeline_status"] = "pipeline_analysis_complete"
            result_data["message"] = "파이프라인 전체 분석이 완료되었습니다."

        # ──────────────────────────────────────────────────────
        # (폴백) run_analysis 없으면 오디오 로드만
        # ──────────────────────────────────────────────────────
        elif hasattr(WavePipeline, "load_audio_from_path"):

            original_audio, original_sr = WavePipeline.load_audio_from_path(
                original_file_path
            )
            user_audio, user_sr = WavePipeline.load_audio_from_path(
                user_file_path
            )

            result_data["pipeline_status"] = "pipeline_audio_load_only"
            result_data["message"] = (
                "run_analysis 함수가 없어 오디오 로드만 완료했습니다."
            )
            result_data["audio_info"] = {
                "original_duration":    round(len(original_audio) / original_sr, 2),
                "original_sample_rate": original_sr,
                "user_duration":        round(len(user_audio)     / user_sr,     2),
                "user_sample_rate":     user_sr
            }
            result_data["result"]["feedback"] = (
                "파이프라인에 run_analysis 함수가 없습니다. "
                "WavePipelineServer.py를 최신 버전으로 교체해주세요."
            )

        else:
            result_data["pipeline_status"] = "pipeline_function_not_found"
            result_data["message"] = (
                "WavePipelineServer.py에 run_analysis 또는 "
                "load_audio_from_path 함수가 없습니다."
            )

    except Exception as e:

        result_data["status"] = "failed"
        result_data["pipeline_status"] = "pipeline_error"
        result_data["message"] = "파이프라인 연결 중 오류가 발생했습니다."
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

def run_pipeline_segment(
    original_file_path: str,
    practice_file_path: str,
    time_start: float,
    time_end: float,
    session_dir: str
) -> dict:
    """
    틀린 구간(time_start~time_end) 재녹음 분석.

    전략:
    1. result.json에서 원곡 pitch_data를 time_start~time_end 구간만 슬라이스
    2. 재녹음 파일에서 pYIN으로 직접 f0 추출 (전체 파이프라인 X)
    3. 원곡 슬라이스 + 재녹음 f0를 비교하여 cent_error 계산
    4. retryResult.json으로 저장 후 반환
    """
    import numpy as np
    import librosa

    session_path = Path(session_dir)

    # ── 1. result.json에서 원곡 pitch_data 슬라이스 ──────────────
    result_path = session_path / "result.json"
    if not result_path.exists():
        return {"status": "failed", "error_message": "result.json 없음"}

    with open(result_path, "r", encoding="utf-8") as f:
        full_result = json.load(f)

    all_pitch = full_result.get("pitch_data", [])
    orig_slice = [
        s for s in all_pitch
        if s.get("time", 0) >= time_start and s.get("time", 0) <= time_end
    ]

    if not orig_slice:
        return {"status": "failed", "error_message": "해당 구간 원곡 데이터 없음"}

    # ── 2. 재녹음 파일 로드 + zscore 정규화 ─────────────────────
    try:
        practice_audio, sr = librosa.load(practice_file_path, sr=None, mono=True)
    except Exception as e:
        return {"status": "failed", "error_message": f"재녹음 로드 실패: {e}"}

    std = np.std(practice_audio)
    if std > 0:
        practice_audio = (practice_audio - np.mean(practice_audio)) / std
    # ── 2-1. 앞뒤 무음 제거 ──────────────────────────────────────
    def trim_silence(audio, sr, threshold=0.02, frame_size=0.05):
        frame_samples = int(frame_size * sr)
        n_frames = len(audio) // frame_samples
        if n_frames == 0:
            return audio, 0

        start_idx = 0
        for i in range(n_frames):
            frame = audio[i*frame_samples:(i+1)*frame_samples]
            if np.sqrt(np.mean(frame ** 2)) > threshold:
                start_idx = i * frame_samples
                break
        else:
            return audio, 0  # 전부 무음이면 그대로 반환

        end_idx = len(audio)
        for i in range(n_frames - 1, -1, -1):
            frame = audio[i*frame_samples:(i+1)*frame_samples]
            if np.sqrt(np.mean(frame ** 2)) > threshold:
                end_idx = (i + 1) * frame_samples
                break

        trimmed_seconds = start_idx / sr
        return audio[start_idx:end_idx], trimmed_seconds

    practice_audio, trimmed_seconds = trim_silence(practice_audio, sr)

    # ── 3. 재녹음에서 pYIN으로 0.25초 구간별 f0 추출 ─────────────
    segment_duration = 0.25
    segment_samples = int(segment_duration * sr)
    n_segments = len(practice_audio) // segment_samples

    user_f0_list = []
    user_voiced_list = []

    for i in range(n_segments):
        seg = practice_audio[i * segment_samples: (i + 1) * segment_samples]
        rms_val = float(np.sqrt(np.mean(seg ** 2)))

        if rms_val < 0.05 or len(seg) < segment_samples // 2:
            user_f0_list.append(0.0)
            user_voiced_list.append(False)
            continue

        f0, voiced_flag, voiced_probs = librosa.pyin(
            seg,
            fmin=librosa.note_to_hz('C2'),
            fmax=librosa.note_to_hz('C7'),
            sr=sr
        )
        f0_valid = f0[voiced_flag & ~np.isnan(f0)]
        f0_rate = len(f0_valid) / len(f0) if len(f0) > 0 else 0.0
        f0_rep = float(np.median(f0_valid)) if len(f0_valid) > 0 else 0.0
        is_voiced = f0_rate >= 0.3 and 65 <= f0_rep <= 1047

        user_f0_list.append(f0_rep if is_voiced else 0.0)
        user_voiced_list.append(is_voiced)

    # ── 4. 원곡 슬라이스와 재녹음 f0 길이 맞추기 ─────────────────
    trim_offset_frames = int(round(trimmed_seconds / segment_duration))
    n = min(len(orig_slice) - trim_offset_frames, len(user_f0_list))
    n = max(n, 0)

    # ── 5. cent_error 계산 + pitch_data 빌드 ─────────────────────
    def hz_to_note(hz):
        if hz <= 0:
            return None
        try:
            return librosa.hz_to_note(hz)
        except Exception:
            return None

    retry_pitch_data = []
    for i in range(n):
        orig_seg = orig_slice[i + trim_offset_frames]
        f0_orig  = orig_seg.get("f0_orig") or 0.0
        vo       = orig_seg.get("voiced_orig", False)
        f0_user  = user_f0_list[i]
        vu       = user_voiced_list[i]
        t        = orig_seg.get("time", time_start + i * segment_duration)

        valid = vo and vu and f0_orig > 0 and f0_user > 0
        cent_error = None
        if valid:
            raw_cent = 1200 * float(np.log2(f0_user / f0_orig))

            # 옥타브 오류 보정: ±1옥타브, ±2옥타브 차이 시 보정
            for octave_shift in [0, 1200, -1200, 2400, -2400]:
                adjusted = raw_cent - octave_shift
                if abs(adjusted) <= 500:
                    cent_error = round(adjusted, 1)
                    break

            if cent_error is None:
                valid = False

        direction = None
        if cent_error is not None:
            direction = "accurate" if abs(cent_error) <= 50 else ("sharp" if cent_error > 0 else "flat")

        retry_pitch_data.append({
            "time":        round(float(t), 4),
            "f0_orig":     round(f0_orig, 2) if vo else None,
            "f0_user":     round(f0_user, 2) if vu else None,
            "voiced_orig": vo,
            "voiced_user": vu,
            "cent_error":  cent_error,
            "valid":       valid,
            "note_orig":   hz_to_note(f0_orig) if vo else None,
            "note_user":   hz_to_note(f0_user) if vu else None,
            "direction":   direction
        })

    # ── 6. 점수 계산 ──────────────────────────────────────────────
    valid_errors = [
        abs(s["cent_error"])
        for s in retry_pitch_data
        if s["valid"] and s["cent_error"] is not None
    ]
    if valid_errors:
        scores = [
            100 if e <= 50 else 70 if e <= 100 else 30 if e <= 200 else 0
            for e in valid_errors
        ]
        pitch_score = round(sum(scores) / len(scores), 1)
    else:
        pitch_score = 0.0

    # ── 7. retryResult.json 저장 ──────────────────────────────────
    retry_result = {
        "status":     "completed",
        "time_start": time_start,
        "time_end":   time_end,
        "pitch_data": retry_pitch_data,
        "result": {
            "pitch_score": pitch_score,
            "feedback":    f"재녹음 구간 음정 점수: {pitch_score}점"
        }
    }

    retry_path = session_path / f"retryResult_{int(time_start)}_{int(time_end)}.json"
    with open(retry_path, "w", encoding="utf-8") as f:
        json.dump(retry_result, f, ensure_ascii=False, indent=4)

    return retry_result