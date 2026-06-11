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
  "practicePage"
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
let practiceSegments = [];       // 추출된 틀린 구간 배열
let practiceCurrentIndex = 0;    // 현재 보고 있는 구간 인덱스
let practiceAudioCtx = null;     // 구간 재생용 AudioContext
let practiceAnimFrame = null;
let practiceAnimStart = null;
let practiceCurrentSlice = [];   // 현재 구간 pitch_data
let pitchSegments  = [];
let pitchAnimFrame = null;
let pitchAnimStart = null;
let pitchAudioCtx  = null;
let pitchShownSegmentKeys = new Set(); 
let practiceShownSegmentKeys = new Set();
let rhythmAnimationFrame = null;
let rhythmAnimationStart = null;
let rhythmEventsInUse = [];
let rhythmShownEventKeys = new Set();

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
  practiceSegments = extractWrongSegments(latestResultResponse);
  practiceCurrentIndex = 0;
  resetPracticeRecording();
  renderPracticeSegment(practiceCurrentIndex);
  showPage("practicePage");
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
    qs("#finalRhythmScore").textContent = data.rhythm_score ?? "--";
    qs("#finalFeedback").textContent = data.final_feedback || data.feedback || "최종 분석 결과를 화면에 연결했습니다.";

    // 가장 많이 틀린 구간 계산
    const pitchData = data.pitch_data || [];
    if (pitchData.length > 0) {
      const worst = pitchData
        .filter(s => s.valid && s.cent_error != null)
        .sort((a, b) => Math.abs(b.cent_error) - Math.abs(a.cent_error))
        .slice(0, 3);
      if (worst.length > 0) {
        const desc = worst.map(s =>
          `${s.time.toFixed(1)}초 (${s.cent_error > 0 ? "+" : ""}${s.cent_error.toFixed(0)}센트)`
        ).join(", ");
        qs("#wrongSection").textContent = `오차가 큰 구간: ${desc}`;
      } else {
        qs("#wrongSection").textContent = "틀린 구간 없음";
      }
    } else {
      qs("#wrongSection").textContent = "데이터 없음";
    }
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
  qs("#recordTitleInput").value = "";
  currentSessionId = null;
  latestUploadResponse = null;
  latestResultResponse = null;

  setFileName("originalFileName");
  setFileName("userFileName");
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
  qs("#pitchFeedback").textContent = "";
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
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
    qs("#practiceAnalyzeButton").disabled = false;
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


function stopPracticeAnimation() {
  if (practiceAnimFrame) {
    cancelAnimationFrame(practiceAnimFrame);
    practiceAnimFrame = null;
  }
  if (practiceAudioCtx) {
    try { practiceAudioCtx.close(); } catch(_) {}
    practiceAudioCtx = null;
  }
}

function startPracticeAnimation(sliceData, userSliceData = null) {
  practiceShownSegmentKeys = new Set();
  practiceCurrentSlice = sliceData;
  practiceAnimStart = performance.now();

  const canvas = qs("#practiceCanvas");
  if (!canvas) return;
  canvas.width  = canvas.offsetWidth  || 600;
  canvas.height = canvas.offsetHeight || 360;

  function animate(now) {
    const elapsed = (now - practiceAnimStart) / 1000;
    drawPracticeFrame(elapsed, practiceCurrentSlice, userSliceData);
    const lastTime  = practiceCurrentSlice.at(-1)?.time ?? 0;
    const firstTime = practiceCurrentSlice[0]?.time ?? 0;
    if (elapsed <= (lastTime - firstTime) + 2.0) {
      practiceAnimFrame = requestAnimationFrame(animate);
    }
  }
  practiceAnimFrame = requestAnimationFrame(animate);
}

