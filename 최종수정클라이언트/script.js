const API_BASE_URL = "http://localhost:8000";
const UPLOAD_API_URL = `${API_BASE_URL}/upload`;

// 결과 조회 API는 서버에서 실제 엔드포인트가 정해지면 여기만 수정하면 됨.
// 예시: GET http://172.22.140.223:8000/result/{session_id}
const RESULT_API_URL = (sessionId) => `${API_BASE_URL}/result/${sessionId}`;

const pageIds = [
  "homePage",
  "uploadPage",
  "serverPage",
  "livePage",
  "rhythmPage",
  "finalPage",
  "practiceUploadPage"
];

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => document.querySelectorAll(selector);
const setText = (selector, text) => {
  const element = qs(selector);
  if (element) element.textContent = text;
};

let savedTabCount = 0;
let userRecordingBlob = null;
let practiceRecordingBlob = null;
let userRecorder = null;
let practiceRecorder = null;
let userChunks = [];
let practiceChunks = [];
let currentSessionId = null;
let latestUploadResponse = null;
let latestResultResponse = null;
let serverConnectionReady = false;
let rhythmGuideShownOnce = false;
let rhythmAudioCtx = null;

qs("#micStartButton").addEventListener("click", () => {
  qs("#micStartButton").classList.add("is-on");
  qs("#micLabel").textContent = "ON";
  setTimeout(startNewSession, 300);
});

qs("#newSessionTab").addEventListener("click", () => {
  activateNewTab();
  showPage("homePage");
});

qs("#uploadButton").addEventListener("click", async () => {
  const originalFile = qs("#originalFile").files[0];
  const userFile = qs("#userFile").files[0];

  if (!originalFile) {
    alert("원곡 파일을 선택하세요.");
    return;
  }

  if (!userFile && !userRecordingBlob) {
    alert("사용자 녹음 파일을 업로드하세요.");
    return;
  }

  resetServerStatus();
  showPage("serverPage");
  await uploadOriginalAndUserFile(originalFile, userFile || userRecordingBlob);
});

qs("#goLiveButton").addEventListener("click", async () => {
  if (!serverConnectionReady || !currentSessionId) {
    alert("서버 확인 전입니다.");
    return;
  }

  clearLiveResult();
  showPage("livePage");
  await loadResultSkeleton("live");
});

qs("#goRhythmButton").addEventListener("click", async () => {
  clearRhythmResult();
  showPage("rhythmPage");
  await loadResultSkeleton("rhythm");
});

qs("#goFinalButton").addEventListener("click", async () => {
  clearFinalResult();
  showPage("finalPage");
  await loadResultSkeleton("final");
});

qs("#goPracticeUploadButton").addEventListener("click", () => {
  qs("#practiceContextText").textContent = latestResultResponse?.wrong_section
    ? `다시 연습할 구간: ${latestResultResponse.wrong_section}`
    : "틀린 구간 정보를 서버 결과와 연결할 예정입니다.";
  resetPracticeRecording();
  showPage("practiceUploadPage");
});

qs("#restartAnalyzeButton").addEventListener("click", async () => {
  const originalFile = qs("#originalFile").files[0];
  const practiceFile = qs("#practiceFile").files[0];

  if (!originalFile) {
    alert("재분석을 위해 원곡 파일을 다시 선택하세요.");
    showPage("uploadPage");
    return;
  }

  if (!practiceFile && !practiceRecordingBlob) {
    alert("재녹음 파일을 업로드하거나 클라이언트에서 바로 재녹음하세요.");
    return;
  }

  resetServerStatus();
  showPage("serverPage");
  await uploadOriginalAndUserFile(originalFile, practiceFile || practiceRecordingBlob);
});

qs("#saveResultButton").addEventListener("click", () => {
  const title = qs("#recordTitleInput").value.trim();

  if (!title) {
    alert("저장할 분석 이름을 입력하세요.");
    return;
  }

  const tab = addHistoryTab(title);
  activateTab(tab);
  openSavedResult(title);

  setTimeout(() => {
    addNewSessionWindow();
  }, 250);
});

