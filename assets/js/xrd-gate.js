"use strict";

(() => {
  const storageName = "xrd-studio-open";
  const words = {
    en: {
      back: "← Software", eyebrow: "THIN-FILM X-RAY DIFFRACTION",
      description: "Simulate and fit symmetric θ–2θ scans in your browser. Enter your shared lab code, or request one from YeongUk Choi.",
      code: "Shared lab code", open: "Open XRD Studio", request: "Request a lab code ↗",
      accessNote: "The app can also be opened directly at its URL.",
      lock: "End session", checking: "Checking your lab code…", loading: "Opening XRD Studio…",
      ended: "Please enter the shared lab code again.",
      unavailable: "Browser access is being prepared. Please request a lab code by email.",
      wrong: "The lab code is incorrect.", denied: "Please check your lab code and try again.",
      lockout: "Too many incorrect codes. Please try again in 10 minutes.",
      network: "The code service could not be reached. Please try again.",
      config: "The code service is not ready. Please contact YeongUk Choi.",
      appError: "The app could not be loaded. Please refresh the page and try again.",
    },
    ko: {
      back: "← 소프트웨어", eyebrow: "박막 X선 회절",
      description: "브라우저에서 대칭 θ–2θ 스캔을 시뮬레이션하고 피팅합니다. 연구실 공용 코드를 입력하거나 최영욱에게 코드를 요청해 주세요.",
      code: "연구실 공용 코드", open: "XRD Studio 열기", request: "공용 코드 요청 ↗",
      accessNote: "앱 주소를 아는 사람은 코드 입력 없이 직접 열 수도 있습니다.",
      lock: "이용 종료", checking: "공용 코드를 확인하고 있습니다…", loading: "XRD Studio를 여는 중입니다…",
      ended: "연구실 공용 코드를 다시 입력해 주세요.",
      unavailable: "브라우저 실행을 준비하고 있습니다. 이메일로 공용 코드를 요청해 주세요.",
      wrong: "공용 코드가 올바르지 않습니다.", denied: "공용 코드를 확인하고 다시 시도해 주세요.",
      lockout: "코드 오류가 누적되어 잠겼습니다. 10분 후 다시 시도해 주세요.",
      network: "코드 확인 서비스에 연결하지 못했습니다. 다시 시도해 주세요.",
      config: "코드 확인 서비스가 아직 준비되지 않았습니다. 최영욱에게 문의해 주세요.",
      appError: "앱을 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.",
    },
  };
  const gate = document.getElementById("gate");
  const workspace = document.getElementById("workspace");
  const frame = document.getElementById("studio-frame");
  const status = document.getElementById("gate-status");
  const codeInput = document.getElementById("access-code");
  const button = document.getElementById("unlock-button");
  const config = window.XRD_GATE || {};
  const apiUrl = config.apiUrl || window.SITE?.ppms?.apiUrl;
  const requestedLocale = new URL(location.href).searchParams.get("lang");
  let locale = ["en", "ko"].includes(requestedLocale) ? requestedLocale
    : navigator.language.startsWith("ko") ? "ko" : "en";
  let statusKey = "", busy = false;
  const available = config.enabled === true && Boolean(apiUrl);

  function renderLanguage() {
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-text]").forEach((element) => {
      element.textContent = words[locale][element.dataset.text];
    });
    document.getElementById("gate-language").textContent = locale === "ko" ? "English" : "한국어";
    status.textContent = words[locale][statusKey] || "";
  }

  function setStatus(key) {
    statusKey = key;
    status.textContent = words[locale][key] || "";
  }

  function changeLanguage(next) {
    locale = next;
    const url = new URL(location.href);
    url.searchParams.set("lang", locale);
    history.replaceState(null, "", url);
    renderLanguage();
  }

  function setBusy(value) {
    busy = value;
    button.disabled = value || !available;
    codeInput.disabled = button.disabled;
  }

  function forget() {
    try { sessionStorage.removeItem(storageName); } catch (_) {}
  }

  function remember() {
    try { sessionStorage.setItem(storageName, "1"); } catch (_) {}
  }

  function closeApp() {
    frame.onload = null;
    frame.src = "about:blank";
    workspace.hidden = true;
    gate.hidden = false;
  }

  function showApp() {
    setStatus("loading");
    return new Promise((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        forget();
        closeApp();
        setStatus("appError");
        reject(new Error("appError"));
      };
      const timer = setTimeout(fail, 30000);
      frame.onload = () => {
        const app = frame.contentDocument;
        if (!app?.getElementById("settingsForm")) { fail(); return; }
        clearTimeout(timer);
        changeLanguage(app.documentElement.lang === "en" ? "en" : "ko");
        gate.hidden = true;
        workspace.hidden = false;
        remember();
        setStatus("");
        resolve();
      };
      frame.src = locale === "en" ? "assets/xrd/en/" : "assets/xrd/";
    });
  }

  function denial(result) {
    const message = String(result.error || "");
    if (/too many|lock/i.test(message)) return "lockout";
    if (/wrong/i.test(message)) return "wrong";
    if (/config|not set|not ready|invalid.*counter/i.test(message)) return "config";
    return "denied";
  }

  document.getElementById("unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !available) return;
    const code = codeInput.value;
    codeInput.value = "";
    forget();
    setBusy(true);
    setStatus("checking");
    try {
      const response = await fetch(apiUrl, {
        method: "POST", body: new URLSearchParams({action: "xrdcheck", code}),
        cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("network");
      const result = await response.json();
      if (result.ok !== true) throw new Error(denial(result));
      await showApp();
    } catch (error) {
      setStatus(words[locale][error.message] ? error.message : "network");
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("lock-button").addEventListener("click", () => {
    forget();
    closeApp(); // Discard the document and its dedicated fitting workers.
    setStatus("ended");
    codeInput.focus();
  });

  document.getElementById("gate-language").addEventListener("click", () => {
    changeLanguage(locale === "ko" ? "en" : "ko");
  });
  // Clear credentials left by the retired encrypted prototype; only a flag is used now.
  try { sessionStorage.removeItem("xrd-studio-session-key"); } catch (_) {}
  renderLanguage();
  setBusy(false);
  if (!available) { forget(); setStatus("unavailable"); return; }
  let opened = false;
  try { opened = sessionStorage.getItem(storageName) === "1"; } catch (_) {}
  if (opened) {
    setBusy(true);
    showApp().catch(() => setStatus("appError")).finally(() => setBusy(false));
  }
})();
