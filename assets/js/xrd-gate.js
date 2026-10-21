"use strict";

(() => {
  const storageName = "xrd-studio-session-key";
  const requiredFiles = ["index.html", "en/index.html", "app.js", "en/app.js",
    "styles.css", "xrd_core.js", "xrd_fit.js", "xrd_local.js", "xrd_worker.js",
    "xrd_data.json", "sample_data.dat", "favicon.svg"];
  const words = {
    en: {
      back: "← Software", eyebrow: "THIN-FILM X-RAY DIFFRACTION",
      description: "Simulate and fit symmetric θ–2θ scans in your browser. Enter the access code shared with your lab, or request one from YeongUk Choi.",
      code: "Access code", open: "Open XRD Studio", request: "Request an access code ↗",
      lock: "Lock this tab", refresh: "Refresh page", checking: "Checking your access code…",
      restoring: "Restoring this tab…", loading: "Opening XRD Studio…", locked: "This tab is locked.",
      unavailable: "Browser access is being prepared. Please request an access code by email.",
      unsupported: "Use a current browser over HTTPS to open XRD Studio.",
      wrong: "The access code is incorrect.", denied: "Access was not granted. Please check your code.",
      lockout: "Too many incorrect codes. Please try again in 10 minutes.",
      network: "The access service could not be reached. Please try again.",
      config: "The access service is not ready. Please contact YeongUk Choi.",
      update: "The app could not be opened because its files or key do not match. Refresh this page and enter your access code again. If this continues, contact YeongUk Choi.",
    },
    ko: {
      back: "← 소프트웨어", eyebrow: "박막 X선 회절",
      description: "브라우저에서 대칭 θ–2θ 스캔을 시뮬레이션하고 피팅합니다. 연구실에서 공유받은 암호를 입력하거나 최영욱에게 이용 암호를 요청해 주세요.",
      code: "이용 암호", open: "XRD Studio 열기", request: "이용 암호 요청 ↗",
      lock: "이 탭 잠그기", refresh: "새로고침", checking: "암호를 확인하고 있습니다…",
      restoring: "이 탭의 작업 화면을 여는 중입니다…", loading: "XRD Studio를 여는 중입니다…", locked: "이 탭을 잠갔습니다.",
      unavailable: "브라우저 실행을 준비하고 있습니다. 이메일로 이용 암호를 요청해 주세요.",
      unsupported: "HTTPS 연결과 최신 브라우저에서 XRD Studio를 열어 주세요.",
      wrong: "암호가 올바르지 않습니다.", denied: "접근할 수 없습니다. 암호를 확인해 주세요.",
      lockout: "암호 오류가 누적되어 잠겼습니다. 10분 후 다시 시도해 주세요.",
      network: "인증 서비스에 연결하지 못했습니다. 다시 시도해 주세요.",
      config: "인증 서비스가 아직 준비되지 않았습니다. 최영욱에게 문의해 주세요.",
      update: "앱 파일 또는 키의 버전이 맞지 않아 열지 못했습니다. 새로고침한 뒤 암호를 다시 입력해 주세요. 계속되면 최영욱에게 문의해 주세요.",
    },
  };
  const gate = document.getElementById("gate");
  const workspace = document.getElementById("workspace");
  const frame = document.getElementById("studio-frame");
  const status = document.getElementById("gate-status");
  const codeInput = document.getElementById("access-code");
  const button = document.getElementById("unlock-button");
  const refresh = document.getElementById("refresh-button");
  const config = window.XRD_GATE || {};
  const apiUrl = config.apiUrl || window.SITE?.ppms?.apiUrl;
  const requestedLocale = new URL(location.href).searchParams.get("lang");
  let locale = ["en", "ko"].includes(requestedLocale) ? requestedLocale
    : navigator.language.startsWith("ko") ? "ko" : "en";
  let statusKey = "", files = null, workerUrl = null, busy = false;
  const available = config.enabled === true && Boolean(apiUrl);
  const supported = Boolean(window.crypto?.subtle);

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
    refresh.hidden = key !== "update";
  }

  function setBusy(value) {
    busy = value;
    button.disabled = value || !available || !supported;
    codeInput.disabled = button.disabled;
  }

  function forget() {
    try { sessionStorage.removeItem(storageName); } catch (_) {}
  }

  function remember(session) {
    // Storage can be unavailable in private browsing; the current session still works.
    try { sessionStorage.setItem(storageName, JSON.stringify(session)); } catch (_) {}
  }

  function bytes(base64) {
    const raw = atob(base64);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  async function hash(value) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function inlineScript(source) {
    return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  }

  function embed() {
    const english = locale === "en";
    let html = files[english ? "en/index.html" : "index.html"];
    html = html.replace(/<script src="(?:\.\.\/)?(?:xrd_core|xrd_fit|xrd_local|app)\.js" defer><\/script>/g, "");
    html = html.replace(/<link rel="stylesheet" href="(?:\.\.\/)?styles\.css">/,
      () => `<style>${files["styles.css"].replace(/<\/style/gi, "<\\/style")}</style>`);
    html = html.replace(/href="(?:\.\.\/)?favicon\.svg"/,
      () => `href="data:image/svg+xml,${encodeURIComponent(files["favicon.svg"])}"`);
    const settings = {
      data: JSON.parse(files["xrd_data.json"]), sample: files["sample_data.dat"], workerUrl,
    };
    const scripts = [
      `window.XRDStaticAssets = ${JSON.stringify(settings)};`,
      files["xrd_core.js"], files["xrd_fit.js"], files["xrd_local.js"],
      files[english ? "en/app.js" : "app.js"],
    ].map(inlineScript).join("\n");
    return html.replace("</body>", () => `${scripts}\n</body>`);
  }

  function showApp() {
    gate.hidden = true;
    workspace.hidden = false;
    frame.onload = () => {
      const switchLink = frame.contentDocument?.getElementById("langSwitch");
      switchLink?.addEventListener("click", (event) => {
        event.preventDefault();
        locale = locale === "ko" ? "en" : "ko";
        renderLanguage();
        showApp();
      });
    };
    frame.srcdoc = embed();
  }

  async function loadApp(session) {
    try {
      if (session.version !== 1 || !/^[a-f0-9]{64}$/.test(session.build)) throw new Error();
      const manifestResponse = await fetch("assets/dl/xrd-app.manifest.json", {
        cache: "no-store", signal: AbortSignal.timeout(30000),
      });
      if (!manifestResponse.ok) throw new Error();
      const manifest = await manifestResponse.json();
      if (manifest.version !== 1 || manifest.build !== session.build ||
          manifest.bundle !== "xrd-app.enc" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error();
      const response = await fetch(`assets/dl/xrd-app.enc?v=${manifest.build}`, {
        cache: "no-store", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error();
      const rawEnvelope = await response.arrayBuffer();
      if (await hash(rawEnvelope) !== manifest.sha256) throw new Error();
      const envelope = JSON.parse(new TextDecoder().decode(rawEnvelope));
      if (envelope.version !== 1 || envelope.build !== manifest.build) throw new Error();
      const iv = bytes(envelope.iv), keyBytes = bytes(session.key);
      if (iv.length !== 12 || keyBytes.length !== 32) throw new Error();
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode(`xrd-studio:1:${envelope.build}`)}, key,
        bytes(envelope.ciphertext));
      if (await hash(plaintext) !== manifest.build) throw new Error();
      const packageData = JSON.parse(new TextDecoder().decode(plaintext));
      if (packageData.version !== 1 || !packageData.files ||
          requiredFiles.some((name) => typeof packageData.files[name] !== "string")) throw new Error();
      files = packageData.files;
      const workerSource = [files["xrd_core.js"], files["xrd_fit.js"],
        `self.XRDStaticData = ${JSON.stringify(JSON.parse(files["xrd_data.json"]))};`,
        files["xrd_worker.js"]].join("\n");
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      workerUrl = URL.createObjectURL(new Blob([workerSource], {type: "application/javascript"}));
      showApp();
      remember({key: session.key, version: session.version, build: session.build});
      setStatus("");
    } catch (_) {
      forget();
      files = null;
      throw new Error("update");
    }
  }

  function denial(result) {
    const message = String(result.error || "");
    if (/too many|lock/i.test(message)) return "lockout";
    if (/wrong/i.test(message)) return "wrong";
    if (/config|not set|not ready|invalid.*key|version/i.test(message)) return "config";
    return "denied";
  }

  document.getElementById("unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !available || !supported) return;
    const code = codeInput.value;
    codeInput.value = "";
    forget();
    setBusy(true);
    setStatus("checking");
    try {
      const response = await fetch(apiUrl, {
        method: "POST", body: new URLSearchParams({action: "xrdkey", code}),
        cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("network");
      const result = await response.json();
      if (!result.ok || !result.key) throw new Error(denial(result));
      setStatus("loading");
      await loadApp(result);
    } catch (error) {
      setStatus(words[locale][error.message] ? error.message : "network");
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("lock-button").addEventListener("click", () => {
    forget();
    frame.onload = null;
    frame.srcdoc = ""; // Discard the document and its dedicated fitting workers.
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = null;
    files = null;
    workspace.hidden = true;
    gate.hidden = false;
    setStatus("locked");
    codeInput.focus();
  });

  document.getElementById("gate-language").addEventListener("click", () => {
    locale = locale === "ko" ? "en" : "ko";
    const url = new URL(location.href);
    url.searchParams.set("lang", locale);
    history.replaceState(null, "", url);
    renderLanguage();
  });
  refresh.addEventListener("click", () => location.reload());
  renderLanguage();
  setBusy(false);
  if (!available) { forget(); setStatus("unavailable"); return; }
  if (!supported) { forget(); setStatus("unsupported"); return; }
  let remembered;
  try { remembered = JSON.parse(sessionStorage.getItem(storageName)); } catch (_) { forget(); }
  if (remembered) {
    setBusy(true);
    setStatus("restoring");
    loadApp(remembered).catch(() => setStatus("update")).finally(() => setBusy(false));
  }
})();