function drawPracticeFrame(elapsed, origSlice, userSlice) {
  const canvas = qs("#practiceCanvas");
  if (!canvas || !origSlice || origSlice.length === 0) return;

  const ctx = canvas.getContext("2d");
  const W   = canvas.width  || canvas.offsetWidth  || 600;
  const H   = canvas.height || canvas.offsetHeight || 200;
  const SEG = 0.25;
  const WIN = 4.0;

  const firstTime = origSlice[0].time;

  // f0 범위
  const allF0 = [
    ...origSlice.filter(d => d.voiced_orig && d.f0_orig).map(d => d.f0_orig),
    ...(userSlice || []).filter(d => d.voiced_user && d.f0_user).map(d => d.f0_user)
  ];
  const f0Min = allF0.length ? Math.max(Math.min(...allF0) * 0.85, 50) : 100;
  const f0Max = allF0.length ? Math.max(...allF0) * 1.15 : 600;

  // 슬라이딩 윈도우 (elapsed는 구간 내 상대 시간)
  const nowTime  = firstTime + elapsed;
  const xStart   = Math.max(firstTime, nowTime - WIN * 0.3);
  const xEnd     = xStart + WIN;

  const pH = Math.floor(H / 3);

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, pH);     ctx.lineTo(W, pH);     ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, pH * 2); ctx.lineTo(W, pH * 2); ctx.stroke();

  const xPx  = (t) => ((t - xStart) / (xEnd - xStart)) * (W - 60) + 40;
  const f0Px = (f, top, h) => top + h - ((f - f0Min) / (f0Max - f0Min)) * (h - 24) - 12;
  const centPx = (c) => {
    const mid = pH * 2 + pH / 2;
    return mid - (c / 700) * (pH / 2 - 10);
  };

  // 타이틀
  const drawTitle = (text, color, y) => {
    ctx.fillStyle = color; ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "left"; ctx.fillText(text, 6, y + 13);
  };
  drawTitle("원곡 음정",   "#00E5FF", 0);
  drawTitle(userSlice ? "재녹음 음정" : "사용자 음정", "#FF4081", pH);
  drawTitle("음정 오차 (센트)", "#ffffff", pH * 2);

  // 기준선
  [50, 0, -50].forEach(c => {
    const py = centPx(c);
    ctx.strokeStyle = c === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,152,0,0.3)";
    ctx.lineWidth = c === 0 ? 1.2 : 0.8;
    ctx.setLineDash(c === 0 ? [] : [4, 4]);
    ctx.beginPath(); ctx.moveTo(40, py); ctx.lineTo(W - 20, py); ctx.stroke();
    ctx.setLineDash([]);
  });

  // 현재 위치 수직선
  const vx = xPx(nowTime);
  [0, pH, pH * 2].forEach(top => {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(vx, top + 4); ctx.lineTo(vx, top + pH - 4); ctx.stroke();
  });

  const bw = Math.max(2, (SEG * 0.85) / (xEnd - xStart) * (W - 60));
  const data = userSlice || origSlice;

  origSlice.forEach((d, i) => {
    if (d.time > nowTime + SEG || d.time < xStart || d.time > xEnd) return;

    const bx = xPx(d.time) - bw / 2;

    // 패널1: 원곡
    if (d.voiced_orig && d.f0_orig > 0) {
      const by = f0Px(d.f0_orig, 2, pH - 4);
      const bh = Math.max(4, d.f0_orig * 0.04 / Math.max(1, f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = d.time <= nowTime ? "rgba(0,229,255,0.85)" : "rgba(0,229,255,0.25)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
    }

    // 패널2: 재녹음 or 사용자
    const ud = userSlice ? (userSlice[i] || {}) : d;
    const f0u = ud.f0_user || 0;
    const vu  = ud.voiced_user || false;
    if (vu && f0u > 0) {
      const by = f0Px(f0u, pH + 2, pH - 4);
      const bh = Math.max(4, f0u * 0.04 / Math.max(1, f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = d.time <= nowTime ? "rgba(255,64,129,0.85)" : "rgba(255,64,129,0.25)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
    }

    // 패널3: 센트 오차
    const ce = userSlice ? (userSlice[i]?.cent_error ?? null) : d.cent_error;
    const isValid = userSlice ? (userSlice[i]?.valid ?? false) : d.valid;
    if (ce != null && isValid && d.time <= nowTime) {
      const mid = pH * 2 + pH / 2;
      const barH = Math.abs((ce / 700) * (pH / 2 - 10));
      const by3  = ce >= 0 ? mid - barH : mid;
      ctx.fillStyle = Math.abs(ce) <= 50 ? "#4CAF50" : Math.abs(ce) <= 100 ? "#FF9800" : "#F44336";
      ctx.fillRect(bx, by3, bw, Math.max(2, barH));

      // 원이 터지는 효과
      if (!practiceShownSegmentKeys.has(i)) {
        practiceShownSegmentKeys.add(i);
        const burstY = userSlice
          ? f0Px(userSlice[i]?.f0_user || 0, pH + 2, pH - 4)
          : f0Px(d.f0_user || 0, pH + 2, pH - 4);
        showPracticeBurst(xPx(d.time), burstY, ce);
      }
    }
  });
  // ── 현재 구간 피드백 텍스트 ─────────────────────────────────
  const curIdx = origSlice.findIndex(d => d.time > nowTime) - 1;
  const curSeg = origSlice[Math.max(0, curIdx)];
  const curData = userSlice
    ? (userSlice[Math.max(0, curIdx)] || null)
    : curSeg;

  if (curSeg && curSeg.time <= nowTime) {
    const ce = userSlice
      ? (curData?.cent_error ?? null)
      : curSeg.cent_error;
    const isValid = userSlice
      ? (curData?.valid ?? false)
      : curSeg.valid;

    if (ce != null && isValid) {
      const abs = Math.abs(ce);
      let label, color;

      if (abs <= 30) {
        label = "♪ 잘하고 있어요";              color = "#4CAF50";
      } else if (abs <= 60) {
        label = ce > 0 ? "▼ 조금 낮추세요" : "▲ 조금 높이세요"; color = "#8BC34A";
      } else if (abs <= 100) {
        label = ce > 0 ? "▼ 약간 낮추세요" : "▲ 약간 높이세요"; color = "#FF9800";
      } else if (abs <= 200) {
        label = ce > 0 ? "▼ 낮추세요"      : "▲ 높이세요";       color = "#FF5722";
      } else {
        label = ce > 0 ? "▼ 많이 낮추세요" : "▲ 많이 높이세요"; color = "#F44336";
      }

      ctx.font = "bold 14px -apple-system, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(W - tw - 24, pH * 2 - 26, tw + 16, 22);
      ctx.fillStyle = color;
      ctx.textAlign = "right";
      ctx.fillText(label, W - 12, pH * 2 - 10);
      ctx.textAlign = "left";
    }
  }
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

function normalizeAnalysisResult(rawResult) {
  if (!rawResult) return null;
  const nested  = rawResult.result && typeof rawResult.result === "object" ? rawResult.result : {};
  const scores  = rawResult.scores && typeof rawResult.scores === "object" ? rawResult.scores : {};
  return {
    ...rawResult,
    ...nested,
    ...scores,
    session_id:    rawResult.session_id    ?? nested.session_id,
    pitch_score:   scores.pitch_score      ?? nested.pitch_score   ?? rawResult.pitch_score,
    rhythm_score:  scores.rhythm_score     ?? nested.rhythm_score  ?? rawResult.rhythm_score,
    total_score:   scores.total_score      ?? nested.total_score   ?? rawResult.total_score,
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

async function renderRhythmVisualization(data, options = {}) {
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
  const rhythmBuffers = await fetchRhythmBuffers();
  playRhythmBuffers(rhythmBuffers);
  rhythmAnimationStart = performance.now();
  rhythmAnimationFrame = requestAnimationFrame(animateRhythmCanvas);
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

function getPitchJudge(centError) {
  if (Math.abs(centError) <= 50) return { key: "exact", text: "정확", color: "#00C853" };
  if (centError > 160) return { key: "very-high", text: "매우높음", color: "#B71C1C" };
  if (centError > 50) return { key: "high", text: "높음", color: "#FF8A80" };
  if (centError < -160) return { key: "very-low", text: "매우낮음", color: "#0D47A1" };
  return { key: "low", text: "낮음", color: "#64B5F6" };
}

function hexToRgb(hex) {
  const normalized = String(hex || "#000000").replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((ch) => ch + ch).join("")
    : normalized.padEnd(6, "0");
  const value = parseInt(full.slice(0, 6), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
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

function showPracticeBurst(x, y, centError) {
  const layer = qs("#practiceEffectLayer");
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
    ctx.fillStyle = "#161b22";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#777";
    ctx.font = "14px sans-serif";
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
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, W, H);

  // ── 패널 구분선 ──────────────────────────────────────────────
  ctx.strokeStyle = "#30363d";
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
  drawTitle("원곡 음정",    "#00E5FF", 0);
  drawTitle("사용자 음정",  "#FF4081", pH);
  drawTitle("음정 오차 (센트)", "#ffffff", pH * 2);

  // ── 현재 위치 수직선 ─────────────────────────────────────────
  const vx = xPx(elapsed);
  [0, pH, pH * 2].forEach(top => {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(vx, top + 4);
    ctx.lineTo(vx, top + pH - 4);
    ctx.stroke();
  });

  // ── 패널 3 기준선 (+50 / 0 / -50 센트) ─────────────────────
  [50, 0, -50].forEach(c => {
    const py = centPx(c);
    ctx.strokeStyle = c === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,152,0,0.3)";
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
      ctx.fillStyle = i === cur ? "#80F0FF" : "rgba(0,229,255,0.8)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
      if (bw > 18) {
        ctx.fillStyle = "#00E5FF";
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
      ctx.fillStyle = i === cur ? "#FF80AA" : "rgba(255,64,129,0.8)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
      if (bw > 18) {
        ctx.fillStyle = "#FF4081";
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
      const clr  = getPitchJudge(c).color;
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
      ctx.fillStyle = "#00E5FF";
      ctx.fillText(`${d.note_orig}  (${d.f0_orig.toFixed(0)} Hz)`, 6, pH - 6);
    } else {
      ctx.fillStyle = "#555";
      ctx.fillText("(묵음)", 6, pH - 6);
    }

    if (d.voiced_user && d.f0_user > 0) {
      ctx.fillStyle = "#FF4081";
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
      const intensity = Math.abs(c) <= 50  ? "정확"
                      : Math.abs(c) <= 100 ? "약간"
                      : Math.abs(c) <= 200 ? "많이"
                      : "매우";
      const dir = Math.abs(c) <= 50 ? "" : c > 0 ? " 높음" : " 낮음";
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

async function fetchRhythmBuffers() {
  if (!currentSessionId) return null;
  try {
    rhythmAudioCtx = new AudioContext();
    const base = UPLOAD_API_URL.replace("/upload", "");
    const [origBuf, userBuf] = await Promise.all([
      fetchAudioBuffer(rhythmAudioCtx, `${base}/sessions/${currentSessionId}/vocals_orig.wav`),
      fetchAudioBuffer(rhythmAudioCtx, `${base}/sessions/${currentSessionId}/vocals_user.wav`),
    ]);
    return { origBuf, userBuf };
  } catch (e) {
    console.warn("박자 오디오 fetch 실패:", e);
    return null;
  }
}

function playRhythmBuffers(buffers) {
  if (!buffers || !rhythmAudioCtx) return;
  playWithPanner(rhythmAudioCtx, buffers.origBuf, -0.8);
  playWithPanner(rhythmAudioCtx, buffers.userBuf,  0.8);
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

// 틀린 구간 클러스터 추출
function extractWrongSegments(result) {
  if (!result) return [];
  const pitchData = result.pitch_data || [];
  if (pitchData.length === 0) return [];

  const SEG_DUR  = 0.25;   // 각 pitch 구간 길이
  const MERGE_GAP = 5.0;   // 이 거리 이내 클러스터는 하나로 합침 (초)
  const MAX_SEGMENTS = 5;  // 최대 추출 구간 수
  const CENT_THRESHOLD = 200; // 이 이상 오차인 구간만 불량으로 판단
  const MIN_SILENCE_DUR = 0.3; // 구절 경계로 인정할 최소 무음 길이 (초)
  const MIN_PHRASE_DUR  = 1.5; // 너무 짧은 구절은 인접 구절과 병합
  const MIN_DUR = 6.0;   // 최종 구간 최소 길이
  const MAX_DUR = 18.0;  // 최종 구간 최대 길이

  // ── 1. 불량 구간 클러스터링 ────────────────────────────────
  const rawClusters = [];
  let clusterStart = null, clusterEnd = null, clusterScore = 0;

  pitchData.forEach((seg, i) => {
    const segStart = seg.time_start ?? seg.time ?? 0;
    const segEnd   = seg.time_end   ?? (segStart + SEG_DUR);
    const centErr  = Math.abs(seg.cent_error ?? 0);
    const isBad    = seg.valid && centErr > CENT_THRESHOLD;

    if (isBad) {
      if (clusterStart === null) clusterStart = segStart;
      clusterEnd = segEnd;
      clusterScore += centErr;
    }

    const isLast = i === pitchData.length - 1;
    if ((!isBad || isLast) && clusterStart !== null) {
      rawClusters.push({ start: clusterStart, end: clusterEnd, score: clusterScore });
      clusterStart = null; clusterEnd = null; clusterScore = 0;
    }
  });

  if (rawClusters.length === 0) return [];

  // ── 2. 인접 클러스터 병합 ──────────────────────────────────
  const merged = [rawClusters[0]];
  for (let i = 1; i < rawClusters.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = rawClusters[i];
    if (curr.start - prev.end <= MERGE_GAP) {
      prev.end   = curr.end;
      prev.score += curr.score;
    } else {
      merged.push({ ...curr });
    }
  }

  // ── 3. 오차 점수 상위 MAX_SEGMENTS개 선택 ──────────────────
  merged.sort((a, b) => b.score - a.score);
  const top = merged.slice(0, MAX_SEGMENTS);

  // ── 4. 노래를 무음 기준 "구절" 단위로 분할 ─────────────────
  const phrases = [];
  let phraseStart = pitchData[0]?.time ?? 0;
  let silenceRun = 0;

  for (let i = 0; i < pitchData.length; i++) {
    const d = pitchData[i];
    if (!d.voiced_orig) {
      silenceRun += SEG_DUR;
    } else {
      if (silenceRun >= MIN_SILENCE_DUR && i > 0) {
        const prevTime = pitchData[i - 1].time + SEG_DUR;
        if (prevTime > phraseStart) {
          phrases.push({ start: phraseStart, end: prevTime });
        }
        phraseStart = d.time;
      }
      silenceRun = 0;
    }
  }
  const lastTime = (pitchData.at(-1)?.time ?? 0) + SEG_DUR;
  if (lastTime > phraseStart) phrases.push({ start: phraseStart, end: lastTime });

  // 너무 짧은 구절은 다음 구절과 병합
  const mergedPhrases = [];
  for (const p of phrases) {
    if (mergedPhrases.length > 0 && (p.end - p.start) < MIN_PHRASE_DUR) {
      mergedPhrases[mergedPhrases.length - 1].end = p.end;
    } else {
      mergedPhrases.push({ ...p });
    }
  }
  // 마지막 구절이 너무 짧으면 이전 구절과 병합
  if (mergedPhrases.length > 1) {
    const lastP = mergedPhrases[mergedPhrases.length - 1];
    if ((lastP.end - lastP.start) < MIN_PHRASE_DUR) {
      mergedPhrases[mergedPhrases.length - 2].end = lastP.end;
      mergedPhrases.pop();
    }
  }

  if (mergedPhrases.length === 0) return [];

  // ── 5. 각 클러스터를 겹치는 구절 범위로 스냅 ───────────────
  const final = top.map(c => {
    const center = (c.start + c.end) / 2;

    // 클러스터 중심을 포함하는 구절 찾기
    let phraseIdx = mergedPhrases.findIndex(p => center >= p.start && center < p.end);
    if (phraseIdx === -1) {
      // 못 찾으면 가장 가까운 구절로
      phraseIdx = mergedPhrases.reduce((best, p, i) => {
        const dist = Math.min(Math.abs(p.start - center), Math.abs(p.end - center));
        const bestDist = Math.min(Math.abs(mergedPhrases[best].start - center), Math.abs(mergedPhrases[best].end - center));
        return dist < bestDist ? i : best;
      }, 0);
    }

    let start = mergedPhrases[phraseIdx].start;
    let end   = mergedPhrases[phraseIdx].end;

    // 구절이 너무 짧으면 앞/뒤 구절도 포함
    while ((end - start) < MIN_DUR) {
      const canExtendNext = phraseIdx + 1 < mergedPhrases.length;
      const canExtendPrev = phraseIdx - 1 >= 0;
      if (canExtendNext && (!canExtendPrev || (mergedPhrases[phraseIdx + 1].end - start) <= (end - mergedPhrases[phraseIdx - 1].start))) {
        end = mergedPhrases[++phraseIdx + 0, mergedPhrases[phraseIdx].end];
        end = mergedPhrases[phraseIdx].end;
        phraseIdx = phraseIdx; // no-op safeguard
      } else if (canExtendPrev) {
        start = mergedPhrases[--phraseIdx, mergedPhrases[phraseIdx].start];
      } else {
        break;
      }
    }

    // 너무 길면 잘라내기 — 무음 구간으로 스냅
    if ((end - start) > MAX_DUR) {
      const half = MAX_DUR / 2;
      let newStart = Math.max(start, center - half);
      let newEnd   = Math.min(end, center + half);

      // newEnd 근처(±2초)에서 무음 구간 탐색, 있으면 그 지점으로 스냅
      const endCandidates = pitchData.filter(d => {
        const t = d.time;
        return !d.voiced_orig && t >= newEnd - 2.0 && t <= newEnd + 0.5 && t > newStart;
      });
      if (endCandidates.length > 0) {
        endCandidates.sort((a, b) => Math.abs(a.time - newEnd) - Math.abs(b.time - newEnd));
        newEnd = endCandidates[0].time + SEG_DUR;
      }

      // newStart 근처(±2초)에서도 동일하게
      const startCandidates = pitchData.filter(d => {
        const t = d.time;
        return !d.voiced_orig && t <= newStart + 2.0 && t >= newStart - 0.5 && t < newEnd;
      });
      if (startCandidates.length > 0) {
        startCandidates.sort((a, b) => Math.abs(a.time - newStart) - Math.abs(b.time - newStart));
        newStart = startCandidates[0].time;
      }

      start = newStart;
      end   = newEnd;
    }

    return { start, end };
  });

  // ── 6. 시간순 정렬 + 중복 구간 제거 ─────────────────────────
  final.sort((a, b) => a.start - b.start);
  const dedup = [];
  for (const seg of final) {
    if (dedup.length > 0 && seg.start < dedup[dedup.length - 1].end) {
      // 겹치면 병합
      dedup[dedup.length - 1].end = Math.max(dedup[dedup.length - 1].end, seg.end);
    } else {
      dedup.push({ ...seg });
    }
  }

  return dedup;
}

// 현재 구간 화면 렌더링
function renderPracticeSegment(index) {
  stopPracticeAnimation(); 
  const seg = practiceSegments[index];
  if (!seg) return;

  qs("#practiceSegmentCounter").textContent =
    `${index + 1} / ${practiceSegments.length}`;
  qs("#practiceSegmentInfo").textContent =
    `구간: ${seg.start.toFixed(1)}초 ~ ${seg.end.toFixed(1)}초`;

  // 캔버스에 해당 구간 pitch_data 슬라이스해서 그리기
  const sliced = (latestResultResponse?.pitch_data || []).filter(
    s => {
      const t = s.time ?? s.time_start ?? 0;
      return t >= seg.start && t <= seg.end;
    }
  );
  drawPracticeCanvas(sliced, null);  // 두 번째 인자는 재녹음 결과

  // 버튼 상태 초기화
  qs("#practiceAnalyzeButton").disabled = true;
  resetPracticeRecording();
}

// 캔버스 그리기 (원곡 + 재녹음 오버레이)
function drawPracticeCanvas(origSlice, userSlice) {
  const canvas = qs("#practiceCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width  = canvas.offsetWidth  || 600;
  canvas.height = canvas.offsetHeight || 200;

  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, W, H);

  if (!origSlice || origSlice.length === 0) {
    ctx.fillStyle = "#555";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("구간 데이터 없음", W / 2, H / 2);
    return;
  }

  const data = origSlice;
  const n = data.length;
  const SEG = 0.25;
  const timeStart = data[0].time;
  const timeEnd   = data[n - 1].time + SEG;
  const totalDur  = timeEnd - timeStart;

  const f0Vals = data
    .flatMap(d => [d.voiced_orig ? d.f0_orig : null, (userSlice ? userSlice : data).find
      ? null : null])
    .filter(v => v != null && v > 0);

  // f0 범위: origSlice + userSlice 합산
  const allF0 = [
    ...data.filter(d => d.voiced_orig && d.f0_orig).map(d => d.f0_orig),
    ...(userSlice || []).filter(d => d.voiced_user && d.f0_user).map(d => d.f0_user)
  ];
  const f0Min = allF0.length ? Math.max(Math.min(...allF0) * 0.85, 50) : 100;
  const f0Max = allF0.length ? Math.max(...allF0) * 1.15 : 600;

  const pH = Math.floor(H / 3);
  const xPx  = (t) => ((t - timeStart) / totalDur) * (W - 60) + 40;
  const f0Px = (f, top, h) => top + h - ((f - f0Min) / (f0Max - f0Min)) * (h - 24) - 12;
  const centPx = (c) => {
    const mid = pH * 2 + pH / 2;
    return mid - (c / 700) * (pH / 2 - 10);
  };

  // 패널 구분선
  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, pH);     ctx.lineTo(W, pH);     ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, pH * 2); ctx.lineTo(W, pH * 2); ctx.stroke();

  // 패널 타이틀
  const drawTitle = (text, color, y) => {
    ctx.fillStyle = color; ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "left"; ctx.fillText(text, 6, y + 13);
  };
  drawTitle("원곡 음정",   "#00E5FF", 0);
  drawTitle("재녹음 음정", "#FF4081", pH);
  drawTitle("음정 오차 (센트)", "#ffffff", pH * 2);

  // 기준선 (센트 패널)
  [50, 0, -50].forEach(c => {
    const py = centPx(c);
    ctx.strokeStyle = c === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,152,0,0.3)";
    ctx.lineWidth = c === 0 ? 1.2 : 0.8;
    ctx.setLineDash(c === 0 ? [] : [4, 4]);
    ctx.beginPath(); ctx.moveTo(40, py); ctx.lineTo(W - 20, py); ctx.stroke();
    ctx.setLineDash([]);
  });

  const bw = Math.max(2, (SEG / totalDur) * (W - 60) * 0.85);

  // userSlice가 있으면 재녹음 결과, 없으면 origSlice의 user 데이터 사용
  const userData = userSlice || [];

  data.forEach((d, i) => {
    const bx = xPx(d.time) - bw / 2;

    // 패널1: 원곡
    if (d.voiced_orig && d.f0_orig > 0) {
      const by = f0Px(d.f0_orig, 2, pH - 4);
      const bh = Math.max(4, d.f0_orig * 0.04 / Math.max(1, f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = "rgba(0,229,255,0.85)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
    }

    // 패널2: 재녹음 (userSlice 있으면 그것, 없으면 origSlice의 user)
    const ud = userData[i] || d;
    const f0u = ud.f0_user || 0;
    const vu  = ud.voiced_user || false;
    if (vu && f0u > 0) {
      const by = f0Px(f0u, pH + 2, pH - 4);
      const bh = Math.max(4, f0u * 0.04 / Math.max(1, f0Max - f0Min) * (pH - 24));
      ctx.fillStyle = "rgba(255,64,129,0.85)";
      ctx.fillRect(bx, by - bh / 2, bw, bh);
    }

    // 패널3: 센트 오차
    const ce = userSlice ? (userData[i]?.cent_error ?? null) : d.cent_error;
    if (ce != null && (userSlice ? userData[i]?.valid : d.valid)) {
      const mid = pH * 2 + pH / 2;
      const barH = Math.abs((ce / 700) * (pH / 2 - 10));
      const by3  = ce >= 0 ? mid - barH : mid;
      const clr  = Math.abs(ce) <= 50 ? "#4CAF50" : Math.abs(ce) <= 100 ? "#FF9800" : "#F44336";
      ctx.fillStyle = clr;
      ctx.fillRect(bx, by3, bw, Math.max(2, barH));
    }
  });
}

// 3초 카운트다운 후 해당 구간 원곡 재생
// 3초 카운트다운 후 해당 구간 원곡 재생
async function startPracticePlayback() {
  const seg = practiceSegments[practiceCurrentIndex];
  if (!seg) return;

  stopPracticeAnimation();
  if (practiceAudioCtx) { try { practiceAudioCtx.close(); } catch(_) {} }
  stopPitchAnimation();
  stopRhythmAnimation();

  // 1. 오디오 fetch를 카운트다운 전에 미리 수행
  practiceAudioCtx = new AudioContext();
  const base = API_BASE_URL;
  let buf;
  try {
    buf = await fetchAudioBuffer(
      practiceAudioCtx,
      `${base}/sessions/${currentSessionId}/vocals_orig.wav`
    );
  } catch(e) {
    console.warn("practice 오디오 fetch 실패:", e);
    return;
  }

  // 2. 카운트다운
  const cdEl = qs("#practiceCountdown");
  cdEl.classList.remove("hidden");
  for (let i = 3; i >= 1; i--) {
    cdEl.textContent = i;
    await new Promise(r => setTimeout(r, 1000));
  }
  cdEl.classList.add("hidden");

  // 3. 오디오 + 시각화 동시 시작
  const source = practiceAudioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(practiceAudioCtx.destination);
  source.start(0, seg.start, seg.end - seg.start);

  const sliced = (latestResultResponse?.pitch_data || []).filter(s => {
    const t = s.time ?? 0;
    return t >= seg.start && t <= seg.end;
  });
  startPracticeAnimation(sliced);
}

// 구간 재녹음 분석 요청
async function analyzePracticeSegment() {
  const seg = practiceSegments[practiceCurrentIndex];
  if (!seg || !practiceRecordingBlob) return;

  const formData = new FormData();
  formData.append("practice_file",
    toUploadFile(practiceRecordingBlob, "practice.webm")
  );
  formData.append("time_start", seg.start);
  formData.append("time_end",   seg.end);

  const res = await fetch(
    `${API_BASE_URL}/practice/${currentSessionId}`,
    { method: "POST", body: formData }
  );
  const result = await res.json();

  // 비교 시각화: 원곡 슬라이스 + 재녹음 결과 오버레이
  const origSlice = (latestResultResponse?.pitch_data || []).filter(
    s => {
      const t = s.time ?? s.time_start ?? 0;
      return t >= seg.start && t <= seg.end;
    }
  );
  stopPracticeAnimation();
  const retrySlice = result.pitch_data || [];
  // 점수 변화 피드백
  const prevScore = latestResultResponse?.scores?.pitch_score ?? null;
  const newScore  = result.result?.pitch_score ?? null;
  if (prevScore !== null && newScore !== null) {
    const diff = Math.round((newScore - prevScore) * 10) / 10;
    const sign  = diff >= 0 ? "+" : "";
    const color = diff >= 0 ? "#4CAF50" : "#F44336";
    const msg   = `재녹음 점수: ${newScore}점 (${sign}${diff}점)`;
    const el    = qs("#practiceSegmentInfo");
    if (el) {
      el.textContent = `구간: ${seg.start.toFixed(1)}초 ~ ${seg.end.toFixed(1)}초  |  ${msg}`;
      el.style.color = color;
    }
  }

  startPracticeAnimation(origSlice, retrySlice);
}

// 화살표 네비게이션
qs("#practicePrevButton").addEventListener("click", () => {
  if (practiceCurrentIndex > 0) {
    practiceCurrentIndex--;
    renderPracticeSegment(practiceCurrentIndex);
  }
});

qs("#practiceNextButton").addEventListener("click", () => {
  if (practiceCurrentIndex < practiceSegments.length - 1) {
    practiceCurrentIndex++;
    renderPracticeSegment(practiceCurrentIndex);
  }
});

qs("#practicePlayButton").addEventListener("click", () => {
  startPracticePlayback();
});

qs("#practiceAnalyzeButton").addEventListener("click", () => {
  analyzePracticeSegment();
});
