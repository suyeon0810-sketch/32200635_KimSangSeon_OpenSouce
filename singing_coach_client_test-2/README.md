# 노래 코칭 프로그램 클라이언트

## 실행 방법

1. 서버가 실행 중인지 확인합니다.
   - 서버 주소: `http://172.22.140.223:8000`
   - 업로드 API: `POST /upload`
2. `index.html`을 브라우저에서 엽니다.
3. 원곡 파일과 사용자 녹음 파일을 선택한 뒤 `분석 요청`을 누릅니다.

## API 연결 내용

### 업로드 API

클라이언트는 `FormData`를 사용해서 파일 2개를 서버로 전송합니다.

- `original_file`: 원곡 음성 파일
- `user_file`: 사용자 녹음 파일 또는 브라우저에서 바로 녹음한 음성 Blob

주의: `Content-Type`은 직접 지정하지 않습니다. 브라우저가 `multipart/form-data`로 자동 설정합니다.

### 결과 조회 API 기본 틀

업로드 성공 후 서버가 반환한 `session_id`를 저장하고, 결과 화면으로 이동할 때 아래 형태의 API를 호출할 수 있도록 기본 틀을 만들어 두었습니다.

```js
GET http://172.22.140.223:8000/result/{session_id}
```

서버의 실제 결과 조회 API 주소가 달라지면 `script.js` 상단의 `RESULT_API_URL` 함수만 수정하면 됩니다.

```js
const RESULT_API_URL = (sessionId) => `${API_BASE_URL}/result/${sessionId}`;
```

## 수정한 주요 파일

- `index.html`: 기존 화면 구조 유지
- `script.js`: 업로드 API 연결, 결과 조회 API 기본 틀, session_id 저장 처리
- `style.css`: 기존 디자인 유지
