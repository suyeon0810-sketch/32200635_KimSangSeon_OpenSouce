const pageIds = [
    "uploadPage",
    "serverPage",
    "livePage",
    "rhythmPage",
    "finalPage",
    "practiceUploadPage"
];

const uploadButton = document.getElementById("uploadButton");
const goLiveButton = document.getElementById("goLiveButton");
const goRhythmButton = document.getElementById("goRhythmButton");
const goFinalButton = document.getElementById("goFinalButton");
const goPracticeUploadButton = document.getElementById("goPracticeUploadButton");
const goHomeButton = document.getElementById("goHomeButton");
const restartAnalyzeButton = document.getElementById("restartAnalyzeButton");

const originalFileInput = document.getElementById("originalFile");
const userFileInput = document.getElementById("userFile");
const practiceFileInput = document.getElementById("practiceFile");

let currentMode = "first-analysis";

originalFileInput.addEventListener("change", function () {
    updateSelectedFileName("originalFileName", originalFileInput.files[0]);
});

userFileInput.addEventListener("change", function () {
    updateSelectedFileName("userFileName", userFileInput.files[0]);
});

practiceFileInput.addEventListener("change", function () {
    updateSelectedFileName("practiceFileName", practiceFileInput.files[0]);
});

uploadButton.addEventListener("click", handleFirstUpload);
goLiveButton.addEventListener("click", moveToLivePage);
goRhythmButton.addEventListener("click", moveToRhythmPage);
goFinalButton.addEventListener("click", moveToFinalPage);
goPracticeUploadButton.addEventListener("click", moveToPracticeUploadPage);
goHomeButton.addEventListener("click", function () { moveToPage("uploadPage"); });
restartAnalyzeButton.addEventListener("click", handlePracticeUpload);

document.querySelectorAll("[data-page]").forEach(function (button) {
    button.addEventListener("click", function () {
        moveToPage(button.dataset.page);
    });
});

async function handleFirstUpload() {
    const originalFile = originalFileInput.files[0];
    const userFile = userFileInput.files[0];

    if (!originalFile) {
        alert("원곡 파일을 선택하세요.");
        return;
    }

    if (!userFile) {
        alert("사용자 녹음 파일을 선택하세요.");
        return;
    }

    currentMode = "first-analysis";
    moveToPage("serverPage");

    // FormData로 파일 패킹
    const formData = new FormData();
    formData.append("original_file", originalFile);
    formData.append("user_file", userFile);

    try {
        // 서버로 전송
        const response = await fetch("http://localhost:8000/upload", {
            method: "POST",
            body: formData
        });

        const result = await response.json();

        if (response.ok) {
            console.log("업로드 성공:", result);
            // 세션 ID 저장 (나중에 /result 조회할 때 사용)
            window.sessionId = result.session_id;
            runFakeServerCheck();
        } else {
            alert("업로드 실패: " + JSON.stringify(result));
        }

    } catch (error) {
        alert("서버 연결 실패: " + error.message);
        moveToPage("uploadPage");
    }
}

async function handlePracticeUpload() {
    const practiceFile = practiceFileInput.files[0];

    if (!practiceFile) {
        alert("재녹음 파일을 선택하세요.");
        return;
    }

    currentMode = "practice-analysis";
    moveToPage("serverPage");
    runFakeServerCheck();
}

function moveToLivePage() {
    moveToPage("livePage");
    resetLiveScores();
}

function moveToRhythmPage() {
    moveToPage("rhythmPage");
}

function moveToFinalPage() {
    moveToPage("finalPage");
    resetFinalResults();
}

function moveToPracticeUploadPage() {
    moveToPage("practiceUploadPage");
}

function runFakeServerCheck() {
    document.getElementById("originalStatus").innerText = currentMode === "practice-analysis" ? "기존 원곡 사용" : "대기";
    document.getElementById("userStatus").innerText = "대기";
    document.getElementById("serverStatus").innerText = "대기";

    setTimeout(function () {
        document.getElementById("originalStatus").innerText = currentMode === "practice-analysis" ? "유지" : "완료";
    }, 300);

    setTimeout(function () {
        document.getElementById("userStatus").innerText = currentMode === "practice-analysis" ? "재녹음 완료" : "완료";
    }, 650);

    setTimeout(function () {
        document.getElementById("serverStatus").innerText = "확인";
    }, 1000);
}

function updateSelectedFileName(targetId, file) {
    const target = document.getElementById(targetId);
    target.innerText = file ? file.name : "파일을 선택하세요";
}

function resetLiveScores() {
    document.getElementById("liveTotalScore").innerText = "--";
    document.getElementById("livePitchScore").innerText = "--";
    document.getElementById("liveToneScore").innerText = "--";
}

function resetFinalResults() {
    document.getElementById("finalTotalScore").innerText = "--";
    document.getElementById("finalPitchScore").innerText = "--";
    document.getElementById("finalToneScore").innerText = "--";
    document.getElementById("finalRhythmScore").innerText = "--";
}

function moveToPage(pageId) {
    pageIds.forEach(function (id) {
        document.getElementById(id).classList.remove("active");
    });
    document.getElementById(pageId).classList.add("active");
    window.scrollTo(0, 0);
}
