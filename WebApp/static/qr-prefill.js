/* ============================================================================
 * qr-prefill.js  —  EFT Suite "Scan QR to Prefill" (operator side)
 * ----------------------------------------------------------------------------
 * Adds a button to the data-entry step that reads an applicant's pre-fill QR
 * (produced by intake.html) and populates #type2-form. Nothing is sent to the
 * server here — it only fills the existing form, then the operator clicks the
 * normal Generate button as usual. No backend or Docker changes required.
 *
 * INSTALL (one-time):
 *   1. Drop this file in WebApp/static/qr-prefill.js
 *   2. Drop the decoder library in WebApp/static/ (for offline use, vendor it):
 *        curl -L -o WebApp/static/html5-qrcode.min.js \
 *          https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js
 *   3. In WebApp/static/index.html, just before </body> add:
 *        <script src="/static/html5-qrcode.min.js"></script>
 *        <script src="/static/qr-prefill.js"></script>
 *
 * The Dockerfile does `COPY . /app`, so these static files are included
 * automatically on the next `docker build` -- no other changes needed.
 *
 * CAMERA NOTE: getUserMedia (live camera) only works on a "secure context":
 * http://localhost is fine, but a plain http:// LAN IP is not. The "Scan from
 * image" fallback (upload a photo of the QR) always works regardless.
 * ==========================================================================*/

