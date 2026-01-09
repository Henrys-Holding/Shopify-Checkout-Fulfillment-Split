(async function () {
  const roots = document.querySelectorAll(".ccv-root");
  if (!roots.length) return;

  const DEFAULT_MAX_FILES = 3;
  const DEFAULT_MAX_MB = 5;

  const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);
  const ACCEPT_ATTR = ".jpg,.jpeg,.png";

  // -------------------------
  // Modal singleton
  // -------------------------
  let modal = null;

  function ensureModal() {
    if (modal) return modal;

    const overlay = document.createElement("div");
    overlay.className = "ccv-modal-overlay";
    overlay.style.display = "none";

    overlay.innerHTML = `
      <div class="ccv-modal" role="dialog" aria-modal="true">
        <div class="ccv-modal-header">
          <div class="ccv-modal-title"></div>
          <button class="ccv-modal-close" type="button" aria-label="Close">×</button>
        </div>

        <div class="ccv-modal-body">
          <div class="ccv-dropzone" tabindex="0" role="button" aria-label="Add files">
            <input class="ccv-file-input" type="file" accept="${ACCEPT_ATTR}" multiple />
            <button class="ccv-addfiles" type="button">Add files</button>
            <div class="ccv-helptext"></div>
            <div class="ccv-drop-hint">or drag & drop images here</div>
          </div>

          <div class="ccv-filelist"></div>
          <div class="ccv-errorline" style="display:none"></div>
          <div class="ccv-successline" style="display:none"></div>
        </div>

        <div class="ccv-modal-footer">
          <button class="ccv-btn ccv-cancel" type="button">Cancel</button>
          <button class="ccv-btn ccv-btn-primary ccv-confirm" type="button" disabled>Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector(".ccv-modal-title");
    const closeBtn = overlay.querySelector(".ccv-modal-close");
    const cancelBtn = overlay.querySelector(".ccv-cancel");
    const confirmBtn = overlay.querySelector(".ccv-confirm");
    const addBtn = overlay.querySelector(".ccv-addfiles");
    const fileInput = overlay.querySelector(".ccv-file-input");
    const helpText = overlay.querySelector(".ccv-helptext");
    const fileList = overlay.querySelector(".ccv-filelist");
    const errEl = overlay.querySelector(".ccv-errorline");
    const okEl = overlay.querySelector(".ccv-successline");
    const dropzone = overlay.querySelector(".ccv-dropzone");

    // Hide the raw input UI (we trigger it via button/zone)
    fileInput.style.display = "none";

    function revokeAllPreviews() {
      const items = modal?.state?.items || [];
      for (const it of items) {
        if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      }
    }

    function closeModal() {
      overlay.style.display = "none";
      // cleanup previews
      revokeAllPreviews();
      if (modal) modal.state.items = [];
    }

    function showError(msg) {
      okEl.style.display = "none";
      errEl.style.display = msg ? "block" : "none";
      errEl.textContent = msg || "";
    }

    function showSuccess(msg) {
      errEl.style.display = "none";
      okEl.style.display = msg ? "block" : "none";
      okEl.textContent = msg || "";
    }

    // click outside modal closes
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    closeBtn.addEventListener("click", closeModal);
    cancelBtn.addEventListener("click", closeModal);

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.style.display !== "none") closeModal();
    });

    // Clicking dropzone opens picker too
    dropzone.addEventListener("click", (e) => {
      // don't double-trigger when clicking the button itself
      const isButton = e.target && e.target.closest && e.target.closest(".ccv-addfiles");
      if (!isButton) fileInput.click();
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    addBtn.addEventListener("click", (e) => {
      e.preventDefault();
      fileInput.click();
    });

    modal = {
      overlay,
      titleEl,
      helpText,
      fileInput,
      fileList,
      errEl,
      okEl,
      confirmBtn,
      closeModal,
      state: {
        verificationId: null,
        uploadEndpoint: null,
        maxFiles: DEFAULT_MAX_FILES,
        maxBytes: DEFAULT_MAX_MB * 1024 * 1024,
        maxMb: DEFAULT_MAX_MB,
        // items: [{ file: File, previewUrl: string }]
        items: [],
        busy: false,
        onSuccess: null,
      },
    };

    fileInput.addEventListener("change", () => {
      const picked = Array.from(fileInput.files || []);
      fileInput.value = "";
      addFiles(picked);
    });

    // Drag & Drop support
    // Prevent browser from opening the file
    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "dragend", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("is-dragover");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      const picked = dt ? Array.from(dt.files || []) : [];
      if (picked.length) addFiles(picked);
    });

    confirmBtn.addEventListener("click", async () => {
      if (modal.state.busy) return;
      await doUpload();
    });

    function renderFiles() {
      fileList.innerHTML = "";

      if (!modal.state.items.length) {
        confirmBtn.disabled = true;
        return;
      }

      // thumbs grid
      const grid = document.createElement("div");
      grid.className = "ccv-thumbgrid";

      modal.state.items.forEach((it, idx) => {
        const sizeMB = (it.file.size / 1024 / 1024).toFixed(2);

        const card = document.createElement("div");
        card.className = "ccv-thumbcard";

        card.innerHTML = `
          <div class="ccv-thumbwrap">
            <img class="ccv-thumb" alt="Preview ${idx + 1}" />
          </div>
          <div class="ccv-thumbmeta">
            <div class="ccv-thumbname">${escapeHtml(it.file.name)}</div>
            <div class="ccv-thumbsize">${sizeMB} MB</div>
          </div>
          <button type="button" class="ccv-thumbremove" aria-label="Remove">Remove</button>
        `;

        const img = card.querySelector(".ccv-thumb");
        img.src = it.previewUrl;

        card.querySelector(".ccv-thumbremove").addEventListener("click", () => {
          // revoke preview URL
          if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
          modal.state.items.splice(idx, 1);
          showError("");
          renderFiles();
        });

        grid.appendChild(card);
      });

      fileList.appendChild(grid);
      confirmBtn.disabled = false;
    }

    function validatePickedFiles(picked) {
      const invalid = picked.find((f) => !ALLOWED_MIME.has(f.type));
      if (invalid) return "Only .jpg/.jpeg/.png images are allowed.";

      const tooBig = picked.find((f) => f.size > modal.state.maxBytes);
      if (tooBig) {
        return `"${tooBig.name}" is too large. Max ${modal.state.maxMb}MB per file.`;
      }

      return null;
    }

    function addFiles(picked) {
      showError("");
      showSuccess("");

      // Filter out directories / empty picks
      picked = picked.filter((f) => f && typeof f.size === "number");

      const err = validatePickedFiles(picked);
      if (err) {
        showError(err);
        return;
      }

      // Combine with existing, enforce max count
      const remainingSlots = modal.state.maxFiles - modal.state.items.length;
      if (remainingSlots <= 0) {
        showError(`You can upload up to ${modal.state.maxFiles} files.`);
        return;
      }

      let toAdd = picked.slice(0, remainingSlots);
      if (picked.length > remainingSlots) {
        showError(`You can upload up to ${modal.state.maxFiles} files.`);
      }

      const newItems = toAdd.map((file) => ({
        file,
        previewUrl: URL.createObjectURL(file),
      }));

      modal.state.items = modal.state.items.concat(newItems);
      renderFiles();
    }

    async function doUpload() {
      showError("");
      showSuccess("");

      const { uploadEndpoint, verificationId, items } = modal.state;

      if (!uploadEndpoint) return showError("Missing upload endpoint.");
      if (!verificationId) return showError("Missing verification id.");
      if (!items.length) return showError("Please add at least 1 image.");

      modal.state.busy = true;
      confirmBtn.disabled = true;

      try {
        const fd = new FormData();
        fd.append("verificationId", verificationId);
        items.forEach((it) => fd.append("files", it.file)); // server reads `files`

        const res = await fetch(uploadEndpoint, {
          method: "POST",
          body: fd,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          let msg = `Upload failed (${res.status}).`;
          try {
            const j = await res.json();
            msg = j?.message || msg;
          } catch {}
          throw new Error(msg);
        }

        showSuccess("Uploaded successfully.");

        if (typeof modal.state.onSuccess === "function") {
          await modal.state.onSuccess();
        }

        // cleanup previews then close
        revokeAllPreviews();
        modal.state.items = [];

        setTimeout(() => modal.closeModal(), 700);
      } catch (e) {
        showError(e?.message || "Upload failed.");
      } finally {
        modal.state.busy = false;
        confirmBtn.disabled = !modal.state.items.length;
      }
    }

    modal.api = {
      open({ verificationId, uploadEndpoint, maxFiles, maxMb, onSuccess }) {
        // reset previous previews
        revokeAllPreviews();

        modal.state.verificationId = verificationId;
        modal.state.uploadEndpoint = uploadEndpoint;
        modal.state.maxFiles = Number.isFinite(maxFiles) ? maxFiles : DEFAULT_MAX_FILES;
        modal.state.maxMb = Number.isFinite(maxMb) ? maxMb : DEFAULT_MAX_MB;
        modal.state.maxBytes = modal.state.maxMb * 1024 * 1024;
        modal.state.items = [];
        modal.state.busy = false;
        modal.state.onSuccess = onSuccess || null;

        titleEl.textContent = `Upload photo for ${verificationId}?`;
        helpText.textContent = `Accepts .jpg, .jpeg, .png — max ${modal.state.maxFiles} files — max ${modal.state.maxMb}MB each`;

        showError("");
        showSuccess("");
        renderFiles();

        overlay.style.display = "flex";
      },
    };

    return modal;
  }

  // -------------------------
  // Render list per root
  // -------------------------
  async function loadAndRender(root) {
    const endpoint = root.dataset.endpoint;
    if (!endpoint) return;

    root.innerHTML = `<div class="ccv-loading">Loading...</div>`;

    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      root.innerHTML = `<div class="ccv-error">Failed to load.</div>`;
      return;
    }

    const data = await res.json();

    if (!data.loggedIn) {
      root.innerHTML = `<div class="ccv-logged-out">Please log in to view your verification status.</div>`;
      return;
    }

    const items = data.verifications || [];
    if (!items.length) {
      root.innerHTML = `<div class="ccv-empty">No verification records.</div>`;
      return;
    }

    const uploadEndpoint = root.dataset.uploadEndpoint || "";
    const maxFiles = parseInt(root.dataset.maxFiles || "", 10) || DEFAULT_MAX_FILES;
    const maxMb = parseInt(root.dataset.maxMb || "", 10) || DEFAULT_MAX_MB;
    const uploadText = root.dataset.uploadText || "Upload";

    const rows = items
      .map((v) => {
        const orders = (v.orders || []).map((o) => o.number).join(", ");
        const created = new Date(v.createdAt).toLocaleString();

        const canUpload = v.status === "PENDING_SUBMISSION";
        const action =
          canUpload && uploadEndpoint
            ? `<button
                 type="button"
                 class="ccv-upload-btn"
                 data-vid="${escapeHtml(v.id)}"
               >${escapeHtml(uploadText)}</button>`
            : "";

        return `
          <tr>
            <td>•••• ${escapeHtml(v.last4)}</td>
            <td>${escapeHtml(v.company || "")}</td>
            <td>${escapeHtml(v.status)}</td>
            <td>${escapeHtml(orders)}</td>
            <td>${escapeHtml(created)}</td>
            <td>${action}</td>
          </tr>
        `;
      })
      .join("");

    root.innerHTML = `
      <div class="ccv-title">${escapeHtml(root.dataset.title || "Card verification")}</div>
      <div class="ccv-table-wrap">
        <table class="ccv-table">
          <thead>
            <tr>
              <th>Card</th>
              <th>Company</th>
              <th>Status</th>
              <th>Orders</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    root.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".ccv-upload-btn") : null;
      if (!btn) return;

      const vid = btn.getAttribute("data-vid");
      if (!vid) return;

      const m = ensureModal();
      m.api.open({
        verificationId: vid,
        uploadEndpoint,
        maxFiles,
        maxMb,
        onSuccess: async () => {
          await loadAndRender(root);
        },
      });
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  for (const root of roots) {
    try {
      await loadAndRender(root);
    } catch (e) {
      root.innerHTML = `<div class="ccv-error">Error loading data.</div>`;
    }
  }
})();
