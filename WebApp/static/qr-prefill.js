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
 * automatically on the next `docker build` — no other changes needed.
 *
 * CAMERA NOTE: getUserMedia (live camera) only works on a "secure context":
 * http://localhost is fine, but a plain http:// LAN IP is not. The "Scan from
 * image" fallback (upload a photo of the QR) always works regardless.
 * ==========================================================================*/

(function () {
  "use strict";

  // ---- Helpers ------------------------------------------------------------
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // Set a form field by name. For <select>, create the option if missing so a
  // value still applies even if dropdowns haven't fully populated yet.
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

  // ---- Decryption (mirrors intake.html) -----------------------------------
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
    try {
      obj = JSON.parse(text);
    } catch (e) {
      alert("That QR code isn't an EFT Suite pre-fill code.");
      return;
    }
    if (!obj || obj.t !== "eftsuite-intake") {
      alert("That QR code isn't an EFT Suite pre-fill code.");
      return;
    }

    try {
      if (obj.enc === "AESGCM") {
        const pass = prompt("This pre-fill code is encrypted. Enter the applicant's passphrase:");
        if (pass == null) return;
        const data = await decryptPayload(obj, pass);
        applyToForm(data.fields, data.flags);
      } else {
        applyToForm(obj.fields, obj.flags);
      }
      closeScanner();
      flashStatus("Form pre-filled from QR. Please verify every field before generating.");
    } catch (e) {
      alert("Could not read the code. If it's encrypted, the passphrase may be wrong.");
    }
  }

  // ---- Minimal scanner UI (built dynamically; no index.html markup needed) -
  let html5Qr = null;
  let overlay = null;

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
    if (html5Qr) {
      html5Qr.stop().catch(() => {}).finally(() => {
        try { html5Qr.clear(); } catch (e) {}
        html5Qr = null;
      });
    }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function openScanner() {
    if (typeof Html5Qrcode === "undefined") {
      alert("QR decoder library not loaded. Add html5-qrcode.min.js (see qr-prefill.js header).");
      return;
    }

    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;";
    overlay.innerHTML = `
      <div style="color:#fff;font-size:1.1rem;font-weight:bold;">Scan Applicant QR Code</div>
      <div id="qr-reader" style="width:320px;max-width:90vw;background:#000;border-radius:8px;overflow:hidden;"></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
        <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
          Scan from image
          <input type="file" accept="image/*" id="qr-file-input" style="display:none;">
        </label>
        <button type="button" class="btn btn-secondary" id="qr-close-btn">Cancel</button>
      </div>
      <div style="color:#aaa;font-size:.85rem;max-width:340px;text-align:center;">
        Camera requires localhost or HTTPS. Otherwise use "Scan from image"
        with a photo of the QR.
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById("qr-close-btn").onclick = closeScanner;

    document.getElementById("qr-file-input").onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const scanner = new Html5Qrcode("qr-reader", /* verbose */ false);
      scanner.scanFile(file, true)
        .then((decoded) => { scanner.clear(); handleDecodedText(decoded); })
        .catch(() => alert("No QR code found in that image. Try a clearer, straight-on photo."));
    };

    // Try the live camera (best effort).
    html5Qr = new Html5Qrcode("qr-reader", /* verbose */ false);
    Html5Qrcode.getCameras()
      .then((cams) => {
        if (!cams || !cams.length) return; // file fallback still available
        const camId = (cams.find((c) => /back|rear|environment/i.test(c.label)) || cams[0]).id;
        html5Qr.start(
          camId,
          { fps: 10, qrbox: 250 },
          (decoded) => { handleDecodedText(decoded); },
          () => {} // ignore per-frame "not found" errors
        ).catch(() => {});
      })
      .catch(() => { /* no camera / insecure context — file fallback remains */ });
  }

  // ---- Inject the "Scan QR to Prefill" button into the data-entry step -----
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
