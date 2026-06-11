"""
=============================================================
Vocal Coaching Pipeline - Step 1
로컬 검증용 (추후 서버 수신 로직으로 교체 예정)
=============================================================
현재:  로컬 파일 경로에서 음성 파일 읽기
추후:  서버에서 패킷으로 수신한 바이트 스트림으로 교체
       → load_audio_from_path() 를 load_audio_from_bytes() 로 교체하면 됨

[Step 1 범위]
  - 오디오 파일 로드
  - Demucs 보컬 분리 (MR / 노이즈 제거)
  - 전처리 전/후 파형(시간 도메인) 시각화
  - 전처리 전/후 재생

[Step 1 범위 외 → 추후 단계]
  - STFT / 스펙트로그램       : Step 3 (f0 추출 시 사용)
  - DTW 정렬                  : Step 2 (두 신호 비교 시작 시점)
  - f0 추출 / 음정 오차 계산  : Step 3
  - Onset 검출 / 박자 오차    : Step 2
  - 점수 계산 / 피드백 생성   : Step 4
=============================================================
"""

from cProfile import label

from cProfile import label

from librosa.feature.spectral import rms
import numpy as np
import librosa
import subprocess
import os
import sys
import tempfile
import time

# =============================================================
# GUI / 오디오 재생 패키지 (로컬 실행 시에만 사용)
# 서버 환경에서는 설치되지 않아도 정상 동작
# =============================================================
_GUI_AVAILABLE = False
try:
    import matplotlib.pyplot as plt
    import matplotlib.gridspec as gridspec
    import matplotlib.animation as animation
    import matplotlib.font_manager as fm
    import sounddevice as sd
    _GUI_AVAILABLE = True
except ImportError:
    pass

# =============================================================
# [교체 포인트] 서버 연동 시 이 부분을 패킷 수신 로직으로 교체
# =============================================================
ORIGINAL_PATH = "original.wav"   # 원곡 파일 경로
USER_PATH = "user.wav"       # 사용자 녹음 파일 경로
# =============================================================

# Windows 한글 폰트 설정 (로컬에서만 적용)
if _GUI_AVAILABLE:
    plt.rcParams['font.family'] = 'Malgun Gothic'  # 맑은 고딕
    plt.rcParams['axes.unicode_minus'] = False      # 마이너스 기호 깨짐 방지


def load_audio_from_path(path: str) -> tuple[np.ndarray, int]:
    """
    로컬 파일에서 오디오 로드.
    [교체 포인트] 서버 연동 시 아래 시그니처로 교체:
        def load_audio_from_bytes(data: bytes) -> tuple[np.ndarray, int]
    """
    audio, sr = librosa.load(path, sr=None, mono=True)
    return audio, sr


def separate_vocals_demucs(path: str) -> tuple[np.ndarray, int]:
    """
    Demucs로 보컬 분리 (MR / 노이즈 제거).
    분리된 vocals 트랙만 반환.
    """
    print(f"  Demucs 처리 중: {path}")

    with tempfile.TemporaryDirectory() as tmpdir:
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems", "vocals",
            "-o", tmpdir,
            path
        ]
        result = subprocess.run(cmd, capture_output=False, text=True)

        if result.returncode != 0:
            raise RuntimeError(f"Demucs 실패 (returncode={result.returncode})")

        separated_path = None
        for root, dirs, files in os.walk(tmpdir):
            for f in files:
                if "vocals" in f and "no_vocals" not in f and f.endswith(".wav"):
                    separated_path = os.path.join(root, f)
                    break

        if separated_path is None:
            raise FileNotFoundError("Demucs 출력에서 vocals 파일을 찾을 수 없음")

        audio, sr = librosa.load(separated_path, sr=None, mono=True)

    return audio, sr


def auto_k_threshold(energy_diff: np.ndarray) -> float:
    """
    에너지 분포를 보고 k_threshold 자동 결정.
    에너지 변화가 균일하면 낮게, 불균일하면 높게 설정.
    """
    # 변동계수(CV) = 표준편차 / 평균
    # CV가 크면 에너지 분포가 불균일 → threshold 높여야 함
    # CV가 작으면 에너지 분포가 균일 → threshold 낮게 해도 됨
    cv = np.std(energy_diff) / (np.mean(energy_diff) + 1e-8)

    # CV 범위에 따라 k 자동 결정
    if cv < 1.0:
        return 1.5   # 균일한 신호 → 낮은 threshold
    elif cv < 2.0:
        return 2.0
    elif cv < 3.0:
        return 2.5
    else:
        return 3.0   # 불균일한 신호 → 높은 threshold


def filter_user_onsets_by_orig(
    orig_times: np.ndarray,
    user_times: np.ndarray, user_energies: np.ndarray,
    max_dist: float = 0.3,
) -> tuple[np.ndarray, np.ndarray]:
    """
    원곡 Onset과 거리 기반으로 사용자 Onset 필터링.
    어떤 원곡 Onset과도 max_dist 이상 떨어진 사용자 Onset 제거.
    노이즈성 Onset 제거 목적.
    """
    filtered_times = []
    filtered_energies = []

    for i, ut in enumerate(user_times):
        min_dist = np.min(np.abs(orig_times - ut))
        if min_dist <= max_dist:
            filtered_times.append(ut)
            filtered_energies.append(user_energies[i])

    filtered_times = np.array(filtered_times)
    filtered_energies = np.array(filtered_energies)
    print(f"  사용자 Onset 필터링: {len(user_times)}개 → {len(filtered_times)}개")
    return filtered_times, filtered_energies

# ─────────────────────────────────────────────────────────────
# Step 2-1: 정규화
# ─────────────────────────────────────────────────────────────


def trim_and_match_length(
    original: np.ndarray, original_sr: int,
    user: np.ndarray,     user_sr: int,
) -> tuple[np.ndarray, np.ndarray]:
    """
    무음 구간 제거 후 짧은 쪽 길이에 맞춰 자름.
    두 신호의 시작/끝 위치를 통일.
    """
    # 무음 구간 제거
    original_trimmed, _ = librosa.effects.trim(original, top_db=20)
    user_trimmed,     _ = librosa.effects.trim(user,     top_db=20)

    # 샘플 수 기준으로 짧은 쪽에 맞춤
    min_len = min(len(original_trimmed), len(user_trimmed))
    original_trimmed = original_trimmed[:min_len]
    user_trimmed = user_trimmed[:min_len]

    print(f"  정규화 후 길이: {min_len / original_sr:.2f}초")
    return original_trimmed, user_trimmed


def zscore_normalize(audio: np.ndarray) -> np.ndarray:
    """
    Z-score 정규화로 에너지(음성 크기) 정규화.
    이상치(헛기침 등)에 강함.
    평균=0, 표준편차=1로 변환.
    """
    mean = np.mean(audio)
    std = np.std(audio)
    if std < 1e-8:  # 무음에 가까운 신호 방지
        return audio
    return (audio - mean) / std

# ─────────────────────────────────────────────────────────────
# Step 2-2: Onset 검출
# ─────────────────────────────────────────────────────────────