(function () {
  "use strict";

  // ---- Helpers ------------------------------------------------------------
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // Expand single-char field names back to the form's name="" attributes
  const FEXPAND = {
    'n':'fname','m':'mname','l':'lname','d':'dob',
    'p':'2.020','c':'2.021','s':'2.016',
    'a':'addr_street','b':'addr_city','e':'addr_state','z':'addr_zip',
    'x':'2.024','r':'2.025','h':'2.027','w':'2.029','o':'2.031','i':'2.032'
  };
  function expandFields(compact) {
    if (!compact) return {};
    return Object.fromEntries(
      Object.entries(compact).map(([k, v]) => [FEXPAND[k] !== undefined ? FEXPAND[k] : k, v])
    );
  }
  function expandFlags(g) {
    if (!g) return {};
    // compact: nm=1 → no_mn:true, bs=1 → bypass_ssn:true
    const out = {};
    if (g.nm || g.no_mn)       out.no_mn = true;
    if (g.bs || g.bypass_ssn)  out.bypass_ssn = true;
    return out;
  }

  function setField(name, value) {
    const el = document.querySelector(`#type2-form [name="${CSS.escape(name)}"]`);
    if (!el) return;
    if (el.tagName === "SELECT") {
      const exists = Array.from(el.options).some((o) => o.value === String(value));
      if (!exists && value !== "" && value != null) {
        el.add(new Option(String(value), String(value)));
      }
    }
    el.value = value == null ? "" : value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyToForm(fields, flags) {
    Object.entries(fields || {}).forEach(([k, v]) => setField(k, v));
    flags = flags || {};
    const noMn = document.getElementById("no-mn");
    if (noMn) {
      noMn.checked = !!flags.no_mn;
      noMn.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const bypass = document.getElementById("bypass-ssn");
    if (bypass) {
      bypass.checked = !!flags.bypass_ssn;
      bypass.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ---- Decryption ---------------------------------------------------------
  async function decryptPayload(obj, passphrase) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: fromB64(obj.salt), iterations: 150000, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(obj.iv) }, key, fromB64(obj.ct)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---- Process decoded QR text --------------------------------------------
  async function handleDecodedText(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) {
      alert("That QR code isn't an EFT Suite pre-fill code.");
      return;
    }
    // Accept both legacy "eftsuite-intake" and compact "ei" type strings
    if (!obj || (obj.t !== "eftsuite-intake" && obj.t !== "ei")) {
      alert("That QR code isn't an EFT Suite pre-fill code.");
      return;
    }

    if (obj.enc === "AESGCM") {
      const MAX = 3;
      for (let attempt = 1; attempt <= MAX; attempt++) {
        const left = MAX - attempt + 1;
        const msg = attempt === 1
          ? "This pre-fill code is encrypted. Enter the applicant's passphrase:"
          : "Incorrect passphrase. " + left + " attempt" + (left === 1 ? "" : "s") +
            " left. Enter the passphrase:";
        const pass = prompt(msg);
        if (pass === null) return;
        try {
          const data = await decryptPayload(obj, pass);
          // Support both compact {f,g} and legacy {fields,flags} inner formats
          applyToForm(expandFields(data.f || data.fields), expandFlags(data.g || data.flags));
          closeScanner();
          flashStatus("Form pre-filled from QR. Please verify every field before generating.");
          return;
        } catch (e) {
          if (attempt === MAX) {
            alert("Incorrect passphrase -- all " + MAX + " attempts used. Scan or upload the code again to retry.");
            return;
          }
        }
      }
      return;
    }

    try {
      // Support both compact {f,g} and legacy {fields,flags} formats
      applyToForm(expandFields(obj.f || obj.fields), expandFlags(obj.g || obj.flags));
      closeScanner();
      flashStatus("Form pre-filled from QR. Please verify every field before generating.");
    } catch (e) {
      alert("Could not read the code.");
    }
  }

  // ---- Scanner UI ---------------------------------------------------------
  let overlay = null;
  let cameraStream = null;   // active getUserMedia stream

  function flashStatus(msg) {
    const n = document.createElement("div");
    n.textContent = msg;
    n.style.cssText =
      "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);" +
      "background:#1f6f3f;color:#fff;padding:12px 18px;border-radius:6px;" +
      "z-index:10000;max-width:90%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.4)";
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 6000);
  }

  function closeScanner() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function openScanner() {
    const hasBD = ('BarcodeDetector' in window);

    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;";
    overlay.innerHTML = `
      <div style="color:#fff;font-size:1.1rem;font-weight:bold;">Scan Applicant QR Code</div>

      <div style="position:relative;width:min(460px,92vw);background:#000;border-radius:8px;overflow:hidden;">
        <video id="qr-video" autoplay playsinline muted style="width:100%;display:block;"></video>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <div id="qr-aim-ring" style="width:260px;height:260px;border:2px solid rgba(186,218,85,.8);border-radius:10px;
                      box-shadow:0 0 0 9999px rgba(0,0,0,.35);transition:border-color .15s;"></div>
        </div>
      </div>

      <div id="qr-decode-tmp" style="display:none;"></div>
      <canvas id="qr-snap-canvas" style="display:none;max-width:200px;border:2px solid #555;border-radius:4px;"></canvas>
      <canvas id="qr-crop-canvas" style="display:none;"></canvas>

      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
        <button type="button" id="qr-snap-btn" class="btn"
                style="font-size:1rem;padding:12px 28px;">📸 Capture &amp; Decode</button>
        <label class="btn btn-secondary" style="cursor:pointer;margin:0;padding:12px 20px;">
          Upload image
          <input type="file" accept="image/*" id="qr-file-input" style="display:none;">
        </label>
        <button type="button" class="btn btn-secondary" id="qr-close-btn">Cancel</button>
      </div>

      <div id="qr-status" style="color:#bada55;font-size:.9rem;max-width:380px;text-align:center;min-height:1.4em;">
        Starting camera…
      </div>`;
    document.body.appendChild(overlay);

    const video      = document.getElementById("qr-video");
    const canvas     = document.getElementById("qr-snap-canvas");
    const cropCanvas = document.getElementById("qr-crop-canvas");
    const snapBtn    = document.getElementById("qr-snap-btn");
    const aimRing    = document.getElementById("qr-aim-ring");

    const setStatus = (msg, isError) => {
      const el = document.getElementById("qr-status");
      if (el) { el.textContent = msg; el.style.color = isError ? "#ffb4b4" : "#bada55"; }
    };

    function stopCamera() {
      if (cameraStream) {
        if (cameraStream._stopScan) cameraStream._stopScan();
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
      }
    }

    // Decode a File/Blob: BarcodeDetector → ZXing fallback
    async function decodeFileObj(file) {
      if (hasBD) {
        try {
          const detector = new BarcodeDetector({ formats: ['qr_code'] });
          const bitmap = await createImageBitmap(file);
          const codes = await detector.detect(bitmap);
          if (codes.length > 0) return codes[0].rawValue;
        } catch (_) {}
      }
      if (typeof Html5Qrcode !== "undefined") {
        const reader = new Html5Qrcode("qr-decode-tmp");
        return reader.scanFile(file, false)
          .finally(() => { try { reader.clear(); } catch (_) {} });
      }
      throw new Error("No decoder available");
    }

    // ---- close ----
    document.getElementById("qr-close-btn").onclick = () => { stopCamera(); closeScanner(); };

    // ---- upload fallback ----
    document.getElementById("qr-file-input").onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      setStatus("Decoding image…", false);
      decodeFileObj(file)
        .then((decoded) => { stopCamera(); handleDecodedText(decoded); })
        .catch(() => setStatus("No QR code found — try a clearer image.", true))
        .finally(() => { e.target.value = ""; });
    };

    // ---- snap: try ImageCapture first (no canvas taint), then canvas fallback ----
    snapBtn.onclick = async () => {
      if (!cameraStream || video.videoWidth === 0) {
        setStatus("Camera not ready yet — wait a moment.", true);
        return;
      }
      setStatus("Decoding…", false);
      snapBtn.disabled = true;

      try {
        let result = null;

        if (hasBD) {
          const detector = new BarcodeDetector({ formats: ['qr_code'] });

          // 1. ImageCapture.grabFrame() — straight from camera track, no canvas taint
          if ('ImageCapture' in window && cameraStream.getVideoTracks().length) {
            try {
              const ic = new ImageCapture(cameraStream.getVideoTracks()[0]);
              const bitmap = await ic.grabFrame();
              const codes = await detector.detect(bitmap);
              if (codes.length) result = codes[0].rawValue;
            } catch (_) {}
          }

          // 2. Canvas capture — show preview thumbnail so user can see what was captured
          if (result === null) {
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d").drawImage(video, 0, 0);
            canvas.style.display = "block";
            const codes = await detector.detect(canvas);
            if (codes.length) result = codes[0].rawValue;
          }

          // 3. Center-square crop upscaled to 512px
          if (result === null && canvas.width > 0) {
            const sq = Math.min(canvas.width, canvas.height);
            cropCanvas.width  = 512;
            cropCanvas.height = 512;
            cropCanvas.getContext("2d").drawImage(
              canvas,
              (canvas.width - sq) / 2, (canvas.height - sq) / 2, sq, sq,
              0, 0, 512, 512
            );
            const codes = await detector.detect(cropCanvas);
            if (codes.length) result = codes[0].rawValue;
          }
        }

        // 4. ZXing fallback via Html5Qrcode
        if (result === null && typeof Html5Qrcode !== "undefined" && canvas.width > 0) {
          result = await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (!blob) { reject(new Error("toBlob returned null")); return; }
              const reader = new Html5Qrcode("qr-decode-tmp");
              reader.scanFile(new File([blob], "snap.png", { type: "image/png" }), false)
                .then(resolve).catch(reject)
                .finally(() => { try { reader.clear(); } catch (_) {} });
            }, "image/png");
          });
        }

        if (!result) throw new Error("QR code not detected in frame");
        canvas.style.display = "none";
        stopCamera();
        handleDecodedText(result);
      } catch (err) {
        const msg = (err && (err.message || err.name)) || "unknown";
        setStatus(`No QR code found (${msg}) — re-aim and try again.`, true);
        snapBtn.disabled = false;
      }
    };

    // ---- camera ----
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera unavailable (needs https:// or localhost). Use 'Upload image'.", true);
      snapBtn.disabled = true;
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    })
    .then((stream) => {
      cameraStream = stream;
      video.srcObject = stream;

      if (hasBD) {
        // ── AUTO-SCAN in background — also keep Capture button visible ──
        setStatus("Auto-scanning… or press Capture to force a decode.", false);
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        let active = true;
        let lastTs = 0;
        cameraStream._stopScan = () => { active = false; };

        // Use ImageCapture.grabFrame() if available — no canvas, no taint issues
        const videoTrack = stream.getVideoTracks()[0];
        const ic = ('ImageCapture' in window && videoTrack) ? new ImageCapture(videoTrack) : null;

        function scanTick(ts) {
          if (!active || !cameraStream) return;
          if (ts - lastTs >= 400 && video.readyState >= 2 && video.videoWidth > 0) {
            lastTs = ts;
            const grab = ic
              ? ic.grabFrame().then((bmp) => detector.detect(bmp))
              : Promise.resolve([]);
            grab.then((codes) => {
              if (!active) return;
              if (codes.length > 0) {
                active = false;
                if (aimRing) aimRing.style.borderColor = "#55ff55";
                stopCamera();
                handleDecodedText(codes[0].rawValue);
              } else {
                requestAnimationFrame(scanTick);
              }
            }).catch(() => { if (active) requestAnimationFrame(scanTick); });
          } else {
            requestAnimationFrame(scanTick);
          }
        }
        requestAnimationFrame(scanTick);

      } else {
        setStatus("Aim the QR code in the box, then press Capture.", false);
      }
    })
    .catch((err) => {
      const n = (err && err.name) || "";
      const msg = /NotAllowedError|Permission/i.test(n)
        ? "Camera permission denied — allow access and reopen, or use 'Upload image'."
        : /NotFoundError/i.test(n) ? "No camera found. Use 'Upload image'."
        : "Camera error (" + (err.message || n) + "). Use 'Upload image'.";
      setStatus(msg, true);
      snapBtn.disabled = true;
    });
  }

  // ---- Inject button ------------------------------------------------------
  function injectButton() {
    const form = document.getElementById("type2-form");
    if (!form || document.getElementById("btn-scan-qr")) return;
    const bar = document.createElement("div");
    bar.style.cssText = "margin-bottom:16px;";
    bar.innerHTML =
      `<button type="button" id="btn-scan-qr" class="btn btn-secondary" style="width:100%;">
         Scan QR to Prefill
       </button>
       <div style="color:#aaa;font-size:.85rem;margin-top:6px;text-align:center;">
         Optional: scan an applicant's pre-fill QR, then verify every field.
       </div>`;
    form.parentNode.insertBefore(bar, form);
    document.getElementById("btn-scan-qr").onclick = openScanner;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectButton);
  } else {
    injectButton();
  }
})();