qsa("[data-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

qs("#originalFile").addEventListener("change", (event) => setFileName("originalFileName", event.target.files[0]));
qs("#userFile").addEventListener("change", (event) => {
  setFileName("userFileName", event.target.files[0]);
  if (event.target.files[0]) resetUserRecording();
});
qs("#practiceFile").addEventListener("change", (event) => {
  setFileName("practiceFileName", event.target.files[0]);
  if (event.target.files[0]) resetPracticeRecording();
});

qs("#startUserRecordButton").addEventListener("click", () => startRecording("user"));
qs("#stopUserRecordButton").addEventListener("click", () => stopRecording("user"));
qs("#startPracticeRecordButton").addEventListener("click", () => startRecording("practice"));
qs("#stopPracticeRecordButton").addEventListener("click", () => stopRecording("practice"));

qs("#replayRhythmButton")?.addEventListener("click", () => {
  const normalized = normalizeAnalysisResult(latestResultResponse);
  renderRhythmVisualization(normalized, { forceDemoWhenEmpty: true });
});

qs("#replayPitchButton")?.addEventListener("click", () => {
  const normalized = normalizeAnalysisResult(latestResultResponse);
  renderPitchVisualization(normalized);
});

async function uploadOriginalAndUserFile(originalFile, selectedUserFile) {
  setNextButton(false, "확인 중...");
  setServerGuide("서버로 파일을 전송하는 중입니다.");
  setServerStatus("전송 중", "전송 중", "서버 요청 중...");
  qs("#sessionStatus").textContent = "확인 중";
  qs("#resultApiStatus").textContent = "대기";

  const formData = new FormData();
  formData.append("original_file", originalFile);
  formData.append("user_file", toUploadFile(selectedUserFile, "user_recording.webm"));

  try {
    const response = await fetch(UPLOAD_API_URL, {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      throw new Error(`업로드 실패: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    latestUploadResponse = result;
    currentSessionId = result.session_id;

    if (!currentSessionId) {
      throw new Error("서버 응답에 session_id가 없습니다.");
    }

    localStorage.setItem("singingCoachSessionId", currentSessionId);

    setServerStatus(
      "전송 완료",
      "전송 완료",
      "업로드 연결 성공"
    );
    qs("#sessionStatus").textContent = "확인 완료";
    setServerGuide("분석 준비 완료");

    console.log("업로드 API 응답:", result);

    await pollUntilComplete(currentSessionId);
    serverConnectionReady = true;
    setNextButton(true, "실시간 비교 시작");
  } catch (error) {
    console.error("업로드 API 오류:", error);
    serverConnectionReady = false;
    setServerStatus("실패", "실패", "서버 연결 실패");
    qs("#sessionStatus").textContent = "확인 실패";
    qs("#resultApiStatus").textContent = "확인 불가";
    setServerGuide("서버가 실행 중인지, 같은 네트워크인지, CORS 설정이 되어 있는지 확인해야 합니다.");
    setNextButton(false, "서버 확인 필요");
    alert("업로드에 실패했습니다. 서버 실행 상태, 같은 네트워크 접속 여부, CORS 설정을 확인하세요.");
  }
}

async function verifyResultApiConnection(sessionId) {
  qs("#resultApiStatus").textContent = "확인 중";

  try {
    const response = await fetch(RESULT_API_URL(sessionId), {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error(`결과 조회 실패: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    latestResultResponse = result;
    qs("#resultApiStatus").textContent = "연결 성공";
    setServerGuide("");
    console.log("결과 조회 API 확인 응답:", result);
  } catch (error) {
    console.warn("결과 조회 API 확인 실패:", error);
    qs("#resultApiStatus").textContent = "기본 틀 확인 필요";
    setServerGuide("");
  }
}

async function pollUntilComplete(sessionId, maxAttempts = 120, intervalMs = 5000) {
  qs("#resultApiStatus").textContent = "분석 중...";
  setServerGuide("서버에서 분석 중입니다. 잠시 기다려주세요.");

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(RESULT_API_URL(sessionId));
      if (!response.ok) throw new Error(`${response.status}`);

      const result = await response.json();
      latestResultResponse = result;

      qs("#resultApiStatus").textContent = `분석 중... (${i + 1}회 확인)`;
      console.log(`폴링 ${i + 1}회 응답:`, result.status);

      if (result.status === "completed") {
        qs("#resultApiStatus").textContent = "분석 완료";
        setServerGuide("분석이 완료되었습니다.");
        return result;
      }

      if (result.status === "failed") {
        qs("#resultApiStatus").textContent = "분석 실패";
        throw new Error(result.error_message || "서버 분석 실패");
      }

      // queued / processing → 대기 후 재시도
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

    } catch (error) {
      console.warn(`폴링 ${i + 1}회 오류:`, error);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error("분석 시간이 초과되었습니다. 서버 상태를 확인하세요.");
}

// 결과 조회 API 기본 틀
// 서버 쪽 결과 조회 API가 아직 완성되지 않아도, session_id로 연결 테스트를 할 수 있게 만들어둔 함수.
async function loadResultSkeleton(targetPage) {
  const sessionId = currentSessionId || localStorage.getItem("singingCoachSessionId");

  if (!sessionId) {
    applyPlaceholderResult(targetPage, "아직 session_id가 없습니다. 먼저 파일 업로드를 완료하세요.");
    return;
  }

  try {
    const response = await fetch(RESULT_API_URL(sessionId), {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error(`결과 조회 실패: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    latestResultResponse = result;
    applyResultToPage(targetPage, result);
    console.log("결과 조회 API 응답:", result);
  } catch (error) {
    console.warn("결과 조회 API는 아직 서버 구현이 필요할 수 있습니다:", error);
    applyPlaceholderResult(targetPage, `업로드 연결 확인 완료 / session_id: ${sessionId}`);
  }
}

function applyResultToPage(targetPage, result) {
  const data = normalizeAnalysisResult(result);

  if (targetPage === "live") {
  qs("#liveTotalScore").textContent = data.total_score ?? "--";
  qs("#livePitchScore").textContent = data.pitch_score ?? "--";
  qs("#liveToneScore").textContent = data.tone_score ?? "--";
  qs("#pitchFeedback").textContent = data.pitch_feedback || data.feedback || "서버 결과를 화면에 연결했습니다.";
  renderPitchVisualization(data);
}

  if (targetPage === "rhythm") {
    qs("#rhythmScore").textContent = data.rhythm_score ?? "--";
    setText("#rhythmFeedback", data.rhythm_feedback || data.feedback || "박자 분석 JSON을 박자 오차 페이지에 연결했습니다.");
    renderRhythmVisualization(data, { forceDemoWhenEmpty: true });
  }

  if (targetPage === "final") {
    qs("#finalTotalScore").textContent = data.total_score ?? "--";
    qs("#finalPitchScore").textContent = data.pitch_score ?? "--";
    qs("#finalToneScore").textContent = data.tone_score ?? "--";
    qs("#finalRhythmScore").textContent = data.rhythm_score ?? "--";
    qs("#finalFeedback").textContent = data.final_feedback || data.feedback || "최종 분석 결과를 화면에 연결했습니다.";
    qs("#wrongSection").textContent = data.wrong_section || "가장 많이 틀린 구간 결과를 연결할 예정입니다.";
  }
}

function applyPlaceholderResult(targetPage, message) {
  if (targetPage === "live") {
    qs("#pitchFeedback").textContent = message;
  }

  if (targetPage === "rhythm") {
    setText("#rhythmFeedback", `${message} / 서버 onset JSON 수신 전까지는 데모 데이터로 시각화를 확인합니다.`);
    renderRhythmVisualization(null, { forceDemoWhenEmpty: true });
  }

  if (targetPage === "final") {
    qs("#finalFeedback").textContent = message;
    qs("#wrongSection").textContent = "결과 조회 API 응답 형식이 확정되면 이 영역에 틀린 구간을 표시합니다.";
  }
}

function toUploadFile(fileOrBlob, fallbackName) {
  if (fileOrBlob instanceof File) return fileOrBlob;

  const mimeType = fileOrBlob.type || "audio/webm";
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const safeName = fallbackName.includes(".") ? fallbackName : `${fallbackName}.${extension}`;

  return new File([fileOrBlob], safeName, { type: mimeType });
}

function setServerStatus(originalText, userText, serverText) {
  qs("#originalStatus").textContent = originalText;
  qs("#userStatus").textContent = userText;
  qs("#serverStatus").textContent = serverText;
}

function setServerGuide(message) {
  qs("#serverGuideText").textContent = message;
}

function setNextButton(enabled, label) {
  const button = qs("#goLiveButton");
  button.disabled = !enabled;
  button.textContent = label;
}

function startNewSession() {
  activateNewTab();
  resetInputs();
  resetMic();
  showPage("uploadPage");
}

function addNewSessionWindow() {
  activateNewTab();
  resetInputs();
  resetMic();
  showPage("homePage");
}

function showPage(pageId) {
  pageIds.forEach((id) => qs(`#${id}`).classList.remove("active"));
  qs(`#${pageId}`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setFileName(elementId, file) {
  qs(`#${elementId}`).textContent = file ? file.name : "파일을 선택하세요";
}

function resetInputs() {
  qs("#originalFile").value = "";
  qs("#userFile").value = "";
  qs("#practiceFile").value = "";
  qs("#recordTitleInput").value = "";
  currentSessionId = null;
  latestUploadResponse = null;
  latestResultResponse = null;

  setFileName("originalFileName");
  setFileName("userFileName");
  setFileName("practiceFileName");
  resetUserRecording();
  resetPracticeRecording();
}

function resetMic() {
  qs("#micStartButton").classList.remove("is-on");
  qs("#micLabel").textContent = "OFF";
}

function resetServerStatus() {
  serverConnectionReady = false;
  setServerStatus("--", "--", "--");
  qs("#sessionStatus").textContent = "--";
  qs("#resultApiStatus").textContent = "--";
  setServerGuide("파일을 전송하면 서버 연결 상태를 확인합니다.");
  setNextButton(false, "확인 중...");
}

function setRhythmHeadline(label = "", detail = "") {
  const headline = qs(".rhythm-headline");
  const labelEl = qs("#rhythmNowLabel");
  const detailEl = qs("#rhythmNowOffset");
  if (!headline || !labelEl || !detailEl) return;

  const hasContent = Boolean(label) || Boolean(detail);
  headline.classList.toggle("is-hidden", !hasContent);
  labelEl.textContent = label;
  detailEl.textContent = detail;
}

function clearLiveResult() {
  qs("#liveTotalScore").textContent = "--";
  qs("#livePitchScore").textContent = "--";
  qs("#liveToneScore").textContent = "--";
  qs("#pitchFeedback").textContent = "";
  const pitchLayer = qs("#pitchEffectLayer");
  if (pitchLayer) pitchLayer.innerHTML = "";
  stopPitchAnimation();
}

function clearRhythmResult() {
  qs("#rhythmScore").textContent = "--";
  stopRhythmAnimation();
  clearRhythmCanvas();
  if (rhythmGuideShownOnce) {
    setRhythmHeadline("", "");
  } else {
    setRhythmHeadline("박자 분석", "현재 박자 점에서 원곡 / 사용자 / 오차를 표시합니다.");
  }
  resetRhythmCounters();
}

function clearFinalResult() {
  qs("#finalTitle").textContent = "최종 결과";
  qs("#finalTotalScore").textContent = "--";
  qs("#finalPitchScore").textContent = "--";
  qs("#finalToneScore").textContent = "--";
  qs("#finalRhythmScore").textContent = "--";
  qs("#finalFeedback").textContent = "";
  qs("#wrongSection").textContent = "";
  qs("#recordTitleInput").value = "";
}

function addHistoryTab(title) {
  savedTabCount += 1;

  const tab = document.createElement("button");
  tab.className = "tab history-tab";
  tab.type = "button";
  tab.dataset.historyTitle = title;
  tab.style.setProperty("--dot", getDotColor(savedTabCount));
  tab.innerHTML = `
    <span class="record-icon"></span>
    <span class="tab-title-text">${escapeHtml(title)}</span>
    <span class="close" aria-label="기록 삭제">×</span>
  `;

  tab.addEventListener("click", () => {
    activateTab(tab);
    openSavedResult(title);
  });

  tab.querySelector(".close").addEventListener("click", (event) => {
    event.stopPropagation();
    const wasActive = tab.classList.contains("active");
    tab.remove();

    if (wasActive) {
      activateNewTab();
      showPage("homePage");
    }
  });

  qs("#tabStrip").appendChild(tab);
  return tab;
}

function openSavedResult(title) {
  clearFinalResult();
  qs("#finalTitle").textContent = `${title} 결과`;
  showPage("finalPage");

  if (latestResultResponse) {
    applyResultToPage("final", latestResultResponse);
  } else {
    applyPlaceholderResult("final", "저장된 분석 결과 API는 추후 연결 예정입니다.");
  }
}

function activateNewTab() {
  activateTab(qs("#newSessionTab"));
}

function activateTab(tab) {
  qsa(".tab").forEach((item) => item.classList.remove("active"));
  tab.classList.add("active");
}

function getDotColor(index) {
  const colors = ["#2b2b2b", "#555555", "#777777", "#999999", "#444444", "#666666"];
  return colors[(index - 1) % colors.length];
}

async function startRecording(type) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("이 브라우저에서는 녹음 기능을 사용할 수 없습니다.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((track) => track.stop());
      setRecordedAudio(type, blob);
    };

    if (type === "user") {
      userRecorder = recorder;
      userChunks = chunks;
      qs("#startUserRecordButton").disabled = true;
      qs("#stopUserRecordButton").disabled = false;
      qs("#userRecordStatus").textContent = "녹음 중";
    } else {
      practiceRecorder = recorder;
      practiceChunks = chunks;
      qs("#startPracticeRecordButton").disabled = true;
      qs("#stopPracticeRecordButton").disabled = false;
      qs("#practiceRecordStatus").textContent = "녹음 중";
    }

    recorder.start();
  } catch (error) {
    alert("마이크 권한을 허용해야 녹음할 수 있습니다.");
  }
}

function stopRecording(type) {
  const recorder = type === "user" ? userRecorder : practiceRecorder;
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function setRecordedAudio(type, blob) {
  const url = URL.createObjectURL(blob);

  if (type === "user") {
    userRecordingBlob = blob;
    qs("#userRecordAudio").src = url;
    qs("#userRecordAudio").hidden = false;
    qs("#userRecordStatus").textContent = "녹음 완료";
    qs("#startUserRecordButton").disabled = false;
    qs("#stopUserRecordButton").disabled = true;
    qs("#userFile").value = "";
    setFileName("userFileName");
  } else {
    practiceRecordingBlob = blob;
    qs("#practiceRecordAudio").src = url;
    qs("#practiceRecordAudio").hidden = false;
    qs("#practiceRecordStatus").textContent = "녹음 완료";
    qs("#startPracticeRecordButton").disabled = false;
    qs("#stopPracticeRecordButton").disabled = true;
    qs("#practiceFile").value = "";
    setFileName("practiceFileName");
  }
}

function resetUserRecording() {
  userRecordingBlob = null;
  userChunks = [];
  if (userRecorder && userRecorder.state !== "inactive") userRecorder.stop();
  userRecorder = null;
  qs("#userRecordStatus").textContent = "대기";
  qs("#startUserRecordButton").disabled = false;
  qs("#stopUserRecordButton").disabled = true;
  qs("#userRecordAudio").removeAttribute("src");
  qs("#userRecordAudio").hidden = true;
}

function resetPracticeRecording() {
  practiceRecordingBlob = null;
  practiceChunks = [];
  if (practiceRecorder && practiceRecorder.state !== "inactive") practiceRecorder.stop();
  practiceRecorder = null;
  qs("#practiceRecordStatus").textContent = "대기";
  qs("#startPracticeRecordButton").disabled = false;
  qs("#stopPracticeRecordButton").disabled = true;
  qs("#practiceRecordAudio").removeAttribute("src");
  qs("#practiceRecordAudio").hidden = true;
}


const DEMO_RHYTHM_DATA = {
  rhythm_score: 87,
  rhythm_feedback: "원곡 onset을 기준으로 사용자 onset을 매칭하여 박자 오차를 시각화합니다.",
  matched_pairs: [
    [20.35, 20.38, 32],
    [20.55, 20.58, 30],
    [20.75, 20.86, 110],
    [20.95, 20.96, 11],
    [21.15, 21.17, 21],
    [21.35, 21.37, 20],
    [21.55, 21.56, 9],
    [22.05, 21.97, -82],
    [22.25, 22.12, -130],
    [22.55, 22.93, 380],
    [23.05, 23.42, 370],
    [23.45, 23.56, 115],
    [23.95, 23.60, -350],
    [24.45, 24.57, 120],
    [24.95, 24.94, -10],
    [25.35, 25.56, 210],
    [25.75, 25.30, -450],
    [26.15, 26.16, 14],
    [26.55, 26.92, 365],
    [27.05, 26.95, -102],
    [27.55, 27.51, -35],
    [28.95, 29.08, 130]
  ],
  unmatched_orig: [26.35, 26.55, 26.85]
};

let rhythmAnimationFrame = null;
let rhythmAnimationStart = null;
let rhythmEventsInUse = [];
let rhythmShownEventKeys = new Set();

function normalizeAnalysisResult(rawResult) {
  if (!rawResult) return null;
  const nested = rawResult.result && typeof rawResult.result === "object" ? rawResult.result : {};
  return {
    ...rawResult,
    ...nested,
    session_id: rawResult.session_id ?? nested.session_id
  };
}

function extractRhythmEvents(data) {
  if (!data) return [];
  const directEvents = data.rhythm_data || data.rhythm_events || data.events || data.onsets || data.visualization_data;

  if (Array.isArray(directEvents)) {
    return directEvents
      .map((item, index) => ({
        time: Number(item.time ?? item.orig_time ?? item.original_time ?? item.onset_time ?? index),
        userTime: Number(item.user_time ?? item.userTime ?? item.time ?? index),
        offset: Number(item.offset ?? item.diff_ms ?? item.time_diff_ms ?? item.error_ms ?? 0),
        unmatched: Boolean(item.unmatched)
      }))
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.offset));
  }

  if (Array.isArray(data.matched_pairs)) {
    const matched = data.matched_pairs
      .map((pair, index) => {
        if (Array.isArray(pair)) {
          return {
            time: Number(pair[0] ?? index),
            userTime: Number(pair[1] ?? pair[0] ?? index),
            offset: Number(pair[2] ?? 0),
            unmatched: false
          };
        }

        return {
          time: Number(pair.orig_time ?? pair.original_time ?? pair.time ?? index),
          userTime: Number(pair.user_time ?? pair.userTime ?? pair.time ?? index),
          offset: Number(pair.diff_ms ?? pair.offset ?? pair.time_diff_ms ?? pair.error_ms ?? 0),
          unmatched: false
        };
      })
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.userTime) && Number.isFinite(item.offset));

    const unmatched = Array.isArray(data.unmatched_orig)
      ? data.unmatched_orig.map((time) => ({ time: Number(time), userTime: null, offset: NaN, unmatched: true })).filter((item) => Number.isFinite(item.time))
      : [];

    return [...matched, ...unmatched].sort((a, b) => a.time - b.time);
  }

  return [];
}

function getRhythmJudge(offset) {
  if (Math.abs(offset) <= 120) return { key: "exact", text: "정확", color: "#00C853" };
  if (offset > 280) return { key: "very-fast", text: "매우빠름", color: "#0D47A1" };
  if (offset > 120) return { key: "fast", text: "빠름", color: "#64B5F6" };
  if (offset < -280) return { key: "very-slow", text: "매우느림", color: "#B71C1C" };
  return { key: "slow", text: "느림", color: "#FF6B6B" };
}

function getPitchJudge(centError) {
  if (Math.abs(centError) <= 50) return { key: "exact", text: "정확", color: "#00C853" };
  if (centError > 160) return { key: "very-high", text: "매우높음", color: "#B71C1C" };
  if (centError > 50) return { key: "high", text: "높음", color: "#FF8A80" };
  if (centError < -160) return { key: "very-low", text: "매우낮음", color: "#0D47A1" };
  return { key: "low", text: "낮음", color: "#64B5F6" };
}

function resetRhythmCounters() {
  ["#rhythmVeryFastCount", "#rhythmFastCount", "#rhythmExactCount", "#rhythmSlowCount", "#rhythmVerySlowCount"]
    .forEach((id) => {
      const el = qs(id);
      if (el) el.textContent = "0";
    });
}

function updateRhythmCounters(events) {
  const counts = { "very-fast": 0, fast: 0, exact: 0, slow: 0, "very-slow": 0 };
  events.forEach((event) => {
    counts[getRhythmJudge(event.offset).key] += 1;
  });
  const mapping = {
    "#rhythmVeryFastCount": counts["very-fast"],
    "#rhythmFastCount": counts.fast,
    "#rhythmExactCount": counts.exact,
    "#rhythmSlowCount": counts.slow,
    "#rhythmVerySlowCount": counts["very-slow"]
  };
  Object.entries(mapping).forEach(([id, value]) => {
    const el = qs(id);
    if (el) el.textContent = String(value);
  });
}

function renderRhythmVisualization(data, options = {}) {
  const canvas = qs("#rhythmCanvas");
  if (!canvas) return;

  const normalized = normalizeAnalysisResult(data);
  let events = extractRhythmEvents(normalized);
  const usingDemo = events.length === 0 && options.forceDemoWhenEmpty;

  if (usingDemo) {
    events = extractRhythmEvents(DEMO_RHYTHM_DATA);
    qs("#rhythmScore").textContent = normalized?.rhythm_score ?? DEMO_RHYTHM_DATA.rhythm_score;
  }

  rhythmEventsInUse = events
    .map((event) => ({
      ...event,
      time: Number(event.time),
      userTime: event.userTime == null ? null : Number(event.userTime),
      offset: Number(event.offset),
      unmatched: Boolean(event.unmatched)
    }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);

  rhythmShownEventKeys = new Set();
  resetRhythmCounters();
  updateRhythmCounters(rhythmEventsInUse.filter((event) => !event.unmatched && Number.isFinite(event.offset)));
  stopRhythmAnimation();

  if (rhythmEventsInUse.length === 0) {
    clearRhythmCanvas("아직 표시할 박자 onset 데이터가 없습니다.");
    return;
  }

  resizeRhythmCanvas();
  if (rhythmGuideShownOnce) {
    setRhythmHeadline("", "");
  } else {
    setRhythmHeadline("박자 분석", "현재 박자 점에서 원곡 / 사용자 / 오차를 표시합니다.");
    rhythmGuideShownOnce = true;
  }
  startRhythmAudio().then(() => {
    rhythmAnimationStart = performance.now();
    rhythmAnimationFrame = requestAnimationFrame(animateRhythmCanvas);
  });
}

function resizeRhythmCanvas() {
  const canvas = qs("#rhythmCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function animateRhythmCanvas(now) {
  const elapsed = (now - rhythmAnimationStart) / 1000;
  drawRhythmFrame(elapsed);
  const firstTime = rhythmEventsInUse[0]?.time ?? 0;
  const lastTime = rhythmEventsInUse.at(-1)?.time ?? 0;
  if (elapsed <= (lastTime - firstTime) + 3.2) {
    rhythmAnimationFrame = requestAnimationFrame(animateRhythmCanvas);
  }
}

function drawRhythmFrame(elapsed) {
  const canvas = qs("#rhythmCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const left = 72;
  const right = width - 36;
  const topY = 104;
  const bottomY = height - 72;
  const firstTime = rhythmEventsInUse[0]?.time ?? 0;
  const lastTime = rhythmEventsInUse.at(-1)?.time ?? firstTime + 6;
  const totalSpan = Math.max(4, (lastTime - firstTime) + 0.8);
  const windowSize = Math.min(9.5, Math.max(5.6, totalSpan));
  const timelineTime = firstTime + elapsed;
  const startTime = Math.max(firstTime, timelineTime - windowSize * 0.32);
  const endTime = startTime + windowSize;
  const lingerSeconds = 2.6;

  ctx.clearRect(0, 0, width, height);
  drawRhythmReference(ctx, left, right, topY, bottomY, startTime, endTime);

  let focusedEvent = null;
  let focusedIndex = -1;
  let smallestDelta = Infinity;

  rhythmEventsInUse.forEach((event, index) => {
    if (event.time < startTime || event.time > endTime) return;
    const delta = Math.abs(event.time - timelineTime);
    if (delta < 0.16 && delta < smallestDelta) {
      smallestDelta = delta;
      focusedEvent = event;
      focusedIndex = index;
    }
  });

  rhythmEventsInUse.forEach((event, index) => {
    if (event.time < startTime || event.time > endTime) return;

    const origX = left + (right - left) * ((event.time - startTime) / (endTime - startTime));
    const visible = event.time <= timelineTime;
    const recentAge = timelineTime - event.time;
    const isFocused = index === focusedIndex;
    const isRecent = visible && recentAge >= 0 && recentAge <= lingerSeconds;

    ctx.globalAlpha = visible ? 0.95 : 0.22;
    ctx.fillStyle = "#a9c6eb";
    ctx.beginPath();
    ctx.arc(origX, topY, isFocused ? 6.5 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (event.unmatched || !Number.isFinite(event.userTime)) {
      if (isFocused || isRecent) {
        const fade = isFocused ? 1 : Math.max(0.18, 1 - (recentAge / lingerSeconds) * 0.72);
        ctx.strokeStyle = `rgba(146, 101, 175, ${fade})`;
        ctx.lineWidth = isFocused ? 2.5 : 2;
        ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(origX, topY + 9);
        ctx.lineTo(origX, bottomY - 9);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }

    if (event.userTime < startTime || event.userTime > endTime) return;

    const userX = left + (right - left) * ((event.userTime - startTime) / (endTime - startTime));
    const judge = getRhythmJudge(event.offset);
    const lineColor = hexToRgb(judge.color);

    ctx.globalAlpha = visible ? 0.95 : 0.22;
    ctx.fillStyle = "#e9c7bc";
    ctx.beginPath();
    ctx.arc(userX, bottomY, isFocused ? 6.5 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (isFocused || isRecent) {
      const fade = isFocused ? 0.9 : Math.max(0.12, 0.75 - (recentAge / lingerSeconds) * 0.55);
      ctx.strokeStyle = `rgba(${lineColor.r}, ${lineColor.g}, ${lineColor.b}, ${fade})`;
      ctx.lineWidth = isFocused ? 3.2 : 2.2;
      ctx.beginPath();
      ctx.moveTo(origX, topY + 7);
      ctx.lineTo(userX, bottomY - 7);
      ctx.stroke();

      if (isFocused) {
        const midX = (origX + userX) / 2;
        const midY = (topY + bottomY) / 2;
        ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = judge.color;
        ctx.fillText(`${event.offset > 0 ? '+' : ''}${Math.round(event.offset)}ms`, midX, midY - 8);
      }

      if (isFocused && !rhythmShownEventKeys.has(index)) {
        rhythmShownEventKeys.add(index);
        showRhythmBurst(origX, topY, event.offset);
        showRhythmBurst(userX, bottomY, event.offset);
      }
    }
  });

  if (focusedEvent && Number.isFinite(focusedEvent.userTime) && !focusedEvent.unmatched) {
    const judge = getRhythmJudge(focusedEvent.offset);
    setRhythmHeadline(
      judge.text,
      `원곡 ${focusedEvent.time.toFixed(2)}s / 사용자 ${focusedEvent.userTime.toFixed(2)}s / ${focusedEvent.offset > 0 ? '+' : ''}${Math.round(focusedEvent.offset)}ms`
    );
  }

  const nowX = left + (right - left) * ((timelineTime - startTime) / (endTime - startTime));
  if (nowX >= left && nowX <= right) {
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    ctx.moveTo(nowX, topY - 16);
    ctx.lineTo(nowX, bottomY + 16);
    ctx.stroke();
  }
}

function drawRhythmReference(ctx, left, right, topY, bottomY, startTime, endTime) {
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(left, topY);
  ctx.lineTo(right, topY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(left, bottomY);
  ctx.lineTo(right, bottomY);
  ctx.stroke();

  ctx.fillStyle = '#333333';
  ctx.font = '800 13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('원곡', left - 12, topY + 4);
  ctx.fillText('사용자', left - 12, bottomY + 4);

  ctx.textAlign = 'center';
  ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
  for (let t = Math.ceil(startTime); t <= endTime; t += 1) {
    const x = left + (right - left) * ((t - startTime) / (endTime - startTime));
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, topY - 12);
    ctx.lineTo(x, bottomY + 12);
    ctx.stroke();
    ctx.fillStyle = '#8c8c8c';
    ctx.fillText(`${t.toFixed(0)}s`, x, bottomY + 28);
  }

}

function showRhythmBurst(x, y, offset) {
  const layer = qs("#rhythmEffectLayer");
  if (!layer) return;

  const judge = getRhythmJudge(offset);
  const dot = document.createElement("div");
  dot.className = "rhythm-burst";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  dot.style.color = judge.color;
  dot.title = `${judge.text} ${offset > 0 ? "+" : ""}${Math.round(offset)}ms`;

  layer.appendChild(dot);
  setTimeout(() => dot.remove(), 560);
}

function hexToRgb(hex) {
  const normalized = String(hex || "#000000").replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((ch) => ch + ch).join("")
    : normalized.padEnd(6, "0");
  const value = parseInt(full.slice(0, 6), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

function showPitchBurst(x, y, centError) {
  const layer = qs("#pitchEffectLayer");
  if (!layer) return;

  const judge = getPitchJudge(centError);
  const dot = document.createElement("div");
  dot.className = "pitch-burst";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  dot.style.color = judge.color;
  dot.title = `${judge.text} ${centError > 0 ? "+" : ""}${Math.round(centError)}센트`;

  layer.appendChild(dot);
  setTimeout(() => dot.remove(), 560);
}

function stopRhythmAnimation() {
  if (rhythmAnimationFrame) {
    cancelAnimationFrame(rhythmAnimationFrame);
    rhythmAnimationFrame = null;
  }
  if (rhythmAudioCtx) {
    try { rhythmAudioCtx.close(); } catch (_) {}
    rhythmAudioCtx = null;
  }
}

function clearRhythmCanvas(message) {
  const canvas = qs("#rhythmCanvas");
  const layer = qs("#rhythmEffectLayer");
  if (layer) layer.innerHTML = "";
  if (!canvas) return;

  resizeRhythmCanvas();
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  if (message) {
    ctx.fillStyle = "#777777";
    ctx.font = "800 16px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
  }
}

window.addEventListener("resize", () => {
  if (qs("#rhythmPage")?.classList.contains("active")) {
    resizeRhythmCanvas();
    drawRhythmFrame(0);
  }
});

// ================================================================
// 음정 시각화 (3패널: 원곡 음정 / 사용자 음정 / 센트 오차)
// + 스테레오 오디오 재생 (원곡=왼쪽, 사용자=오른쪽)
// ================================================================

let pitchSegments     = [];
let pitchAnimFrame    = null;
let pitchAnimStart    = null;
let pitchAudioCtx     = null;
let pitchShownSegmentKeys = new Set();

function stopPitchAnimation() {
  if (pitchAnimFrame) {
    cancelAnimationFrame(pitchAnimFrame);
    pitchAnimFrame = null;
  }
  if (pitchAudioCtx) {
    try { pitchAudioCtx.close(); } catch (_) {}
    pitchAudioCtx = null;
  }
}

function renderPitchVisualization(data) {
  const canvas = qs("#livePitchCanvas");
  if (!canvas) return;

  pitchSegments = Array.isArray(data?.pitch_data) ? data.pitch_data : [];
  if (pitchSegments.length === 0) {
    const ctx = canvas.getContext("2d");
    resizePitchCanvas();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.fillStyle = "#777777";
    ctx.font = "800 15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("음정 데이터 없음", canvas.clientWidth / 2, canvas.clientHeight / 2);
    return;
  }

  stopPitchAnimation();
  pitchShownSegmentKeys = new Set();
  const pitchLayer = qs("#pitchEffectLayer");
  if (pitchLayer) pitchLayer.innerHTML = "";
  resizePitchCanvas();
  startPitchAudio().then(() => {
    pitchAnimStart = performance.now();
    pitchAnimFrame = requestAnimationFrame(animatePitchCanvas);
  });
}

function resizePitchCanvas() {
  const canvas = qs("#livePitchCanvas");
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const rect  = canvas.getBoundingClientRect();
  canvas.width  = Math.floor(rect.width  * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}

function animatePitchCanvas(now) {
  const elapsed  = (now - pitchAnimStart) / 1000;
  const lastTime = pitchSegments.at(-1)?.time ?? 0;
  drawPitchFrame(elapsed);
  if (elapsed <= lastTime + 3.0) {
    pitchAnimFrame = requestAnimationFrame(animatePitchCanvas);
  }
}

function drawPitchFrame(elapsed) {
  const canvas = qs("#livePitchCanvas");
  if (!canvas || pitchSegments.length === 0) return;

  const ctx = canvas.getContext("2d");
  const W   = canvas.clientWidth;
  const H   = canvas.clientHeight;
  const SEG = 0.25;
  const WIN = 4.0;

  // f0 범위 계산
  const f0Vals = pitchSegments
    .flatMap(d => [d.voiced_orig ? d.f0_orig : null, d.voiced_user ? d.f0_user : null])
    .filter(v => v != null && v > 0);
  const f0Min = f0Vals.length ? Math.max(Math.min(...f0Vals) * 0.85, 50) : 100;
  const f0Max = f0Vals.length ? Math.max(...f0Vals) * 1.15 : 500;

  // 슬라이딩 윈도우
  const xStart = Math.max(0, elapsed - WIN * 0.3);
  const xEnd   = xStart + WIN;

  // 패널 높이
  const pH = Math.floor(H / 3);

  // ── 배경 ─────────────────────────────────────────────────────
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ── 패널 구분선 ──────────────────────────────────────────────
  ctx.strokeStyle = "#e5e5e5";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, pH);     ctx.lineTo(W, pH);     ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, pH * 2); ctx.lineTo(W, pH * 2); ctx.stroke();

  // x→픽셀 (슬라이딩 윈도우용)
  const xPx  = (t) => ((t - xStart) / (xEnd - xStart)) * (W - 60) + 40;
  // f0→픽셀
  const f0Px = (f, top, h) => top + h - ((f - f0Min) / (f0Max - f0Min)) * (h - 24) - 12;
  // 센트→픽셀 (패널3 중앙 기준)
  const centPx = (c) => {
    const mid = pH * 2 + pH / 2;
    return mid - (c / 700) * (pH / 2 - 10);
  };
  // x→픽셀 전체 타임라인 (패널3용)
  const lastTime = pitchSegments.at(-1)?.time ?? 1;
  const xFullPx = (t) => (t / (lastTime + SEG)) * (W - 60) + 40;

  // ── 패널 타이틀 ──────────────────────────────────────────────
  const drawTitle = (text, color, y) => {
    ctx.fillStyle = color;
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(text, 6, y + 14);
  };
  drawTitle("원곡 음정",    "#1565C0", 0);
  drawTitle("사용자 음정",  "#C2185B", pH);
  drawTitle("음정 오차 (센트)", "#111111", pH * 2);

  // ── 현재 위치 수직선 ─────────────────────────────────────────
  const vx = xPx(elapsed);
  [0, pH, pH * 2].forEach(top => {
    ctx.strokeStyle = "rgba(17,17,17,0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(vx, top + 4);
    ctx.lineTo(vx, top + pH - 4);
    ctx.stroke();
  });

  // ── 패널 3 기준선 (+50 / 0 / -50 센트) ─────────────────────
  [50, 0, -50].forEach(c => {
    const py = centPx(c);
    ctx.strokeStyle = c === 0 ? "rgba(17,17,17,0.35)" : "rgba(120,120,120,0.22)";
    ctx.lineWidth = c === 0 ? 1.2 : 0.8;
    ctx.setLineDash(c === 0 ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(40, py);
    ctx.lineTo(W - 20, py);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // ── 세그먼트 그리기 ──────────────────────────────────────────
  const cur = Math.floor(elapsed / SEG);

  pitchSegments.forEach((d, i) => {
    if (d.time > elapsed + SEG) return;       // 아직 안 온 구간

    const bw = Math.max(2, (SEG * 0.85) / (xEnd - xStart) * (W - 60));

    // 패널1: 원곡 음정
    if (d.voiced_orig && d.f0_orig > 0) {
      const bx = xPx(d.time) - bw / 2;
      const by = f0Px(d.f0_orig, 2, pH - 4);
      const bh = Math.max(4, d.f0_orig * 0.04 / (f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = i === cur ? "#1976D2" : "rgba(25,118,210,0.72)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
      if (bw > 18) {
        ctx.fillStyle = "#1565C0";
        ctx.font = "7px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(d.note_orig || "", xPx(d.time), by - bh / 2 - 2);
      }
    }

    // 패널2: 사용자 음정
    if (d.voiced_user && d.f0_user > 0) {
      const bx = xPx(d.time) - bw / 2;
      const by = f0Px(d.f0_user, pH + 2, pH - 4);
      const bh = Math.max(4, d.f0_user * 0.04 / (f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = i === cur ? "#D81B60" : "rgba(216,27,96,0.72)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
      if (bw > 18) {
        ctx.fillStyle = "#C2185B";
        ctx.font = "7px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(d.note_user || "", xPx(d.time), by - bh / 2 - 2);
      }
    }

    // 패널3: 센트 오차 (전체 타임라인)
    if (d.valid && d.cent_error != null) {
      const c   = d.cent_error;
      const bx3 = xFullPx(d.time) - Math.max(2, (SEG * 0.8) / (lastTime + SEG) * (W - 60)) / 2;
      const bw3 = Math.max(2, (SEG * 0.8) / (lastTime + SEG) * (W - 60));
      const mid = pH * 2 + pH / 2;
      const barH = Math.abs((c / 700) * (pH / 2 - 10));
      const by3  = c >= 0 ? mid - barH : mid;
      const pitchJudge = getPitchJudge(c);
      const clr  = pitchJudge.color;
      ctx.fillStyle = clr;
      ctx.fillRect(bx3, by3, bw3, Math.max(2, barH));
    }
  });

  // ── 현재 구간 상태 텍스트 ────────────────────────────────────
  // ── 현재 구간 상태 텍스트 + 상단 headline 업데이트 ──────────
  if (cur >= 0 && cur < pitchSegments.length) {
    const d = pitchSegments[cur];

    // canvas 내부 텍스트
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "left";

    if (d.voiced_orig && d.f0_orig > 0) {
      ctx.fillStyle = "#1565C0";
      ctx.fillText(`${d.note_orig}  (${d.f0_orig.toFixed(0)} Hz)`, 6, pH - 6);
    } else {
      ctx.fillStyle = "#555";
      ctx.fillText("(묵음)", 6, pH - 6);
    }

    if (d.voiced_user && d.f0_user > 0) {
      ctx.fillStyle = "#C2185B";
      ctx.fillText(`${d.note_user}  (${d.f0_user.toFixed(0)} Hz)`, 6, pH * 2 - 6);
    } else {
      ctx.fillStyle = "#555";
      ctx.fillText("(묵음)", 6, pH * 2 - 6);
    }

    if (d.valid && d.cent_error != null) {
      const c     = d.cent_error;
      const judge = getPitchJudge(c);
      const label = judge.text === "정확"
        ? "♪ 정확"
        : `${c > 0 ? "▲" : "▼"} ${judge.text}`;
      const clr   = judge.color;
      ctx.fillStyle = clr;
      ctx.fillText(`${c > 0 ? "+" : ""}${c.toFixed(0)} 센트  ${label}`, 6, H - 6);

      if (!pitchShownSegmentKeys.has(cur) && d.voiced_user && d.f0_user > 0) {
        const burstX = xPx(d.time);
        const burstY = f0Px(d.f0_user, pH + 2, pH - 4);
        showPitchBurst(burstX, burstY, c);
        pitchShownSegmentKeys.add(cur);
      }

      // 상단 headline 업데이트
      const labelEl  = qs("#pitchNowLabel");
      const detailEl = qs("#pitchNowOffset");
      if (labelEl)  labelEl.textContent  = judge.text;
      if (detailEl) detailEl.textContent =
        `원곡 ${d.note_orig ?? "-"} / 사용자 ${d.note_user ?? "-"} / ${c > 0 ? "+" : ""}${c.toFixed(0)}센트`;
    } else {
      const labelEl  = qs("#pitchNowLabel");
      const detailEl = qs("#pitchNowOffset");
      if (labelEl)  labelEl.textContent  = "";
      if (detailEl) detailEl.textContent = "";
    }
  }
}

// ── 오디오 재생 ──────────────────────────────────────────────────
async function startPitchAudio() {
  if (!currentSessionId) return;
  try {
    pitchAudioCtx = new AudioContext();
    const base = UPLOAD_API_URL.replace("/upload", "");

    // 1. 먼저 fetch + decode만 완료 (재생 안 함)
    const [origBuf, userBuf] = await Promise.all([
      fetchAudioBuffer(pitchAudioCtx, `${base}/sessions/${currentSessionId}/vocals_orig.wav`),
      fetchAudioBuffer(pitchAudioCtx, `${base}/sessions/${currentSessionId}/vocals_user.wav`),
    ]);

    // 2. decode 완료 후 재생 시작 (이 시점에 then()이 실행되어 애니메이션도 동시 시작)
    playWithPanner(pitchAudioCtx, origBuf, -0.8);
    playWithPanner(pitchAudioCtx, userBuf,  0.8);

  } catch (e) {
    console.warn("음정 오디오 재생 실패:", e);
  }
}

async function startRhythmAudio() {
  if (!currentSessionId) return;
  try {
    rhythmAudioCtx = new AudioContext();
    const base = UPLOAD_API_URL.replace("/upload", "");
    const [origBuf, userBuf] = await Promise.all([
      fetchAudioBuffer(rhythmAudioCtx, `${base}/sessions/${currentSessionId}/vocals_orig.wav`),
      fetchAudioBuffer(rhythmAudioCtx, `${base}/sessions/${currentSessionId}/vocals_user.wav`),
    ]);
    playWithPanner(rhythmAudioCtx, origBuf, -0.8);
    playWithPanner(rhythmAudioCtx, userBuf,  0.8);
  } catch (e) {
    console.warn("박자 오디오 재생 실패:", e);
  }
}

async function fetchAudioBuffer(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`오디오 fetch 실패: ${url}`);
  const ab = await res.arrayBuffer();
  return ctx.decodeAudioData(ab);
}

function playWithPanner(ctx, buffer, panValue) {
  if (!buffer) return;
  const src    = ctx.createBufferSource();
  src.buffer   = buffer;
  const panner = ctx.createStereoPanner();
  panner.pan.value = panValue;
  src.connect(panner);
  panner.connect(ctx.destination);
  src.start(0);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