def extract_f0_with_confidence(
    audio: np.ndarray, sr: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    pYIN으로 f0 추출 + 신뢰도 점수 반환.
    신뢰도 낮은 구간은 이후 DTW 비용함수에서 f0 항목 제외.
    """
    f0, voiced_flag, voiced_probs = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz('C2'),  # 약 65Hz, 남성 최저음
        fmax=librosa.note_to_hz('C7'),  # 약 2093Hz, 여성 최고음
        sr=sr
    )
    # NaN → 0으로 처리
    f0 = np.nan_to_num(f0, nan=0.0)
    return f0, voiced_flag, voiced_probs


def detect_onsets(
    audio: np.ndarray, sr: int,
    f0: np.ndarray,
    hop_length: int = 512,
) -> tuple[np.ndarray, np.ndarray]:
    """
    f0의 진폭 변화 + 주파수 인덱스 변화를 기반으로 Onset 검출.
    Adaptive Threshold: 주변 구간 평균 + k * 표준편차.

    반환:
        onset_times   : Onset 발생 시점 (초 단위)
        onset_energies: 각 Onset의 에너지 변화량 (Z-score 정규화됨)
    """
    # RMS 에너지 계산 (프레임별 전체 에너지)
    # f0 빈 하나만 보는 기존 방식보다 안정적이고 두 파일에 동일한 기준 적용
    rms = librosa.feature.rms(y=audio, hop_length=hop_length)[0]

    # f0 유성음 구간 가중치
    # f0가 있는 구간(실제 음정 발화) = 1.0
    # f0가 없는 구간(묵음/노이즈)   = 0.3 (완전히 죽이지 않고 약하게 반영)
    f0_weight = np.where(
        (np.arange(len(rms)) < len(f0)) & (f0[:len(rms)] > 0),
        1.0,
        0.3
    )

    frame_energies = rms * f0_weight

    # 이전 프레임 대비 에너지 변화량 (Half-wave Rectification 적용)
    # 에너지가 증가하는 구간만 취함 (감소는 무시)
    energy_diff = np.diff(frame_energies, prepend=0)
    energy_diff = np.maximum(energy_diff, 0)  # Half-wave Rectification

    # Adaptive Threshold 계산
    # 윈도우 크기: 전후 20프레임 (약 0.2초)
    window = 20
    local_median = np.array([
        np.median(energy_diff[max(0, i-window):i+window])
        for i in range(len(energy_diff))
    ])
    local_std = np.array([
        np.std(energy_diff[max(0, i-window):i+window])
        for i in range(len(energy_diff))
    ])
    k = auto_k_threshold(energy_diff)
    threshold = local_median + k * local_std

    # 임계값 초과 구간 = Onset 후보
    onset_frames = np.where(energy_diff > threshold)[0]

    # 너무 가까운 Onset 제거 (최소 간격: 100ms)
    min_gap = int(0.1 * sr / hop_length)
    filtered_frames = []
    last_frame = -min_gap
    for f in onset_frames:
        if f - last_frame >= min_gap:
            filtered_frames.append(f)
            last_frame = f

    filtered_frames = np.array(filtered_frames)

    # 프레임 → 시간(초) 변환
    onset_times = librosa.frames_to_time(
        filtered_frames, sr=sr, hop_length=hop_length)
    onset_energies = energy_diff[filtered_frames] if len(
        filtered_frames) > 0 else np.array([])

    print(f"  Onset 검출 수: {len(onset_times)}개")
    return onset_times, onset_energies


def filter_silent_onsets(
    orig_times:     np.ndarray, orig_energies:    np.ndarray,
    user_times:     np.ndarray, user_energies:    np.ndarray,
    original_norm:  np.ndarray, original_sr:      int,
    rms_threshold:  float = 0.05,
    hop_length:     int = 512,
    match_dist:     float = 0.3,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    원곡 RMS 에너지 기준으로 묵음 구간 Onset 제거.
    원곡이 묵음인 구간의 Onset 제거 + 매칭 가능한 사용자 Onset도 함께 제거.
    Z-score 정규화된 신호 기준: RMS가 rms_threshold 이하 = 묵음 판단.
    """
    # 원곡 RMS 계산
    orig_rms = librosa.feature.rms(y=original_norm, hop_length=hop_length)[0]

    def is_silent(time_sec: float) -> bool:
        frame = librosa.time_to_frames(
            time_sec, sr=original_sr, hop_length=hop_length)
        frame = min(frame, len(orig_rms) - 1)
        return orig_rms[frame] < rms_threshold

    # 원곡 묵음 Onset 제거
    orig_mask = np.array([not is_silent(t) for t in orig_times])
    silent_orig_times = orig_times[~orig_mask]  # 제거된 원곡 onset 시점들

    orig_times_f = orig_times[orig_mask]
    orig_energies_f = orig_energies[orig_mask]

    # 제거된 원곡 onset 근처 사용자 onset도 제거
    user_mask = np.ones(len(user_times), dtype=bool)
    for st in silent_orig_times:
        for j, ut in enumerate(user_times):
            if abs(ut - st) <= match_dist:
                user_mask[j] = False

    user_times_f = user_times[user_mask]
    user_energies_f = user_energies[user_mask]

    print(f"  묵음 필터링: 원곡 {len(orig_times)}→{len(orig_times_f)}개, "
          f"사용자 {len(user_times)}→{len(user_times_f)}개")

    return orig_times_f, orig_energies_f, user_times_f, user_energies_f

# ─────────────────────────────────────────────────────────────
# Step 2-3: DTW 기반 Onset 매칭 + 박자 오차
# ─────────────────────────────────────────────────────────────


def match_onsets_dtw(
    orig_times:    np.ndarray, orig_energies:    np.ndarray,
    user_times:    np.ndarray, user_energies:    np.ndarray,
    orig_f0:       np.ndarray, user_f0:          np.ndarray,
    orig_sr:       int,
    alpha: float = 0.6,   # 시간 가중치
    beta:  float = 0.2,   # 에너지 가중치
    gamma: float = 0.2,   # 음정 가중치
    max_match_dist: float = 0.3,  # 매칭 허용 최대 시간 오차 (초)

) -> tuple[list, list]:
    """
    Onset 시점 리스트끼리 DTW로 매칭.
    비용함수: α*|시간차| + β*|에너지차| + γ*|f0차|

    반환:
        matched_pairs : [(orig_time, user_time, time_diff_ms), ...]
        unmatched_orig: 매칭 안 된 원곡 onset → "박자 탈락"으로 처리
    """
    n = len(orig_times)
    m = len(user_times)

    if n == 0 or m == 0:
        print("  경고: Onset이 검출되지 않은 파일이 있습니다.")
        return [], []

    # 에너지 정규화 (0~1 범위로 스케일링, 비교를 위해)
    def safe_norm(arr):
        rng = arr.max() - arr.min()
        return (arr - arr.min()) / rng if rng > 1e-8 else np.zeros_like(arr)

    orig_e_norm = safe_norm(orig_energies)
    user_e_norm = safe_norm(user_energies)

    # 각 onset 시점에서 가장 가까운 f0 값 추출
    hop_length = 512

    def get_f0_at_time(f0_arr, time, sr):
        frame = librosa.time_to_frames(time, sr=sr, hop_length=hop_length)
        frame = min(frame, len(f0_arr) - 1)
        return f0_arr[frame]

    # DTW 비용 행렬 계산
    cost = np.zeros((n, m))
    for i in range(n):
        for j in range(m):
            t_diff = abs(orig_times[i] - user_times[j])
            e_diff = abs(orig_e_norm[i] - user_e_norm[j]) if (i <
                                                              len(orig_e_norm) and j < len(user_e_norm)) else 0.0

            # f0 신뢰도 확인 → 낮으면 gamma=0
            orig_f0_val = get_f0_at_time(orig_f0, orig_times[i], orig_sr)
            user_f0_val = get_f0_at_time(user_f0, user_times[j], orig_sr)

            if orig_f0_val > 0 and user_f0_val > 0:
                # 센트 단위로 f0 차이 계산
                f0_diff = abs(1200 * np.log2(orig_f0_val /
                              user_f0_val + 1e-8)) / 1200
                g = gamma
            else:
                f0_diff = 0.0
                g = 0.0
                # f0 신뢰도 낮으면 시간에 가중치 재분배
                a = alpha + g / 2
                b = beta + g / 2
                g = 0.0
                cost[i, j] = a * t_diff + b * e_diff
                continue

            cost[i, j] = alpha * t_diff + beta * e_diff + gamma * f0_diff

    # DTW 누적 비용 계산
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = cost[i-1, j-1] + min(D[i-1, j], D[i, j-1], D[i-1, j-1])

    # 역추적으로 워핑 경로 복원
    path = []
    i, j = n, m
    while i > 0 and j > 0:
        path.append((i-1, j-1))
        options = [(D[i-1, j-1], i-1, j-1),
                   (D[i-1, j],   i-1, j),
                   (D[i,   j-1], i,   j-1)]
        _, i, j = min(options, key=lambda x: x[0])
    path.reverse()

    # max_match_dist 초과 쌍은 매칭 제외 → 박자 탈락 처리
    matched_pairs = []
    matched_orig = set()
    matched_user = set()

    for orig_idx, user_idx in path:
        if orig_idx in matched_orig or user_idx in matched_user:
            continue  # 이미 매칭된 onset는 건너뜀
        t_diff = user_times[user_idx] - orig_times[orig_idx]
        if abs(t_diff) <= max_match_dist:
            matched_pairs.append((
                orig_times[orig_idx],
                user_times[user_idx],
                t_diff * 1000  # ms 단위
            ))
            matched_orig.add(orig_idx)
            matched_user.add(user_idx)

    # 매칭 안 된 원곡 onset → 박자 탈락
    unmatched_orig = [orig_times[i] for i in range(n) if i not in matched_orig]
    unmatched_user = [user_times[j] for j in range(m) if j not in matched_user]

    print(f"  매칭된 Onset 쌍: {len(matched_pairs)}개")
    print(f"  원곡 박자 탈락: {len(unmatched_orig)}개")
    print(f"  사용자 미매칭 Onset: {len(unmatched_user)}개 → 불필요한 음 추가 구간")

    return matched_pairs, unmatched_orig

# ─────────────────────────────────────────────────────────────
# Step 2-4: 박자 오차 시각화
# ─────────────────────────────────────────────────────────────


def visualize_rhythm_analysis(
    orig_times:    np.ndarray, orig_energies:    np.ndarray,
    user_times:    np.ndarray, user_energies:    np.ndarray,
    matched_pairs: list,
    unmatched_orig: list,
    orig_sr: int,
):
    """
    박자 오차 시각화.
    - 두 파일의 에너지 변화 그래프
    - 매칭된 Onset 연결선 + 오차값(ms) 표시
    - 박자 탈락 구간 별도 표시
    """
    fig, axes = plt.subplots(3, 1, figsize=(16, 14))

    # ── 그래프 1: 원곡 에너지 변화 ──────────────────────────
    ax1 = axes[0]
    if len(orig_times) > 0:
        ax1.vlines(orig_times, 0, orig_energies,
                   color="#1565C0", linewidth=1.5, alpha=0.8)
        ax1.scatter(orig_times, orig_energies,
                    color="#1565C0", s=40, zorder=5)
    ax1.set_title("원곡 Onset 에너지 변화", fontsize=11, fontweight='bold')
    ax1.set_xlabel("시간 (초)")
    ax1.set_ylabel("에너지 변화량")
    ax1.grid(True, alpha=0.3)

    # ── 그래프 2: 사용자 에너지 변화 ────────────────────────
    ax2 = axes[1]
    if len(user_times) > 0:
        ax2.vlines(user_times, 0, user_energies,
                   color="#BF360C", linewidth=1.5, alpha=0.8)
        ax2.scatter(user_times, user_energies,
                    color="#BF360C", s=40, zorder=5)
    ax2.set_title("사용자 Onset 에너지 변화", fontsize=11, fontweight='bold')
    ax2.set_xlabel("시간 (초)")
    ax2.set_ylabel("에너지 변화량")
    ax2.grid(True, alpha=0.3)

    # ── 그래프 3: 매칭 결과 + 오차 ──────────────────────────
    ax3 = axes[2]
    ax3.axhline(y=1, color="#1565C0", linewidth=1,
                alpha=0.3, label="원곡 라인")
    ax3.axhline(y=0, color="#BF360C", linewidth=1,
                alpha=0.3, label="사용자 라인")

    for orig_t, user_t, diff_ms in matched_pairs:
        color = "#4CAF50" if abs(diff_ms) <= 100 else \
                "#FF9800" if abs(diff_ms) <= 300 else "#F44336"
        # 연결선
        ax3.plot([orig_t, user_t], [1, 0],
                 color=color, linewidth=1.2, alpha=0.7)
        # 오차값 표시
        mid_t = (orig_t + user_t) / 2
        ax3.text(mid_t, 0.5, f"{diff_ms:+.0f}ms",
                 fontsize=7, ha='center', va='center',
                 color=color, fontweight='bold')

    # 원곡 onset 점
    if len(orig_times) > 0:
        ax3.scatter(orig_times, np.ones(len(orig_times)),
                    color="#1565C0", s=50, zorder=5, label="원곡 onset")

    # 사용자 onset 점
    if len(user_times) > 0:
        ax3.scatter(user_times, np.zeros(len(user_times)),
                    color="#BF360C", s=50, zorder=5, label="사용자 onset")

    # 박자 탈락 구간 표시
    for t in unmatched_orig:
        ax3.axvline(x=t, color="#9C27B0", linewidth=1.5,
                    linestyle='--', alpha=0.7)
        ax3.text(t, 0.8, "탈락", fontsize=7,
                 ha='center', color="#9C27B0", fontweight='bold')

    ax3.set_title("Onset 매칭 결과 (초록: ±100ms / 주황: ±300ms / 빨강: 300ms 초과 / 보라: 탈락)",
                  fontsize=10, fontweight='bold')
    ax3.set_xlabel("시간 (초)")
    ax3.set_yticks([0, 1])
    ax3.set_yticklabels(["사용자", "원곡"])
    ax3.legend(fontsize=9, loc='upper right')
    ax3.grid(True, alpha=0.3)


def calculate_rhythm_score(
    matched_pairs: list,
    unmatched_orig: list,
) -> float:
    """
    박자 점수 계산.
    매칭된 쌍의 오차 범위별 점수 평균.
    탈락 구간은 0점 처리.
    """
    total_count = len(matched_pairs) + len(unmatched_orig)
    if total_count == 0:
        return 0.0

    score_sum = 0.0
    for _, _, diff_ms in matched_pairs:
        if abs(diff_ms) <= 100:
            score_sum += 100
        elif abs(diff_ms) <= 300:
            score_sum += 70
        else:
            score_sum += 30

    # 탈락 구간은 절반 가중치로만 반영
    unmatched_penalty = len(unmatched_orig) * 30
    score_sum = max(0, score_sum - unmatched_penalty * 0.5)

    return min(100.0, score_sum / len(matched_pairs) if matched_pairs else 0.0)


def visualize_rhythm_realtime(
    orig_times:    np.ndarray, orig_energies:    np.ndarray,
    user_times:    np.ndarray, user_energies:    np.ndarray,
    matched_pairs: list,
    unmatched_orig: list,
    original_audio: np.ndarray,   # ← 원곡
    user_audio:     np.ndarray,   # ← 사용자 추가
    sr: int,
):
    """
    원곡 재생과 동시에 박자 오차 매칭 결과를 순차적으로 표시.
    재생 시간에 맞춰 현재 위치 수직선이 이동하며 매칭 결과가 나타남.
    """
    min_len = min(len(original_audio), len(user_audio))
    original_audio = original_audio[:min_len]
    user_audio = user_audio[:min_len]
    stereo = np.stack([original_audio, user_audio], axis=1)
    total_duration = min_len / sr

    fig, axes = plt.subplots(3, 1, figsize=(16, 14))
    fig.suptitle("Step 2: 박자 오차 실시간 분석", fontsize=13, fontweight='bold')

    # ── 정적 배경 (전체 onset 점) ────────────────────────────
    ax1, ax2, ax3 = axes

    # 원곡 에너지 전체 표시
    ax1.vlines(orig_times, 0, orig_energies,
               color="#1565C0", linewidth=1.5, alpha=0.4)
    ax1.scatter(orig_times, orig_energies, color="#1565C0", s=40, alpha=0.4)
    ax1.set_title("원곡 Onset 에너지 변화", fontsize=11, fontweight='bold')
    ax1.set_xlabel("시간 (초)")
    ax1.set_ylabel("에너지 변화량")
    ax1.set_xlim(0, 10.0)
    ax1.grid(True, alpha=0.3)

    # 사용자 에너지 전체 표시
    ax2.vlines(user_times, 0, user_energies,
               color="#BF360C", linewidth=1.5, alpha=0.4)
    ax2.scatter(user_times, user_energies, color="#BF360C", s=40, alpha=0.4)
    ax2.set_title("사용자 Onset 에너지 변화", fontsize=11, fontweight='bold')
    ax2.set_xlabel("시간 (초)")
    ax2.set_ylabel("에너지 변화량")
    ax2.set_xlim(0, 10.0)
    ax2.grid(True, alpha=0.3)

    # 매칭 그래프 기본 세팅
    ax3.axhline(y=1, color="#1565C0", linewidth=1, alpha=0.3, label="원곡")
    ax3.axhline(y=0, color="#BF360C", linewidth=1, alpha=0.3, label="사용자")
    ax3.scatter(orig_times, np.ones(len(orig_times)),
                color="#1565C0", s=50, alpha=0.3, zorder=5)
    ax3.scatter(user_times, np.zeros(len(user_times)),
                color="#BF360C", s=50, alpha=0.3, zorder=5)
    for t in unmatched_orig:
        ax3.axvline(x=t, color="#9C27B0", linewidth=1.5,
                    linestyle='--', alpha=0.4)
    ax3.set_title("Onset 매칭 결과 (초록: ±100ms / 주황: ±300ms / 빨강: 300ms 초과)",
                  fontsize=10, fontweight='bold')
    ax3.set_xlabel("시간 (초)")
    ax3.set_xlim(0, 10.0)
    ax3.set_yticks([0, 1])
    ax3.set_yticklabels(["사용자", "원곡"])
    ax3.legend(fontsize=9, loc='upper right')
    ax3.grid(True, alpha=0.3)

    # ── 동적 요소 (현재 위치 수직선) ─────────────────────────
    vline1 = ax1.axvline(x=0, color='red', linewidth=2, alpha=0.8)
    vline2 = ax2.axvline(x=0, color='red', linewidth=2, alpha=0.8)
    vline3 = ax3.axvline(x=0, color='red', linewidth=2, alpha=0.8)

    plt.tight_layout()
    plt.subplots_adjust(hspace=0.4)
    # 재생 시작 시간 기록
    start_time = [None]
    shown_pairs = [set()]  # 이미 표시한 매칭 쌍 인덱스

    def update(frame):
        if start_time[0] is None:
            return vline1, vline2, vline3

        elapsed = time.time() - start_time[0]
        if elapsed > total_duration:
            elapsed = total_duration

        window = 10.0                          # 보여줄 구간 크기 (초)
        x_min = max(0, elapsed - 3.0)          # 현재 위치 왼쪽 3초
        x_max = x_min + window                 # 윈도우 끝
        ax1.set_xlim(x_min, x_max)
        ax2.set_xlim(x_min, x_max)
        ax3.set_xlim(x_min, x_max)

        # 수직선 위치 업데이트
        vline1.set_xdata([elapsed])
        vline2.set_xdata([elapsed])
        vline3.set_xdata([elapsed])

        # 현재 시간까지의 매칭 쌍 순차적으로 표시
        for idx, (orig_t, user_t, diff_ms) in enumerate(matched_pairs):
            if orig_t <= elapsed and idx not in shown_pairs[0]:
                color = "#4CAF50" if abs(diff_ms) <= 100 else \
                        "#FF9800" if abs(diff_ms) <= 300 else "#F44336"
                ax3.plot([orig_t, user_t], [1, 0],
                         color=color, linewidth=1.2, alpha=0.8)
                ax3.text((orig_t + user_t) / 2, 0.5, f"{diff_ms:+.0f}ms",
                         fontsize=6, ha='center', va='center',
                         color=color, fontweight='bold')
                shown_pairs[0].add(idx)

        return vline1, vline2, vline3

    # 음악 재생 시작
    sd.play(stereo, samplerate=sr)
    start_time[0] = time.time()

    ani = animation.FuncAnimation(
        fig, update,
        interval=16,       # 16ms마다 업데이트 (약 62.5 FPS)
        blit=False,
        cache_frame_data=False
    )

    plt.show()
    sd.wait()


def play_audio(audio: np.ndarray, sr: int, label: str):
    """오디오 재생"""
    print(f"\n▶  재생 중: {label}")
    sd.play(audio, samplerate=sr)
    sd.wait()
    print(f"   재생 완료: {label}")


def plot_waveform(ax, audio: np.ndarray, sr: int, title: str, color: str):
    """시간 도메인 파형 시각화 (t축)"""
    times = np.linspace(0, len(audio) / sr, len(audio))
    ax.plot(times, audio, color=color, linewidth=0.5, alpha=0.8)
    ax.set_title(title, fontsize=11, fontweight='bold')
    ax.set_xlabel("시간 (초)")
    ax.set_ylabel("진폭")
    ax.set_xlim(0, len(audio) / sr)
    ax.set_ylim(-1.05, 1.05)
    ax.grid(True, alpha=0.3)


def visualize_waveforms(
    original_raw: np.ndarray, original_sr: int,
    original_sep: np.ndarray,
    user_raw: np.ndarray,    user_sr: int,
    user_sep: np.ndarray,
):
    """
    전처리 전/후 파형(시간 도메인) 비교 시각화.
    """
    fig = plt.figure(figsize=(16, 8))
    fig.suptitle(
        "Vocal Coaching Pipeline - Step 1: 전처리 전/후 파형 비교",
        fontsize=13, fontweight='bold'
    )
    gs = gridspec.GridSpec(2, 2, hspace=0.5, wspace=0.3)

    ax1 = fig.add_subplot(gs[0, 0])
    plot_waveform(ax1, original_raw, original_sr, "원곡 파형 (전처리 전)", "#2196F3")

    ax2 = fig.add_subplot(gs[0, 1])
    plot_waveform(ax2, user_raw, user_sr, "사용자 파형 (전처리 전)", "#FF5722")

    ax3 = fig.add_subplot(gs[1, 0])
    plot_waveform(ax3, original_sep, original_sr, "원곡 보컬 (분리 후)", "#1565C0")

    ax4 = fig.add_subplot(gs[1, 1])
    plot_waveform(ax4, user_sep, user_sr, "사용자 보컬 (분리 후)", "#BF360C")

    plt.savefig("pipeline_step1_result.png", dpi=150, bbox_inches='tight')
    print("\n 시각화 저장 완료: pipeline_step1_result.png")
    plt.show()

# ─────────────────────────────────────────────────────────────
# Step 3-1: 구간별 f0 추출 (Δt=0.25초)
# ─────────────────────────────────────────────────────────────


def extract_pitch_aligned(original_norm, user_norm, sr, segment_duration=0.25):
    hop_length = 512

    mfcc_orig = librosa.feature.mfcc(y=original_norm, sr=sr, n_mfcc=13)
    mfcc_user = librosa.feature.mfcc(y=user_norm,     sr=sr, n_mfcc=13)

    _, wp = librosa.sequence.dtw(X=mfcc_orig, Y=mfcc_user, metric='euclidean')
    wp = wp[::-1]

    # np.interp로 모든 원곡 프레임에 대응하는 사용자 프레임 보간
    # → frame_map 빈 항목 문제 완전 해결
    T_orig = mfcc_orig.shape[1]
    all_orig_f = np.arange(T_orig)
    user_frame_map = np.interp(
        all_orig_f, wp[:, 0], wp[:, 1]
    ).astype(int)

    segment_samples = int(segment_duration * sr)
    n_segments = len(original_norm) // segment_samples

    f0_orig_list, f0_user_list = [], []
    voiced_orig_list, voiced_user_list = [], []
    time_list = []

    def get_f0(segment, label="", idx=0):
        rms_val = np.sqrt(np.mean(segment ** 2))

        if rms_val < 0.05:
            print(
                f"  [{label}][{idx:03d}] rms={rms_val:.4f} | → silent (low energy)")
            return 0.0, False

        if len(segment) < segment_samples // 2:
            print(f"  [{label}][{idx:03d}] segment too short")
            return 0.0, False

        f0, voiced_flag, voiced_probs = librosa.pyin(
            segment,
            fmin=librosa.note_to_hz('C2'),
            fmax=librosa.note_to_hz('C7'),
            sr=sr
        )

        f0_valid = f0[voiced_flag & ~np.isnan(f0)]
        mean_vp = np.nanmean(voiced_probs) if len(voiced_probs) > 0 else 0.0
        # voiced_prob 대신 f0 검출 비율 사용
        f0_rate = len(f0_valid) / len(f0) if len(f0) > 0 else 0.0
        f0_rep = float(np.median(f0_valid)) if len(f0_valid) > 0 else 0.0

        # 전체 프레임의 30% 이상에서 f0 검출되면 voiced
        is_voiced = (f0_rate >= 0.3 and f0_rep > 0)
        
        # 보컬 범위 벗어난 f0 제거 (C2~C6: 65~1047Hz)  ← 여기 추가
        if is_voiced and (f0_rep < 65 or f0_rep > 1047):
            is_voiced = False
            f0_rep = 0.0

        print(f"  [{label}][{idx:03d}] rms={rms_val:.4f} | vp={mean_vp:.2f} | "
            f"f0_rate={f0_rate:.2f} | f0={f0_rep:.1f}Hz | → {'voiced' if is_voiced else 'silent'}")

        if is_voiced:
            return f0_rep, True
        return 0.0, False

    for i in range(n_segments):
        # 원곡 구간 샘플
        o_start = i * segment_samples
        o_end = o_start + segment_samples
        seg_orig = original_norm[o_start:o_end]

        # 원곡 구간 → 대응 사용자 프레임 (보간된 매핑)
        f_start = min(o_start // hop_length, T_orig - 1)
        f_end = min(o_end // hop_length, T_orig - 1)
        uf_start = int(user_frame_map[f_start])
        uf_end = int(user_frame_map[f_end])

        # 사용자 구간 샘플
        u_start = max(0, uf_start * hop_length)
        u_end = min(len(user_norm), uf_end * hop_length + segment_samples)
        seg_user = user_norm[u_start:u_end]

        f0_o, v_o = get_f0(seg_orig, label="orig", idx=i)
        f0_u, v_u = get_f0(seg_user, label="user", idx=i)

        f0_orig_list.append(f0_o)
        f0_user_list.append(f0_u)
        voiced_orig_list.append(v_o)
        voiced_user_list.append(v_u)
        time_list.append(i * segment_duration + segment_duration / 2)

    f0_orig_arr   = np.array(f0_orig_list)
    f0_user_arr   = np.array(f0_user_list)
    voiced_o      = np.array(voiced_orig_list, dtype=bool)
    voiced_u      = np.array(voiced_user_list, dtype=bool)
    
    def fix_octave_errors(f0_arr, voiced_arr):
        """
        f0 시퀀스에서 옥타브 오류 보정.
        이전/다음 구간과 비교해서 옥타브 단위로 튄 경우
        0.5배 또는 2배 후보 중 더 가까운 값으로 교체.
        """
        f0 = f0_arr.copy()
        voiced = voiced_arr.copy()

        for i in range(1, len(f0) - 1):
            if not voiced[i] or f0[i] <= 0:
                continue

            # 앞뒤 voiced 구간의 f0 수집
            neighbors = []
            for j in [i - 1, i + 1]:
                if 0 <= j < len(f0) and voiced[j] and f0[j] > 0:
                    neighbors.append(f0[j])

            if not neighbors:
                continue

            ref = np.mean(neighbors)
            current = f0[i]

            # 현재값과 레퍼런스의 센트 차이
            cent_diff = abs(1200 * np.log2(current / ref))

            # 600센트(반옥타브) 이상 차이나면 옥타브 오류 의심
            if cent_diff > 600:
                # 옥타브 후보: 0.5배, 현재, 2배
                candidates = [current * 0.5, current, current * 2.0]
                # 보컬 범위(130~1000Hz) 내 후보만 유효
                candidates = [c for c in candidates if 130 <= c <= 1000]
                # 레퍼런스와 센트 차이가 가장 작은 후보 선택
                best = min(
                    candidates,
                    key=lambda c: abs(1200 * np.log2(c / ref)) if c > 0 else 9999
                )
                if best != current:
                    print(f"  [octave fix][{i:03d}] "
                        f"{current:.1f}Hz → {best:.1f}Hz "
                        f"(ref={ref:.1f}Hz, diff={cent_diff:.0f}센트)")
                    f0[i] = best

        return f0, voiced
    voiced_u[~voiced_o] = False
    f0_user_arr[~voiced_o] = 0.0

    # 옥타브 오류 보정
    f0_orig_arr, voiced_o = fix_octave_errors(f0_orig_arr, voiced_o)
    f0_user_arr, voiced_u = fix_octave_errors(f0_user_arr, voiced_u)

    return (
        f0_orig_arr,
        f0_user_arr,
        voiced_o,
        voiced_u,
        np.array(time_list)
    )

# ─────────────────────────────────────────────────────────────
# Step 3-2: 센트 오차 계산
# ─────────────────────────────────────────────────────────────


def calculate_cent_errors(
    f0_orig: np.ndarray, f0_user: np.ndarray,
    voiced_orig: np.ndarray, voiced_user: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """
    구간별 센트 오차 계산.
    cent_error = 1200 * log2(f0_user / f0_orig)
    양수 = 사용자가 높게 부름, 음수 = 낮게 부름.
    두 신호 모두 voiced인 구간만 유효.
    """
    n = min(len(f0_orig), len(f0_user))
    cent_errors = np.zeros(n)
    valid_mask = np.zeros(n, dtype=bool)

    for i in range(n):
        if (voiced_orig[i] and voiced_user[i]
                and f0_orig[i] > 0 and f0_user[i] > 0):
            cent_errors[i] = 1200 * np.log2(f0_user[i] / f0_orig[i])
            valid_mask[i] = True

    return cent_errors, valid_mask


def hz_to_note_name(hz: float) -> str:
    """Hz → 음이름 변환 (예: 440 → A4)"""
    if hz <= 0:
        return "-"
    midi = 69 + 12 * np.log2(hz / 440.0)
    notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    midi_int = int(round(midi))
    return f"{notes[midi_int % 12]}{(midi_int // 12) - 1}"


# ─────────────────────────────────────────────────────────────
# Step 3-3: 실시간 음정 시각화
# ─────────────────────────────────────────────────────────────

def visualize_pitch_realtime(
    f0_orig: np.ndarray, f0_user: np.ndarray,
    voiced_orig: np.ndarray, voiced_user: np.ndarray,
    cent_errors: np.ndarray, valid_mask: np.ndarray,
    seg_times: np.ndarray,
    original_norm: np.ndarray, user_norm: np.ndarray,
    sr: int,
    segment_duration: float = 0.25
):
    """
    3패널 실시간 음정 시각화.
    - ax1: 원곡 음정 (피아노롤 스타일, 슬라이딩)
    - ax2: 사용자 음정 (피아노롤 스타일, 슬라이딩)
    - ax3: 센트 오차 (막대 그래프, 점진적 완성)
    두 음성 스테레오 동시 재생 (원곡=왼쪽, 사용자=오른쪽).
    """
    # 스테레오 합성
    min_len = min(len(original_norm), len(user_norm))
    stereo = np.column_stack([original_norm[:min_len], user_norm[:min_len]])

    n_segs = len(seg_times)
    window_size = 4.0   # 슬라이딩 윈도우 4초

    # ── 그래프 설정 ──────────────────────────────────────────
    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(16, 10))
    fig.patch.set_facecolor('#0d1117')
    for ax in [ax1, ax2, ax3]:
        ax.set_facecolor('#161b22')
        ax.tick_params(colors='white')
        for spine in ax.spines.values():
            spine.set_color('#30363d')

    # f0 y축 범위
    all_f0 = np.concatenate([f0_orig[voiced_orig], f0_user[voiced_user]])
    f0_min = max(all_f0.min() * 0.85, 50) if len(all_f0) > 0 else 100
    f0_max = all_f0.max() * 1.15 if len(all_f0) > 0 else 500

    for ax, title, color in [
        (ax1, "원곡 음정",    '#00E5FF'),
        (ax2, "사용자 음정",  '#FF4081'),
    ]:
        ax.set_title(title, color=color, fontsize=11, fontweight='bold', pad=6)
        ax.set_ylabel("Hz", color='white', fontsize=9)
        ax.set_ylim(f0_min, f0_max)
        ax.grid(True, alpha=0.15, color='#30363d')
        ax.tick_params(axis='x', labelbottom=False)

    ax3.set_title("음정 오차 (센트)", color='white', fontsize=11,
                  fontweight='bold', pad=6)
    ax3.set_ylabel("센트", color='white', fontsize=9)
    ax3.set_xlabel("시간 (초)", color='white', fontsize=9)
    ax3.set_ylim(-700, 700)
    ax3.axhline(0,   color='white',   linewidth=0.8, linestyle='--', alpha=0.4)
    ax3.axhline(50, color='#FF9800', linewidth=0.5, linestyle=':',  alpha=0.4)
    ax3.axhline(-50, color='#FF9800', linewidth=0.5, linestyle=':',  alpha=0.4)
    ax3.grid(True, alpha=0.15, color='#30363d')
    ax3.set_xlim(0, max(seg_times[-1] + segment_duration, window_size))

    plt.tight_layout(pad=1.5)

    # ── 피아노롤 블록 미리 생성 (alpha=0 → 점진적 표시) ──────
    block_h_ratio = 0.04   # 블록 높이 = f0값의 4%
    orig_blocks, user_blocks = [], []

    for i in range(n_segs):
        t = seg_times[i]
        bw = segment_duration * 0.85

        if voiced_orig[i] and f0_orig[i] > 0:
            h = f0_orig[i] * block_h_ratio
            rec = plt.Rectangle(
                (t - segment_duration/2, f0_orig[i] - h/2),
                bw, h, color='#00E5FF', alpha=0.0, zorder=3, linewidth=0
            )
            ax1.add_patch(rec)
            # 음이름 텍스트 (블록 위)
            txt = ax1.text(
                t, f0_orig[i] + h * 1.2,
                hz_to_note_name(f0_orig[i]),
                color='#00E5FF', fontsize=7, ha='center', va='bottom',
                alpha=0.0, zorder=4
            )
            orig_blocks.append((i, rec, txt))

        if voiced_user[i] and f0_user[i] > 0:
            h = f0_user[i] * block_h_ratio
            rec = plt.Rectangle(
                (t - segment_duration/2, f0_user[i] - h/2),
                bw, h, color='#FF4081', alpha=0.0, zorder=3, linewidth=0
            )
            ax2.add_patch(rec)
            txt = ax2.text(
                t, f0_user[i] + h * 1.2,
                hz_to_note_name(f0_user[i]),
                color='#FF4081', fontsize=7, ha='center', va='bottom',
                alpha=0.0, zorder=4
            )
            user_blocks.append((i, rec, txt))

    # 센트 오차 막대 미리 생성
    cent_bar_artists = []
    for i in range(n_segs):
        if valid_mask[i]:
            c = cent_errors[i]
            color = ('#4CAF50' if abs(c) <= 50 else
                     '#FF9800' if abs(c) <= 100 else '#F44336')
            bars = ax3.bar(
                seg_times[i], c,
                width=segment_duration * 0.8,
                color=color, alpha=0.0, zorder=3
            )
            # 센트 수치 텍스트
            y_txt = c + (20 if c >= 0 else -20)
            txt = ax3.text(
                seg_times[i], y_txt, f"{c:+.0f}",
                color=color, fontsize=6, ha='center', va='center',
                alpha=0.0, zorder=4
            )
            cent_bar_artists.append((i, bars, txt))

    # 수직선 (현재 재생 위치)
    vline1 = ax1.axvline(0, color='white', linewidth=1.5, alpha=0.9, zorder=5)
    vline2 = ax2.axvline(0, color='white', linewidth=1.5, alpha=0.9, zorder=5)
    vline3 = ax3.axvline(0, color='white', linewidth=1.5, alpha=0.9, zorder=5)

    # 현재 상태 텍스트
    status1 = ax1.text(0.02, 0.92, '', transform=ax1.transAxes,
                       color='#00E5FF', fontsize=10, fontweight='bold', va='top')
    status2 = ax2.text(0.02, 0.92, '', transform=ax2.transAxes,
                       color='#FF4081', fontsize=10, fontweight='bold', va='top')
    status3 = ax3.text(0.02, 0.92, '', transform=ax3.transAxes,
                       color='white',   fontsize=10, fontweight='bold', va='top')

    start_time = [None]

    def update(frame):
        if start_time[0] is None:
            return

        elapsed = time.time() - start_time[0]

        # ── 슬라이딩 윈도우 (ax1, ax2) ──
        x_min = max(0.0, elapsed - window_size * 0.3)
        x_max = x_min + window_size
        ax1.set_xlim(x_min, x_max)
        ax2.set_xlim(x_min, x_max)

        # ax3는 항상 전체 범위 고정
        vline1.set_xdata([elapsed])
        vline2.set_xdata([elapsed])
        vline3.set_xdata([elapsed])

        # ── 지나간 블록 표시 ──
        for i, rec, txt in orig_blocks:
            if seg_times[i] <= elapsed + segment_duration:
                rec.set_alpha(0.85)
                txt.set_alpha(0.9)

        for i, rec, txt in user_blocks:
            if seg_times[i] <= elapsed + segment_duration:
                rec.set_alpha(0.85)
                txt.set_alpha(0.9)

        for i, bars, txt in cent_bar_artists:
            if seg_times[i] <= elapsed:
                for b in bars:
                    b.set_alpha(0.85)
                txt.set_alpha(0.9)

        # ── 현재 구간 정보 ──
        cur = int(elapsed / segment_duration)
        if 0 <= cur < n_segs:
            if voiced_orig[cur] and f0_orig[cur] > 0:
                status1.set_text(
                    f"{hz_to_note_name(f0_orig[cur])}  "
                    f"({f0_orig[cur]:.0f} Hz)"
                )
            else:
                status1.set_text("(묵음)")

            if voiced_user[cur] and f0_user[cur] > 0:
                status2.set_text(
                    f"{hz_to_note_name(f0_user[cur])}  "
                    f"({f0_user[cur]:.0f} Hz)"
                )
            else:
                status2.set_text("(묵음)")

            if valid_mask[cur]:
                c = cent_errors[cur]
                label = ("♪ 정확" if abs(c) <= 50 else
                         "▲ 높음" if c > 0 else "▼ 낮음")
                status3.set_text(f"{c:+.0f} 센트  {label}")
            else:
                status3.set_text("")

    sd.play(stereo, samplerate=sr)
    start_time[0] = time.time()

    ani = animation.FuncAnimation(
        fig, update,
        interval=16,
        blit=False,
        cache_frame_data=False
    )
    plt.show()
    sd.wait()


# =============================================================
# 서버 호출용 함수 (JSON 반환, GUI/재생 없음)
# =============================================================

def _downsample_waveform(audio: np.ndarray, sr: int, max_points: int = 2000) -> dict:
    """파형 데이터를 max_points 개수로 다운샘플링하여 JSON 직렬화 가능한 dict 반환."""
    step = max(1, len(audio) // max_points)
    indices = np.arange(0, len(audio), step)
    times = (indices / sr).round(4).tolist()
    amplitudes = audio[indices].round(5).tolist()
    return {
        "times": times,
        "amplitudes": amplitudes,
        "duration": round(float(len(audio) / sr), 3)
    }


def build_waveform_json(
    original_raw: np.ndarray, original_sr: int, original_sep: np.ndarray,
    user_raw: np.ndarray,     user_sr: int,     user_sep: np.ndarray,
) -> dict:
    """
    전처리 전/후 파형 데이터를 JSON으로 반환.
    클라이언트에서 이 데이터로 파형 그래프를 직접 렌더링 가능.
    """
    return {
        "original_raw": _downsample_waveform(original_raw, original_sr),
        "original_sep": _downsample_waveform(original_sep, original_sr),
        "user_raw":     _downsample_waveform(user_raw, user_sr),
        "user_sep":     _downsample_waveform(user_sep, user_sr),
        "sample_rate":  original_sr
    }


def build_rhythm_json(matched_pairs: list, unmatched_orig: list) -> list:
    """
    박자 분석 결과를 클라이언트 시각화용 JSON으로 반환.
    script.js의 rhythmEventsInUse 형식과 일치.

    반환 형식:
        [
          { "time": 1.2, "userTime": 1.35, "offset": 150.0, "unmatched": false },
          { "time": 2.4, "userTime": null, "offset": null,  "unmatched": true  },
          ...
        ]
    """
    events = []

    for orig_t, user_t, diff_ms in matched_pairs:
        events.append({
            "time":      round(float(orig_t),  4),
            "userTime":  round(float(user_t),  4),
            "offset":    round(float(diff_ms), 1),
            "unmatched": False
        })

    for orig_t in unmatched_orig:
        events.append({
            "time":      round(float(orig_t), 4),
            "userTime":  None,
            "offset":    None,
            "unmatched": True
        })

    events.sort(key=lambda e: e["time"])
    return events


def build_pitch_json(
    f0_orig: np.ndarray,     f0_user: np.ndarray,
    voiced_orig: np.ndarray, voiced_user: np.ndarray,
    cent_errors: np.ndarray, valid_mask: np.ndarray,
    seg_times: np.ndarray,
) -> list:
    """
    음정 분석 결과를 클라이언트 시각화용 JSON으로 반환.

    반환 형식:
        [
          {
            "time":        0.125,
            "f0_orig":     440.0,
            "f0_user":     432.0,
            "voiced_orig": true,
            "voiced_user": true,
            "cent_error":  -31.5,
            "valid":       true,
            "note_orig":   "A4",
            "note_user":   "A4",
            "direction":   "flat"   // "flat" | "sharp" | "accurate"
          },
          ...
        ]
    """
    segments = []
    for i in range(len(seg_times)):
        vo = bool(voiced_orig[i])
        vu = bool(voiced_user[i])
        valid = bool(valid_mask[i])
        ce = round(float(cent_errors[i]), 1) if valid else None

        if ce is not None:
            direction = "accurate" if abs(ce) <= 50 else ("sharp" if ce > 0 else "flat")
        else:
            direction = None

        segments.append({
            "time":        round(float(seg_times[i]), 4),
            "f0_orig":     round(float(f0_orig[i]), 2) if vo else None,
            "f0_user":     round(float(f0_user[i]), 2) if vu else None,
            "voiced_orig": vo,
            "voiced_user": vu,
            "cent_error":  ce,
            "valid":       valid,
            "note_orig":   hz_to_note_name(float(f0_orig[i])) if vo else None,
            "note_user":   hz_to_note_name(float(f0_user[i])) if vu else None,
            "direction":   direction
        })
    return segments


def calculate_pitch_score(cent_errors: np.ndarray, valid_mask: np.ndarray) -> float:
    """
    유효 구간 센트 오차 기반 음정 점수 계산.
    ±50센트 이내 = 100점, ±100센트 이내 = 70점, ±200센트 이내 = 30점, 초과 = 0점.
    """
    if valid_mask.sum() == 0:
        return 0.0
    valid_errors = np.abs(cent_errors[valid_mask])
    scores = np.where(valid_errors <= 50,  100,
              np.where(valid_errors <= 100,  70,
              np.where(valid_errors <= 200,  30, 0)))
    return float(np.mean(scores))


def generate_feedback(
    rhythm_score: float,
    pitch_score:  float,
    total_score:  float,
    matched_pairs:  list,
    unmatched_orig: list,
    cent_errors:    np.ndarray,
    valid_mask:     np.ndarray,
) -> str:
    """박자 + 음정 오차를 종합하여 한국어 코칭 피드백 생성."""
    lines = []

    # 박자 피드백
    if rhythm_score >= 90:
        lines.append("박자가 매우 정확합니다.")
    elif rhythm_score >= 70:
        lines.append("박자가 대체로 맞지만 일부 구간에서 틀렸습니다.")
    elif rhythm_score >= 50:
        lines.append("박자 연습이 필요합니다.")
    else:
        lines.append("박자가 많이 틀렸습니다. 천천히 연습해보세요.")

    if len(unmatched_orig) > 0:
        lines.append(f"{len(unmatched_orig)}개 구간의 박자를 놓쳤습니다.")

    # 음정 피드백
    if valid_mask.sum() > 0:
        mean_error = float(np.mean(cent_errors[valid_mask]))
        if abs(mean_error) > 30:
            direction = "높게" if mean_error > 0 else "낮게"
            lines.append(f"전반적으로 음정을 {direction} 부르는 경향이 있습니다.")

        if pitch_score >= 90:
            lines.append("음정이 매우 정확합니다.")
        elif pitch_score >= 70:
            lines.append("음정이 대체로 맞지만 일부 구간에서 벗어났습니다.")
        elif pitch_score >= 50:
            lines.append("음정 연습이 필요합니다.")
        else:
            lines.append("음정이 많이 틀렸습니다. 정확한 음정으로 다시 연습해보세요.")
    else:
        lines.append("음정 분석 가능한 유효 구간이 없습니다.")

    return " ".join(lines)

def run_analysis(original_path: str, user_path: str, output_dir: str = None) -> dict:
    """
    ============================================================
    서버 호출용 메인 함수.
    GUI / 오디오 재생 없이 전체 파이프라인을 실행하고
    JSON 직렬화 가능한 결과 dict를 반환.

    pipeline_service.py에서 이 함수를 호출한다:
        result = WavePipeline.run_analysis(original_path, user_path)

    반환 구조:
        {
          "result":        { pitch_score, rhythm_score, total_score, feedback },
          "rhythm_data":   [ { time, userTime, offset, unmatched }, ... ],
          "pitch_data":    [ { time, f0_orig, f0_user, cent_error, ... }, ... ],
          "waveform_data": { original_raw, original_sep, user_raw, user_sep },
          "audio_info":    { original_duration, user_duration, sample_rate }
        }
    ============================================================
    """
    print("\n[run_analysis] Step 1: 오디오 로드")
    original_raw, original_sr = load_audio_from_path(original_path)
    user_raw,     user_sr     = load_audio_from_path(user_path)
    print(f"  원곡: {len(original_raw)/original_sr:.2f}초  사용자: {len(user_raw)/user_sr:.2f}초")

    print("\n[run_analysis] Step 1: Demucs 보컬 분리")
    original_sep, _ = separate_vocals_demucs(original_path)
    user_sep,     _ = separate_vocals_demucs(user_path)

    print("\n[run_analysis] Step 2: 정규화")
    original_norm, user_norm = trim_and_match_length(
        original_sep, original_sr,
        user_sep,     user_sr
    )
    original_norm = zscore_normalize(original_norm)
    user_norm     = zscore_normalize(user_norm)
    
    if output_dir:
        import soundfile as sf
        from pathlib import Path as _Path
        _out = _Path(output_dir)
        sf.write(str(_out / "vocals_orig.wav"), original_norm, original_sr)
        sf.write(str(_out / "vocals_user.wav"), user_norm,     user_sr)
        print(f"  보컬 파일 저장 완료: {_out}")

    print("\n[run_analysis] Step 2: f0 추출 (onset용)")
    orig_f0, _, _ = extract_f0_with_confidence(original_norm, original_sr)
    user_f0, _, _ = extract_f0_with_confidence(user_norm,     user_sr)

    print("\n[run_analysis] Step 2: Onset 검출")
    orig_onset_times, orig_onset_energies = detect_onsets(
        original_norm, original_sr, orig_f0)
    user_onset_times, user_onset_energies = detect_onsets(
        user_norm,     user_sr,     user_f0)

    user_onset_times, user_onset_energies = filter_user_onsets_by_orig(
        orig_onset_times,
        user_onset_times, user_onset_energies,
        max_dist=0.3
    )

    orig_onset_times, orig_onset_energies, \
    user_onset_times, user_onset_energies = filter_silent_onsets(
        orig_onset_times, orig_onset_energies,
        user_onset_times, user_onset_energies,
        original_norm, original_sr, rms_threshold=0.1
    )

    print("\n[run_analysis] Step 2: DTW 매칭 + 박자 오차")
    matched_pairs, unmatched_orig = match_onsets_dtw(
        orig_onset_times,    orig_onset_energies,
        user_onset_times,    user_onset_energies,
        orig_f0,             user_f0,
        original_sr,
        alpha=0.6, beta=0.2, gamma=0.2
    )
    rhythm_score = calculate_rhythm_score(matched_pairs, unmatched_orig)
    print(f"  박자 점수: {rhythm_score:.1f}")

    print("\n[run_analysis] Step 3: 구간별 f0 추출 + 센트 오차")
    f0_orig_segs, f0_user_segs, \
    voiced_orig_segs, voiced_user_segs, seg_times = extract_pitch_aligned(
        original_norm, user_norm, original_sr, segment_duration=0.25
    )
    cent_errors, valid_mask = calculate_cent_errors(
        f0_orig_segs, f0_user_segs,
        voiced_orig_segs, voiced_user_segs
    )
    pitch_score = calculate_pitch_score(cent_errors, valid_mask)
    print(f"  음정 점수: {pitch_score:.1f}")

    total_score = round(rhythm_score * 0.4 + pitch_score * 0.6, 1)

    # JSON 빌드
    rhythm_data   = build_rhythm_json(matched_pairs, unmatched_orig)
    pitch_data    = build_pitch_json(
        f0_orig_segs, f0_user_segs,
        voiced_orig_segs, voiced_user_segs,
        cent_errors, valid_mask, seg_times
    )
    waveform_data = build_waveform_json(
        original_raw, original_sr, original_sep,
        user_raw,     user_sr,     user_sep
    )
    feedback = generate_feedback(
        rhythm_score, pitch_score, total_score,
        matched_pairs, unmatched_orig,
        cent_errors, valid_mask
    )

    print(f"\n[run_analysis] 완료 → 총점: {total_score}")

    return {
        "result": {
            "pitch_score":  round(pitch_score,  1),
            "rhythm_score": round(rhythm_score, 1),
            "total_score":  total_score,
            "feedback":     feedback
        },
        "rhythm_data":   rhythm_data,
        "pitch_data":    pitch_data,
        "waveform_data": waveform_data,
        "audio_info": {
            "original_duration": round(float(len(original_raw) / original_sr), 2),
            "user_duration":     round(float(len(user_raw)     / user_sr),     2),
            "sample_rate":       int(original_sr)
        }
    }


# =============================================================
# 로컬 실행용 (GUI / 재생 포함)
# =============================================================

def main():
    print("=" * 60)
    print("Vocal Coaching Pipeline - Step 1 시작")
    print("=" * 60)

    # ----------------------------------------------------------
    # 1. 오디오 로드
    # [교체 포인트] 패킷 수신 시 load_audio_from_bytes() 로 교체
    # ----------------------------------------------------------
    print("\n[Step 1-1] 오디오 파일 로드 중...")
    original_raw, original_sr = load_audio_from_path(ORIGINAL_PATH)
    user_raw,     user_sr = load_audio_from_path(USER_PATH)
    print(f"  원곡   : {len(original_raw) / original_sr:.2f}초, {original_sr}Hz")
    print(f"  사용자 : {len(user_raw)     / user_sr:.2f}초, {user_sr}Hz")

    # ----------------------------------------------------------
    # 2. 전처리 전 재생
    # ----------------------------------------------------------
    print("\n[Step 1-2] 전처리 전 재생...")
    # play_audio(original_raw, original_sr, "원곡 (전처리 전)")
    # play_audio(user_raw,     user_sr,     "사용자 녹음 (전처리 전)")

    # ----------------------------------------------------------
    # 3. Demucs 보컬 분리 / 노이즈 제거
    # ----------------------------------------------------------
    print("\n[Step 1-3] Demucs 보컬 분리 / 노이즈 제거 중...")
    original_sep, _ = separate_vocals_demucs(ORIGINAL_PATH)
    user_sep,     _ = separate_vocals_demucs(USER_PATH)
    print("  분리 완료")

    # ----------------------------------------------------------
    # 4. 전처리 후 재생
    # ----------------------------------------------------------
    print("\n[Step 1-4] 전처리 후 재생...")
    # play_audio(original_sep, original_sr, "원곡 보컬 (분리 후)")
    # play_audio(user_sep,     user_sr,     "사용자 보컬 (분리 후)")

    # ----------------------------------------------------------
    # 5. 파형 시각화 (시간 도메인만)
    # ----------------------------------------------------------
    """visualize_waveforms(
        original_raw, original_sr, original_sep,
        user_raw,     user_sr,     user_sep,
    )"""
    print("\n Step 1 완료.")
    print("   다음 단계 → Step 2: DTW 정렬 + Onset 검출 (박자 오차)")
    print("=" * 60)

    # ----------------------------------------------------------
    # Step 2: 박자 오차 계산
    # ----------------------------------------------------------
    print("\n" + "=" * 60)
    print("Step 2: 박자 오차 계산 시작")
    print("=" * 60)

    # 2-1. 정규화
    print("\n[Step 2-1] 정규화 중...")
    original_norm, user_norm = trim_and_match_length(
        original_sep, original_sr,
        user_sep,     user_sr
    )
    original_norm = zscore_normalize(original_norm)
    user_norm = zscore_normalize(user_norm)

    # 정규화된 음성 재생
    # play_audio(original_norm, original_sr, "원곡 보컬 (정규화 후)")
    # play_audio(user_norm,     user_sr,     "사용자 보컬 (정규화 후)")
    
    # 2-2. f0 추출
    print("\n[Step 2-2] f0 추출 중...")
    orig_f0, orig_voiced_flag, orig_voiced_probs = extract_f0_with_confidence(original_norm, original_sr)
    user_f0, user_voiced_flag, user_voiced_probs = extract_f0_with_confidence(user_norm,     user_sr)

    # 2-3. Onset 검출
    print("\n[Step 2-3] Onset 검출 중...")
    orig_onset_times, orig_onset_energies = detect_onsets(original_norm, original_sr, orig_f0)
    user_onset_times, user_onset_energies = detect_onsets(user_norm,     user_sr,     user_f0)

    # 2-3-1. 사용자 Onset 필터링 (원곡 거리 기반)
    user_onset_times, user_onset_energies = filter_user_onsets_by_orig(
    orig_onset_times,
    user_onset_times, user_onset_energies,
    max_dist=0.3
    )
    orig_rms_check = librosa.feature.rms(y=original_norm, hop_length=512)[0]
    print(f"  원곡 RMS 범위: min={orig_rms_check.min():.4f}, max={orig_rms_check.max():.4f}, mean={orig_rms_check.mean():.4f}")

    # 2-3-2. 원곡 묵음 기준 Onset 필터링
    orig_onset_times, orig_onset_energies, \
    user_onset_times, user_onset_energies = filter_silent_onsets(
        orig_onset_times, orig_onset_energies,
        user_onset_times, user_onset_energies,
        original_norm, original_sr,
        rms_threshold=0.1
    )

    # 2-4. DTW 매칭 + 박자 오차
    print("\n[Step 2-4] DTW 매칭 중...")
    matched_pairs, unmatched_orig = match_onsets_dtw(
        orig_onset_times,    orig_onset_energies,
        user_onset_times,    user_onset_energies,
        orig_f0,             user_f0,
        original_sr,
        alpha=0.6, beta=0.2, gamma=0.2
    )

    # 2-5. 시각화
    print("\n[Step 2-5] 시각화 중...")
    visualize_rhythm_analysis(
        orig_onset_times,    orig_onset_energies,
        user_onset_times,    user_onset_energies,
        matched_pairs,
        unmatched_orig,
        original_sr
    )

    # 2-6. 실시간 재생 + 시각화  ← 추가
    print("\n[Step 2-6] 실시간 재생 + 박자 오차 시각화 중...")
    visualize_rhythm_realtime(
        orig_onset_times,    orig_onset_energies,
        user_onset_times,    user_onset_energies,
        matched_pairs,
        unmatched_orig,
        original_norm,       # 왼쪽 채널: 원곡
        user_norm,           # 오른쪽 채널: 사용자
        original_sr
    )

# 2-7. 박자 점수 계산
    rhythm_score = calculate_rhythm_score(matched_pairs, unmatched_orig)
    print("\n" + "=" * 60)
    print(f"   박자 점수: {rhythm_score:.1f}점")
    if rhythm_score >= 90:
        print("  평가: 훌륭합니다!")
    elif rhythm_score >= 70:
        print("  평가: 잘 하셨습니다. 조금만 더 다듬어보세요.")
    elif rhythm_score >= 50:
        print("  평가: 전반적으로 틀린 부분이 있습니다.")
    else:
        print("  평가: 많이 연습이 필요합니다.")
    print("=" * 60)

    print("\n Step 2 완료.")
    print("   다음 단계 → Step 3: STFT + f0 추출 → 음정 오차 계산")
    print("=" * 60)
    
    # ----------------------------------------------------------
    # Step 3: 음정 오차 계산
    # ----------------------------------------------------------
    print("\n" + "=" * 60)
    print("Step 3: 음정 오차 계산 시작")
    print("=" * 60)

    # 3-1. DTW 정렬 + 구간별 f0 추출 (Δt=0.25초)
    print("\n[Step 3-1] DTW 정렬 + 구간별 f0 추출 중...")
    f0_orig_segs, f0_user_segs, \
        voiced_orig_segs, voiced_user_segs, seg_times = extract_pitch_aligned(
            original_norm, user_norm, original_sr, segment_duration=0.25
        )
    print(f"  총 구간 수: {len(seg_times)}개")

    # 3-2. 센트 오차 계산
    print("\n[Step 3-2] 센트 오차 계산 중...")
    cent_errors, valid_mask = calculate_cent_errors(
        f0_orig_segs, f0_user_segs,
        voiced_orig_segs, voiced_user_segs
    )
    if valid_mask.sum() > 0:
        print(f"  유효 구간: {valid_mask.sum()}개 / "
              f"평균 오차: {np.abs(cent_errors[valid_mask]).mean():.1f}센트")

    # 3-3. 실시간 시각화 + 재생
    print("\n[Step 3-3] 실시간 음정 시각화 중...")
    visualize_pitch_realtime(
        f0_orig_segs, f0_user_segs,
        voiced_orig_segs, voiced_user_segs,
        cent_errors, valid_mask,
        seg_times,
        original_norm, user_norm, original_sr,   # 재생은 원본 그대로
        segment_duration=0.25
    )
    print("\n Step 3 완료.")
    print("=" * 60)


if __name__ == "__main__":
    main()
