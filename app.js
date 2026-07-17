(() => {
  "use strict";

  // ---------- Small utilities ----------

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function todayStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function sanitizeFileName(name) {
    const cleaned = (name || "").replace(/[/\\:*?"<>|]/g, "-").trim();
    return cleaned || "MedRecall Visit";
  }

  let toastTimer = null;
  function showToast(message, duration = 3200) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
  }

  // ---------- Persistent storage (doctors + visit history) ----------
  // Visit history stores transcript text + metadata, not the binary .docx —
  // the file is regenerated on demand from that data, keeping localStorage small.

  const Store = {
    doctorsKey: "medrecall.doctors",
    visitsKey: "medrecall.visits",

    getDoctors() {
      const raw = localStorage.getItem(this.doctorsKey);
      if (raw) {
        try { return JSON.parse(raw); } catch (e) { /* fall through */ }
      }
      const defaults = [
        { id: uuid(), name: "Dr. Smith", specialty: "Primary Care" },
        { id: uuid(), name: "Dr. Patel", specialty: "Cardiology" }
      ];
      this.saveDoctors(defaults);
      return defaults;
    },
    saveDoctors(list) {
      localStorage.setItem(this.doctorsKey, JSON.stringify(list));
      notifyDataChanged();
    },
    getVisits() {
      const raw = localStorage.getItem(this.visitsKey);
      if (!raw) return [];
      try { return JSON.parse(raw); } catch (e) { return []; }
    },
    saveVisits(list) {
      localStorage.setItem(this.visitsKey, JSON.stringify(list));
      notifyDataChanged();
    }
  };

  // ---------- Audio recording ----------
  // Safari only finalizes an MP4 recording's metadata when MediaRecorder.stop()
  // is called — a blob built from chunks of a still-running recorder can't be
  // decoded. So instead of one long recording, this rolls through a series of
  // short (~12s) recordings back-to-back: each one is properly stopped and
  // finalized (and so, decodable) the moment it ends, and the next one starts
  // immediately after. The gap between segments is a few milliseconds.

  const SEGMENT_MS = 12000;

  class AudioRecorder {
    static get preferredMimeType() {
      const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
      for (const type of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
      }
      return "";
    }

    // onSegment(blob) fires each time a segment finishes (including the final,
    // possibly-short one after stop() is called).
    async start({ onSegment } = {}) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.onSegment = onSegment;
      this.stopped = false;
      this._beginSegment();
    }

    _beginSegment() {
      if (this.stopped) return;
      const mimeType = AudioRecorder.preferredMimeType;
      const recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);
      const chunks = [];

      recorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      });

      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 0 && this.onSegment) this.onSegment(blob);
        if (!this.stopped) this._beginSegment();
      });

      this.currentRecorder = recorder;
      recorder.start();
      this.segmentTimer = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, SEGMENT_MS);
    }

    stop() {
      return new Promise((resolve) => {
        this.stopped = true;
        clearTimeout(this.segmentTimer);
        const recorder = this.currentRecorder;
        if (!recorder || recorder.state === "inactive") {
          this.stream.getTracks().forEach((t) => t.stop());
          resolve();
          return;
        }
        recorder.addEventListener("stop", () => {
          this.stream.getTracks().forEach((t) => t.stop());
          resolve();
        }, { once: true });
        recorder.stop();
      });
    }

    pause() {
      if (this.currentRecorder && this.currentRecorder.state === "recording") {
        this.currentRecorder.pause();
      }
      clearTimeout(this.segmentTimer);
    }

    resume() {
      if (this.currentRecorder && this.currentRecorder.state === "paused") {
        this.currentRecorder.resume();
        const recorder = this.currentRecorder;
        this.segmentTimer = setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, SEGMENT_MS);
      }
    }
  }

  // ---------- Transcription (Whisper AI, running entirely in the browser) ----------
  // Uses transformers.js (https://github.com/xenova/transformers.js) to run an
  // open-source Whisper model client-side via WebAssembly. Nothing is uploaded
  // anywhere for this step — the model downloads once (and is cached by the
  // browser), then all transcription happens locally on the device.
  //
  // whisper-tiny.en is used (rather than whisper-base.en) to keep each
  // segment fast. If you'd rather trade speed for accuracy, change the model
  // name below to "Xenova/whisper-base.en".

  const WHISPER_MODEL = "Xenova/whisper-tiny.en";

  const Whisper = {
    pipelinePromise: null,

    getPipeline(onProgress) {
      if (!this.pipelinePromise) {
        this.pipelinePromise = (async () => {
          const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
          env.allowLocalModels = false;
          return pipeline("automatic-speech-recognition", WHISPER_MODEL, {
            progress_callback: onProgress
          });
        })();
      }
      return this.pipelinePromise;
    },

    async decodeToMono16k(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx({ sampleRate: 16000 });
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      let audio;
      if (audioBuffer.numberOfChannels > 1) {
        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.getChannelData(1);
        audio = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) audio[i] = (ch0[i] + ch1[i]) / 2;
      } else {
        audio = audioBuffer.getChannelData(0);
      }
      await audioCtx.close();
      return audio;
    }
  };

  // ---------- Progressive transcription controller ----------
  // Each finished (finalized) segment is queued and transcribed in order. By
  // the time the user taps Stop, all earlier segments are already done —
  // only the final, short segment is left to process.

  // Whisper (especially the tiny model used here) has a well-documented
  // tendency to hallucinate a short phrase over and over when a chunk has a
  // brief burst of speech followed by a lot of near-silence — e.g. someone
  // says "Good morning" and then there's dead air while they get settled.
  // Three layers of defense against that, cheapest/most-preventive first:
  //  1. Skip transcribing segments that are essentially silent to begin with.
  //  2. Ask the model itself to penalize repeats during generation.
  //  3. As a safety net regardless of the above, detect and collapse any
  //     phrase that repeats 3+ times back-to-back in the resulting text.

  const SILENCE_RMS_THRESHOLD = 0.004;

  function computeRms(float32Audio) {
    if (!float32Audio || float32Audio.length === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < float32Audio.length; i++) {
      sumSquares += float32Audio[i] * float32Audio[i];
    }
    return Math.sqrt(sumSquares / float32Audio.length);
  }

  function collapseRepeatedPhrases(text) {
    if (!text) return text;
    const tokens = text.split(/\s+/).filter(Boolean);
    const normalize = (w) => w.toLowerCase().replace(/[.,!?;:]+$/, "");

    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let collapsedHere = false;
      const maxPhraseLen = Math.min(8, Math.floor((tokens.length - i) / 3));
      // Check shortest candidate phrase length first, so a run collapses
      // down to its true fundamental repeating unit — e.g. "good morning"
      // repeated 47 times has to be caught via the 2-word unit, not get
      // stuck part-way through treating some larger multiple of it as
      // "the" repeating phrase.
      for (let len = 1; len <= maxPhraseLen; len++) {
        const phrase = tokens.slice(i, i + len).map(normalize).join(" ");
        if (!phrase) continue;
        let repeatCount = 1;
        while (
          i + (repeatCount + 1) * len <= tokens.length &&
          tokens.slice(i + repeatCount * len, i + (repeatCount + 1) * len).map(normalize).join(" ") === phrase
        ) {
          repeatCount++;
        }
        if (repeatCount >= 3) {
          out.push(...tokens.slice(i, i + len));
          i += repeatCount * len;
          collapsedHere = true;
          break;
        }
      }
      if (!collapsedHere) {
        out.push(tokens[i]);
        i++;
      }
    }
    return out.join(" ");
  }

  const ProgressiveTranscriber = {
    transcriptSoFar: "",
    queue: Promise.resolve(),

    reset() {
      this.transcriptSoFar = "";
      this.queue = Promise.resolve();
    },

    enqueueSegment(blob, { onPartial, onModelProgress } = {}) {
      this.queue = this.queue.then(async () => {
        try {
          const audio = await Whisper.decodeToMono16k(blob);
          if (audio.length === 0) return;
          if (computeRms(audio) < SILENCE_RMS_THRESHOLD) {
            // Essentially silent segment (dead air, room tone) — skip
            // transcribing it entirely rather than risk Whisper hallucinating
            // something to fill the gap.
            return;
          }
          const transcriber = await Whisper.getPipeline(onModelProgress);
          const result = await transcriber(audio, {
            chunk_length_s: 30,
            stride_length_s: 5,
            no_repeat_ngram_size: 3,
            repetition_penalty: 1.3
          });
          const text = collapseRepeatedPhrases((result.text || "").trim());
          if (text) {
            this.transcriptSoFar += (this.transcriptSoFar ? " " : "") + text;
            if (onPartial) onPartial(this.transcriptSoFar);
          }
        } catch (err) {
          // Skip a segment that failed to decode/transcribe rather than
          // interrupting the recording or the rest of the queue.
        }
      });
      return this.queue;
    },

    async finalize() {
      await this.queue;
      // One more collapse pass across the fully assembled transcript, in
      // case a repeat loop happened to straddle two segments.
      this.transcriptSoFar = collapseRepeatedPhrases(this.transcriptSoFar);
      return this.transcriptSoFar;
    }
  };

  // ---------- Google Drive (Google Identity Services token client) ----------

  const Drive = {
    tokenClient: null,
    accessToken: null,
    backupFileName: "MedRecall Backup.json",
    backupFileIdKey: "medrecall.driveBackupFileId",
    targetFolderName: "MedRecall",
    folderIdKey: "medrecall.driveFolderId",
    doctorFolderMapKey: "medrecall.driveDoctorFolderMap",

    init() {
      if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
      if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith("REPLACE_WITH")) return false;
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        // Full Drive scope (rather than drive.file) so MedRecall can find and
        // save into the "MedRecall" folder the user already created, instead
        // of being limited to files/folders it created itself.
        scope: "https://www.googleapis.com/auth/drive",
        callback: () => {} // overridden per-request in requestToken()
      });
      return true;
    },

    get isConfigured() {
      return !!this.tokenClient;
    },

    get isConnected() {
      return !!this.accessToken;
    },

    requestToken({ interactive = true } = {}) {
      return new Promise((resolve, reject) => {
        if (!this.tokenClient) {
          reject(new Error("Google Drive isn't set up yet. Add a Client ID in config.js — see README.md."));
          return;
        }
        this.tokenClient.callback = (response) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }
          this.accessToken = response.access_token;
          resolve(this.accessToken);
        };
        this.tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
      });
    },

    disconnect() {
      if (this.accessToken && window.google && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(this.accessToken, () => {});
      }
      this.accessToken = null;
    },

    // Resolves the Drive file ID of the user's existing top-level "MedRecall"
    // folder, caching it so this only needs a network round-trip once. Falls
    // back to searching anywhere (in case the folder gets moved later), and
    // creates the folder at the root as a last resort if it truly can't be found.
    async getFolderId({ forceRefresh = false } = {}) {
      if (!forceRefresh) {
        const cached = localStorage.getItem(this.folderIdKey);
        if (cached) return cached;
      }
      if (!this.accessToken) {
        await this.requestToken();
      }

      const escapedName = this.targetFolderName.replace(/'/g, "\\'");
      const baseQuery = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

      const searchFolder = async (query) => {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,name,parents)`,
          { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        if (res.status === 401) {
          this.accessToken = null;
          await this.requestToken();
          return searchFolder(query);
        }
        if (!res.ok) return null;
        const data = await res.json();
        return data.files && data.files.length > 0 ? data.files[0] : null;
      };

      // First try: a folder named "MedRecall" directly under Drive's root.
      let folder = await searchFolder(`${baseQuery} and 'root' in parents`);
      // Fallback: same name, anywhere in Drive (in case it's been moved/shared).
      if (!folder) folder = await searchFolder(baseQuery);

      if (folder) {
        localStorage.setItem(this.folderIdKey, folder.id);
        return folder.id;
      }

      // Last resort: create it at the root so saves have somewhere to go.
      const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: this.targetFolderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: ["root"]
        })
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Couldn't find or create the "${this.targetFolderName}" folder on Drive: ${text}`);
      }
      const created = await createRes.json();
      localStorage.setItem(this.folderIdKey, created.id);
      return created.id;
    },

    getDoctorFolderMap() {
      try {
        return JSON.parse(localStorage.getItem(this.doctorFolderMapKey) || "{}");
      } catch (e) {
        return {};
      }
    },
    setDoctorFolderMapEntry(doctorId, folderId) {
      const map = this.getDoctorFolderMap();
      map[doctorId] = folderId;
      localStorage.setItem(this.doctorFolderMapKey, JSON.stringify(map));
    },
    forgetDoctorFolder(doctorId) {
      const map = this.getDoctorFolderMap();
      delete map[doctorId];
      localStorage.setItem(this.doctorFolderMapKey, JSON.stringify(map));
    },

    // Resolves (or creates) a subfolder named after a specific doctor, nested
    // inside the main "MedRecall" folder, so each doctor's visit documents
    // land in their own folder. Cached per doctor id so this is only a
    // network round-trip the first time a doctor is saved to Drive.
    async getDoctorFolderId(doctorId, doctorName, { forceRefresh = false } = {}) {
      if (!forceRefresh) {
        const cached = this.getDoctorFolderMap()[doctorId];
        if (cached) return cached;
      }
      if (!this.accessToken) {
        await this.requestToken();
      }
      const parentFolderId = await this.getFolderId();
      const escapedName = doctorName.replace(/'/g, "\'");
      const query = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentFolderId}' in parents`;

      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (searchRes.status === 401) {
        this.accessToken = null;
        await this.requestToken();
        return this.getDoctorFolderId(doctorId, doctorName, { forceRefresh });
      }
      if (searchRes.ok) {
        const data = await searchRes.json();
        if (data.files && data.files.length > 0) {
          this.setDoctorFolderMapEntry(doctorId, data.files[0].id);
          return data.files[0].id;
        }
      }

      // Not found — create it inside the MedRecall folder.
      const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: doctorName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentFolderId]
        })
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Couldn't find or create a Drive folder for "${doctorName}": ${text}`);
      }
      const created = await createRes.json();
      this.setDoctorFolderMapEntry(doctorId, created.id);
      return created.id;
    },

    async upload(fileName, blob, mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folderId = null) {
      if (!this.accessToken) {
        await this.requestToken();
      }
      const targetFolderId = folderId || (await this.getFolderId());
      const metadata = { name: fileName, mimeType, parents: [targetFolderId] };
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append("file", blob);

      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: form
      });

      if (res.status === 401) {
        // Token expired mid-session — get a fresh one and retry once.
        this.accessToken = null;
        await this.requestToken();
        return this.upload(fileName, blob, mimeType, folderId);
      }
      if (res.status === 404) {
        // Cached folder id went stale (folder deleted/moved on the Drive
        // side). Forget whichever cached id pointed at it, then retry once
        // against the top-level MedRecall folder as a safe fallback — the
        // next save for that doctor will re-resolve/create their subfolder.
        if (folderId) {
          const map = this.getDoctorFolderMap();
          for (const doctorId of Object.keys(map)) {
            if (map[doctorId] === folderId) delete map[doctorId];
          }
          localStorage.setItem(this.doctorFolderMapKey, JSON.stringify(map));
        } else {
          localStorage.removeItem(this.folderIdKey);
        }
        return this.upload(fileName, blob, mimeType, null);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Google Drive upload failed: ${text}`);
      }
    },

    // Keeps a single JSON file ("MedRecall Backup.json") inside the MedRecall
    // Drive folder in sync with the current doctors + visits data. Creates the
    // file on first use, then updates that same file's contents on every later call.
    async syncBackup(dataObj) {
      if (!this.accessToken) {
        await this.requestToken();
      }
      const folderId = await this.getFolderId();
      const content = JSON.stringify(dataObj);
      const fileId = localStorage.getItem(this.backupFileIdKey);

      if (fileId) {
        const res = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "application/json"
            },
            body: content
          }
        );
        if (res.status === 401) {
          this.accessToken = null;
          await this.requestToken();
          return this.syncBackup(dataObj);
        }
        if (res.status === 404) {
          // The file was removed on the Drive side — forget the id and recreate it.
          localStorage.removeItem(this.backupFileIdKey);
          return this.syncBackup(dataObj);
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Drive backup sync failed: ${text}`);
        }
        return;
      }

      // No known file id yet — check inside the MedRecall folder for an
      // existing backup file before creating a new one.
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          "name='" + this.backupFileName + "' and trashed=false and '" + folderId + "' in parents"
        )}&spaces=drive&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (searchRes.ok) {
        const data = await searchRes.json();
        if (data.files && data.files.length > 0) {
          localStorage.setItem(this.backupFileIdKey, data.files[0].id);
          return this.syncBackup(dataObj);
        }
      }

      const metadata = { name: this.backupFileName, mimeType: "application/json", parents: [folderId] };
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append("file", new Blob([content], { type: "application/json" }));

      const createRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: form
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Drive backup sync failed: ${text}`);
      }
      const created = await createRes.json();
      localStorage.setItem(this.backupFileIdKey, created.id);
    }
  };

  // ---------- App Lock (Face ID / Touch ID via WebAuthn) ----------
  // Registers a platform authenticator credential (Face ID/Touch ID) once,
  // then re-verifies against it to unlock. This is a local UI gate, not
  // encryption — someone with deep enough access to the browser's storage
  // could still get at the underlying data. It's meant to stop a casual
  // glance at the phone from showing medical notes, not to be a vault.

  const AppLock = {
    storageKey: "medrecall.appLockCredentialId",

    get isEnabled() {
      return localStorage.getItem(this.storageKey) !== null;
    },

    get isSupported() {
      return !!(window.PublicKeyCredential && navigator.credentials);
    },

    bufferToBase64(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)));
    },

    base64ToBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    },

    async enable() {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "MedRecall" },
          user: { id: userId, name: "medrecall-user", displayName: "MedRecall" },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" }
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required"
          },
          timeout: 60000
        }
      });
      localStorage.setItem(this.storageKey, this.bufferToBase64(credential.rawId));
    },

    disable() {
      localStorage.removeItem(this.storageKey);
    },

    async verify() {
      const credentialId = localStorage.getItem(this.storageKey);
      if (!credentialId) return false;
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      try {
        await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: this.base64ToBuffer(credentialId), type: "public-key" }],
            userVerification: "required",
            timeout: 60000
          }
        });
        return true;
      } catch (err) {
        return false;
      }
    },

    async hashPin(pin, salt) {
      const enc = new TextEncoder();
      const data = enc.encode(salt + ":" + pin);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
    get hasPin() {
      return localStorage.getItem("medrecall.pinHash") !== null;
    },
    async setPin(pin) {
      const salt = this.bufferToBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
      const hash = await this.hashPin(pin, salt);
      localStorage.setItem("medrecall.pinSalt", salt);
      localStorage.setItem("medrecall.pinHash", hash);
    },
    removePin() {
      localStorage.removeItem("medrecall.pinSalt");
      localStorage.removeItem("medrecall.pinHash");
    },
    async verifyPin(pin) {
      const salt = localStorage.getItem("medrecall.pinSalt");
      const storedHash = localStorage.getItem("medrecall.pinHash");
      if (!salt || !storedHash) return false;
      const hash = await this.hashPin(pin, salt);
      return hash === storedHash;
    }
  };

  // ---------- App state ----------

  const state = {
    visitType: "In-Person Visit",
    transcriptFinal: "",
    elapsedSeconds: 0,
    timerHandle: null,
    recorder: null,
    isPaused: false,
    saveDestination: "local",
    pendingVisitDoctorId: null,
    editVisitType: "In-Person Visit",
    editingVisitId: null
  };

  // ---------- DOM references ----------

  const el = (id) => document.getElementById(id);

  const dom = {
    visitTypeSegmented: el("visit-type-segmented"),
    phoneCallHint: el("phone-call-hint"),
    recordDoctorSelect: el("record-doctor-select"),
    recordAddDoctorBtn: el("record-add-doctor-btn"),
    startRecordHint: el("start-record-hint"),
    recordIdle: el("record-idle"),
    recordActive: el("record-active"),
    recordTranscribing: el("record-transcribing"),
    recordReview: el("record-review"),
    startRecordBtn: el("start-record-btn"),
    stopRecordBtn: el("stop-record-btn"),
    activeVisitTypeLabel: el("active-visit-type-label"),
    timer: el("timer"),
    liveTranscript: el("live-transcript"),
    pulseDot: el("pulse-dot"),
    recordingStatusText: el("recording-status-text"),
    pauseResumeBtn: el("pause-resume-btn"),
    transcribeProgressBar: el("transcribe-progress-bar"),
    transcribeStatus: el("transcribe-status"),
    reviewTranscript: el("review-transcript"),
    copyReviewBtn: el("copy-review-btn"),
    openSaveBtn: el("open-save-btn"),
    discardBtn: el("discard-btn"),

    historyFilters: el("history-filters"),
    historySearch: el("history-search"),
    historyDoctorFilter: el("history-doctor-filter"),
    historyEmpty: el("history-empty"),
    historyNoMatches: el("history-no-matches"),
    historyList: el("history-list"),

    addDoctorBtn: el("add-doctor-btn"),
    doctorsList: el("doctors-list"),

    driveStatus: el("drive-status"),
    driveConnectBtn: el("drive-connect-btn"),
    driveDisconnectBtn: el("drive-disconnect-btn"),
    driveAutosyncBlock: el("drive-autosync-block"),
    driveAutosyncToggle: el("drive-autosync-toggle"),
    driveAutosyncStatus: el("drive-autosync-status"),

    backupExportBtn: el("backup-export-btn"),
    backupDocxBtn: el("backup-docx-btn"),
    backupImportInput: el("backup-import-input"),
    backupStatus: el("backup-status"),

    saveModal: el("save-modal"),
    saveDoctorSelect: el("save-doctor-select"),
    saveAddDoctorBtn: el("save-add-doctor-btn"),
    saveReason: el("save-reason"),
    saveFilename: el("save-filename"),
    saveDestinationSegmented: el("save-destination-segmented"),
    saveError: el("save-error"),
    saveCancelBtn: el("save-cancel-btn"),
    saveConfirmBtn: el("save-confirm-btn"),

    addDoctorModal: el("add-doctor-modal"),
    newDoctorName: el("new-doctor-name"),
    newDoctorSpecialty: el("new-doctor-specialty"),
    addDoctorCancelBtn: el("add-doctor-cancel-btn"),
    addDoctorConfirmBtn: el("add-doctor-confirm-btn"),

    editModal: el("edit-modal"),
    editDoctorSelect: el("edit-doctor-select"),
    editVisitTypeSegmented: el("edit-visit-type-segmented"),
    editReason: el("edit-reason"),
    editFilename: el("edit-filename"),
    editTranscript: el("edit-transcript"),
    editError: el("edit-error"),
    editCancelBtn: el("edit-cancel-btn"),
    editSaveBtn: el("edit-save-btn"),

    lockScreen: el("lock-screen"),
    unlockBtn: el("unlock-btn"),
    lockError: el("lock-error"),
    lockResetBtn: el("lock-reset-btn"),
    applockStatus: el("applock-status"),
    applockEnableBtn: el("applock-enable-btn"),
    applockDisableBtn: el("applock-disable-btn"),

    applockPinStatus: el("applock-pin-status"),
    applockSetPinBtn: el("applock-set-pin-btn"),
    applockRemovePinBtn: el("applock-remove-pin-btn"),
    usePinLinkBtn: el("use-pin-link-btn"),
    pinEntry: el("pin-entry"),
    pinEntryInput: el("pin-entry-input"),
    pinEntryUnlockBtn: el("pin-entry-unlock-btn"),
    pinSetupModal: el("pin-setup-modal"),
    pinSetupNew: el("pin-setup-new"),
    pinSetupConfirm: el("pin-setup-confirm"),
    pinSetupError: el("pin-setup-error"),
    pinSetupCancelBtn: el("pin-setup-cancel-btn"),
    pinSetupSaveBtn: el("pin-setup-save-btn")
  };

  // ---------- Tab navigation ----------

  document.querySelectorAll(".tab-bar-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-bar-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      el(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "tab-history") renderHistory();
      if (btn.dataset.tab === "tab-doctors") renderDoctors();
      if (btn.dataset.tab === "tab-record") populateRecordDoctorSelect(state.pendingVisitDoctorId);
    });
  });

  // ---------- Visit type segmented control ----------

  dom.visitTypeSegmented.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-option");
    if (!btn) return;
    dom.visitTypeSegmented.querySelectorAll(".segmented-option").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.visitType = btn.dataset.value;
    dom.phoneCallHint.classList.toggle("hidden", state.visitType !== "Phone Call");
  });

  // ---------- Record tab / doctor picker ----------
  // A doctor has to be chosen before you can start recording — it's the
  // first decision on this screen, ahead of visit type. Whoever's picked
  // here carries all the way through to the Save screen afterward.

  function populateRecordDoctorSelect(selectedId) {
    const doctors = Store.getDoctors();
    dom.recordDoctorSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a doctor…";
    placeholder.disabled = true;
    dom.recordDoctorSelect.appendChild(placeholder);
    doctors.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.specialty ? `${doc.name} (${doc.specialty})` : doc.name;
      dom.recordDoctorSelect.appendChild(opt);
    });
    dom.recordDoctorSelect.value = selectedId && doctors.some((d) => d.id === selectedId) ? selectedId : "";
    updateStartButtonEnabled();
  }

  function updateStartButtonEnabled() {
    const hasDoctor = !!dom.recordDoctorSelect.value;
    dom.startRecordBtn.disabled = !hasDoctor;
    dom.startRecordHint.textContent = hasDoctor ? "Tap to start recording" : "Choose a doctor above to begin";
  }

  dom.recordDoctorSelect.addEventListener("change", () => {
    state.pendingVisitDoctorId = dom.recordDoctorSelect.value || null;
    updateStartButtonEnabled();
  });

  dom.recordAddDoctorBtn.addEventListener("click", () => {
    openAddDoctorModal((newDoctorId) => {
      state.pendingVisitDoctorId = newDoctorId;
      populateRecordDoctorSelect(newDoctorId);
      renderDoctors();
    });
  });

  // ---------- Screen wake lock ----------
  // Keeps the phone from auto-locking due to inactivity while recording.
  // This doesn't stop a manual power-button press, and iOS may still
  // suspend the tab under memory pressure — see the recovery check below
  // for handling a recording that gets interrupted anyway.

  let wakeLock = null;

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (err) {
      // Can fail (e.g. Low Power Mode) — recording still works either way.
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try { await wakeLock.release(); } catch (err) { /* ignore */ }
      wakeLock = null;
    }
  }

  function isActivelyRecording() {
    return !dom.recordActive.classList.contains("hidden");
  }

  // Wake locks are automatically released whenever the tab is hidden, and
  // don't stop the OS from suspending the mic under memory pressure while
  // locked. When the app becomes visible again, re-acquire the wake lock,
  // and if the microphone stream was actually killed while we were away,
  // stop cleanly and transcribe whatever was captured rather than leaving
  // a dead recording the Stop button can't do anything with.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !isActivelyRecording() || !state.recorder) {
      return;
    }
    const track = state.recorder.stream && state.recorder.stream.getAudioTracks()[0];
    if (track && track.readyState === "ended") {
      showToast("Recording was interrupted while your phone was locked — finishing up with what was captured.");
      dom.stopRecordBtn.click();
      return;
    }
    if (!state.isPaused) requestWakeLock();
  });

  // ---------- Recording flow ----------

  function setStage(stage) {
    dom.recordIdle.classList.toggle("hidden", stage !== "idle");
    dom.recordActive.classList.toggle("hidden", stage !== "active");
    dom.recordTranscribing.classList.toggle("hidden", stage !== "transcribing");
    dom.recordReview.classList.toggle("hidden", stage !== "review");
  }

  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateModelProgress(p) {
    if (p && p.status === "progress" && typeof p.progress === "number") {
      dom.transcribeProgressBar.style.width = `${Math.round(p.progress)}%`;
      dom.transcribeStatus.textContent = "Downloading transcription model…";
    }
  }

  function setPausedUI(paused) {
    state.isPaused = paused;
    dom.pulseDot.classList.toggle("paused", paused);
    dom.pauseResumeBtn.classList.toggle("is-paused", paused);
    dom.pauseResumeBtn.textContent = paused ? "Resume" : "Pause";
    dom.recordingStatusText.textContent = paused
      ? "Paused — tap Resume to continue."
      : "Whisper AI is transcribing in the background as you talk.";
  }

  dom.pauseResumeBtn.addEventListener("click", () => {
    if (!state.recorder) return;
    if (state.isPaused) {
      state.recorder.resume();
      state.timerHandle = setInterval(() => {
        state.elapsedSeconds += 1;
        dom.timer.textContent = formatTime(state.elapsedSeconds);
      }, 1000);
      setPausedUI(false);
      requestWakeLock();
    } else {
      state.recorder.pause();
      clearInterval(state.timerHandle);
      setPausedUI(true);
      releaseWakeLock();
    }
  });

  dom.startRecordBtn.addEventListener("click", async () => {
    if (!dom.recordDoctorSelect.value) {
      showToast("Choose a doctor first.");
      return;
    }
    state.pendingVisitDoctorId = dom.recordDoctorSelect.value;
    state.transcriptFinal = "";
    state.elapsedSeconds = 0;
    dom.timer.textContent = "00:00";
    dom.activeVisitTypeLabel.textContent = state.visitType;
    dom.liveTranscript.textContent = "Listening…";
    setPausedUI(false);
    ProgressiveTranscriber.reset();

    state.recorder = new AudioRecorder();
    try {
      await state.recorder.start({
        onSegment: (blob) => {
          // Each segment is a fully finalized, independently-decodable
          // recording, so it's safe to transcribe right away in the
          // background while the next segment starts recording.
          ProgressiveTranscriber.enqueueSegment(blob, {
            onPartial: (text) => {
              dom.liveTranscript.textContent = text || "Listening…";
              dom.liveTranscript.scrollTop = dom.liveTranscript.scrollHeight;
            },
            onModelProgress: updateModelProgress
          });
        }
      });
    } catch (err) {
      showToast("Microphone access is required to record. Enable it in Settings > Safari > Microphone.");
      return;
    }

    state.timerHandle = setInterval(() => {
      state.elapsedSeconds += 1;
      dom.timer.textContent = formatTime(state.elapsedSeconds);
    }, 1000);

    requestWakeLock();
    setStage("active");
  });

  dom.stopRecordBtn.addEventListener("click", async () => {
    clearInterval(state.timerHandle);
    setPausedUI(false);
    releaseWakeLock();
    if (!state.recorder) {
      setStage("idle");
      return;
    }

    setStage("transcribing");
    dom.transcribeProgressBar.style.width = "100%";
    dom.transcribeStatus.textContent = "Finishing up your transcript…";

    try {
      await state.recorder.stop();
      const text = await ProgressiveTranscriber.finalize();
      state.transcriptFinal = text;
      dom.reviewTranscript.value = text;
      setStage("review");
    } catch (err) {
      showToast(err.message || "Transcription failed. Your recording wasn't saved — try again.");
      setStage("idle");
    }
  });

  dom.discardBtn.addEventListener("click", () => {
    state.transcriptFinal = "";
    dom.reviewTranscript.value = "";
    setStage("idle");
  });

  // ---------- Save modal ----------

  function populateDoctorSelectEl(selectEl) {
    const doctors = Store.getDoctors();
    selectEl.innerHTML = "";
    doctors.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.specialty ? `${doc.name} (${doc.specialty})` : doc.name;
      selectEl.appendChild(opt);
    });
  }

  function populateDoctorSelect() {
    populateDoctorSelectEl(dom.saveDoctorSelect);
  }

  function defaultFileName() {
    const doctors = Store.getDoctors();
    const doctor = doctors.find((d) => d.id === dom.saveDoctorSelect.value) || doctors[0];
    const doctorName = doctor ? doctor.name : "Visit";
    return `${doctorName} - ${state.visitType} - ${todayStamp()}`;
  }

  dom.copyReviewBtn.addEventListener("click", () => {
    copyText(dom.reviewTranscript.value);
  });

  dom.openSaveBtn.addEventListener("click", () => {
    populateDoctorSelect();
    if (state.pendingVisitDoctorId) {
      dom.saveDoctorSelect.value = state.pendingVisitDoctorId;
    }
    dom.saveReason.value = "";
    dom.saveFilename.value = defaultFileName();
    dom.saveError.classList.add("hidden");
    dom.saveModal.classList.remove("hidden");
  });

  dom.saveDoctorSelect.addEventListener("change", () => {
    // Keep the suggested filename in sync unless the user already typed something custom.
    if (dom.saveFilename.dataset.userEdited !== "1") {
      dom.saveFilename.value = defaultFileName();
    }
  });

  dom.saveFilename.addEventListener("input", () => {
    dom.saveFilename.dataset.userEdited = "1";
  });

  dom.saveCancelBtn.addEventListener("click", () => {
    dom.saveModal.classList.add("hidden");
  });

  dom.saveDestinationSegmented.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-option");
    if (!btn) return;
    dom.saveDestinationSegmented.querySelectorAll(".segmented-option").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.saveDestination = btn.dataset.value;
  });

  dom.saveAddDoctorBtn.addEventListener("click", () => {
    openAddDoctorModal((newDoctorId) => {
      populateDoctorSelect();
      dom.saveDoctorSelect.value = newDoctorId;
      dom.saveFilename.value = defaultFileName();
    });
  });

  dom.saveConfirmBtn.addEventListener("click", async () => {
    const doctors = Store.getDoctors();
    const doctor = doctors.find((d) => d.id === dom.saveDoctorSelect.value);
    const fileName = sanitizeFileName(dom.saveFilename.value);

    if (!doctor) {
      showError("Choose a doctor first.");
      return;
    }

    dom.saveConfirmBtn.textContent = "Saving…";
    dom.saveConfirmBtn.disabled = true;
    dom.saveError.classList.add("hidden");

    const reason = dom.saveReason.value.trim();

    try {
      const transcript = dom.reviewTranscript.value.trim();
      const blob = await DocxBuilder.build({
        doctorName: doctor.name,
        visitType: state.visitType,
        reason,
        date: new Date(),
        title: fileName,
        transcript
      });

      let savedToDrive = false;
      if (state.saveDestination === "drive") {
        const doctorFolderId = await Drive.getDoctorFolderId(doctor.id, doctor.name);
        await Drive.upload(
          fileName + ".docx",
          blob,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          doctorFolderId
        );
        savedToDrive = true;
        showToast("Saved to Google Drive.");
      } else {
        await saveLocally(fileName + ".docx", blob);
        showToast("Saved.");
      }

      const visits = Store.getVisits();
      visits.unshift({
        id: uuid(),
        doctorId: doctor.id,
        doctorName: doctor.name,
        visitType: state.visitType,
        reason,
        date: new Date().toISOString(),
        fileName,
        transcript,
        savedToDrive
      });
      Store.saveVisits(visits);

      dom.saveModal.classList.add("hidden");
      setStage("idle");
      state.transcriptFinal = "";
      state.transcriptInterim = "";
      dom.saveFilename.dataset.userEdited = "";
      state.pendingVisitDoctorId = null;
      populateRecordDoctorSelect(null);
    } catch (err) {
      showError(err.message || "Couldn't save. Try again.");
    } finally {
      dom.saveConfirmBtn.textContent = "Save";
      dom.saveConfirmBtn.disabled = false;
    }
  });

  function showError(message) {
    dom.saveError.textContent = message;
    dom.saveError.classList.remove("hidden");
  }

  async function copyText(text) {
    if (!text || !text.trim()) {
      showToast("Nothing to copy yet.");
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for browsers without the async Clipboard API.
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      showToast("Copied to clipboard.");
    } catch (err) {
      showToast("Couldn't copy — try selecting the text manually.");
    }
  }

  async function saveLocally(fileName, blob) {
    try {
      const file = new File([blob], fileName, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled the share sheet
      // otherwise fall through to the download fallback below
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Add doctor modal (shared by Doctors tab + Save sheet) ----------

  let addDoctorCallback = null;

  function openAddDoctorModal(onAdded) {
    addDoctorCallback = onAdded;
    dom.newDoctorName.value = "";
    dom.newDoctorSpecialty.value = "";
    dom.addDoctorModal.classList.remove("hidden");
  }

  dom.addDoctorBtn.addEventListener("click", () => openAddDoctorModal(renderDoctors));
  dom.addDoctorCancelBtn.addEventListener("click", () => dom.addDoctorModal.classList.add("hidden"));

  dom.addDoctorConfirmBtn.addEventListener("click", () => {
    const name = dom.newDoctorName.value.trim();
    if (!name) return;
    const doctors = Store.getDoctors();
    const newDoctor = { id: uuid(), name, specialty: dom.newDoctorSpecialty.value.trim() || null };
    doctors.push(newDoctor);
    doctors.sort((a, b) => a.name.localeCompare(b.name));
    Store.saveDoctors(doctors);
    dom.addDoctorModal.classList.add("hidden");
    // Pass the new doctor's id explicitly rather than assuming "last in the
    // array" — the list gets alphabetically sorted right above, so the
    // newly added doctor isn't reliably at the end of it.
    if (addDoctorCallback) addDoctorCallback(newDoctor.id);
  });

  // ---------- Doctors tab ----------

  function renderDoctors() {
    const doctors = Store.getDoctors();
    dom.doctorsList.innerHTML = "";
    doctors.forEach((doc) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.innerHTML = `
        <p class="list-item-title">${escapeHTML(doc.name)}</p>
        ${doc.specialty ? `<p class="list-item-sub">${escapeHTML(doc.specialty)}</p>` : ""}
        <div class="list-item-actions">
          <button class="delete" data-id="${doc.id}">Remove</button>
        </div>
      `;
      dom.doctorsList.appendChild(li);
    });
    dom.doctorsList.querySelectorAll("button.delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const doctor = Store.getDoctors().find((d) => d.id === btn.dataset.id);
        const label = doctor ? doctor.name : "this doctor";
        if (!confirm(`Remove ${label}? Past visits will keep their name, but you won't be able to pick them for new visits.`)) return;
        const remaining = Store.getDoctors().filter((d) => d.id !== btn.dataset.id);
        Store.saveDoctors(remaining);
        Drive.forgetDoctorFolder(btn.dataset.id);
        renderDoctors();
      });
    });
  }

  // ---------- History tab ----------

  function populateHistoryDoctorFilter() {
    const doctors = Store.getDoctors();
    const previousValue = dom.historyDoctorFilter.value;
    dom.historyDoctorFilter.innerHTML = '<option value="">All Doctors</option>';
    doctors.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.name;
      dom.historyDoctorFilter.appendChild(opt);
    });
    // Keep the previous selection if that doctor still exists.
    if (doctors.some((d) => d.id === previousValue)) {
      dom.historyDoctorFilter.value = previousValue;
    }
  }

  function filterVisits(visits) {
    const query = dom.historySearch.value.trim().toLowerCase();
    const doctorId = dom.historyDoctorFilter.value;

    return visits.filter((visit) => {
      if (doctorId && visit.doctorId !== doctorId) return false;
      if (!query) return true;
      const haystack = [visit.doctorName, visit.fileName, visit.transcript, visit.visitType, visit.reason]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderHistory() {
    const allVisits = Store.getVisits();
    populateHistoryDoctorFilter();

    dom.historyFilters.classList.toggle("hidden", allVisits.length === 0);
    dom.historyEmpty.classList.toggle("hidden", allVisits.length > 0);

    const visits = allVisits.length > 0 ? filterVisits(allVisits) : [];
    dom.historyNoMatches.classList.toggle("hidden", !(allVisits.length > 0 && visits.length === 0));
    dom.historyList.innerHTML = "";

    visits.forEach((visit) => {
      const li = document.createElement("li");
      li.className = "list-item";
      const date = new Date(visit.date);
      li.innerHTML = `
        <p class="list-item-title">${escapeHTML(visit.fileName)}</p>
        <p class="list-item-sub">${escapeHTML(visit.doctorName)} • ${escapeHTML(visit.visitType)}${visit.reason ? ` • ${escapeHTML(visit.reason)}` : ""}</p>
        <div class="list-item-meta">
          <span>${date.toLocaleString()}</span>
          ${visit.savedToDrive ? "<span>☁️ Drive</span>" : ""}
        </div>
        <div class="list-item-actions">
          <button class="edit" data-id="${visit.id}">Edit</button>
          <button class="copy" data-id="${visit.id}">Copy Text</button>
          <button class="download" data-id="${visit.id}">Download .docx</button>
          <button class="download-pdf" data-id="${visit.id}">Download .pdf</button>
          <button class="delete" data-id="${visit.id}">Delete</button>
        </div>
      `;
      dom.historyList.appendChild(li);
    });

    dom.historyList.querySelectorAll("button.download-pdf").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const visit = Store.getVisits().find((v) => v.id === btn.dataset.id);
        if (!visit) return;
        try {
          const blob = PdfBuilder.build({
            doctorName: visit.doctorName,
            visitType: visit.visitType,
            reason: visit.reason,
            date: new Date(visit.date),
            title: visit.fileName,
            transcript: visit.transcript
          });
          await saveLocally(visit.fileName + ".pdf", blob);
        } catch (err) {
          showToast(err.message || "Couldn't build the PDF.");
        }
      });
    });

    dom.historyList.querySelectorAll("button.copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const visit = Store.getVisits().find((v) => v.id === btn.dataset.id);
        if (visit) copyText(visit.transcript);
      });
    });

    dom.historyList.querySelectorAll("button.edit").forEach((btn) => {
      btn.addEventListener("click", () => openEditModal(btn.dataset.id));
    });

    dom.historyList.querySelectorAll("button.download").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const visit = Store.getVisits().find((v) => v.id === btn.dataset.id);
        if (!visit) return;
        const blob = await DocxBuilder.build({
          doctorName: visit.doctorName,
          visitType: visit.visitType,
          reason: visit.reason,
          date: new Date(visit.date),
          title: visit.fileName,
          transcript: visit.transcript
        });
        await saveLocally(visit.fileName + ".docx", blob);
      });
    });

    dom.historyList.querySelectorAll("button.delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const visit = Store.getVisits().find((v) => v.id === btn.dataset.id);
        const label = visit ? visit.fileName : "this visit";
        if (!confirm(`Delete "${label}"? This can't be undone — the transcript won't be recoverable unless you've backed it up.`)) return;
        const remaining = Store.getVisits().filter((v) => v.id !== btn.dataset.id);
        Store.saveVisits(remaining);
        renderHistory();
      });
    });
  }

  dom.historySearch.addEventListener("input", renderHistory);
  dom.historyDoctorFilter.addEventListener("change", renderHistory);

  // ---------- Edit a saved visit ----------

  function setEditVisitTypeUI(type) {
    state.editVisitType = type;
    dom.editVisitTypeSegmented.querySelectorAll(".segmented-option").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === type);
    });
  }

  dom.editVisitTypeSegmented.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-option");
    if (!btn) return;
    setEditVisitTypeUI(btn.dataset.value);
  });

  function openEditModal(visitId) {
    const visit = Store.getVisits().find((v) => v.id === visitId);
    if (!visit) return;

    state.editingVisitId = visitId;
    populateDoctorSelectEl(dom.editDoctorSelect);
    dom.editDoctorSelect.value = visit.doctorId;
    setEditVisitTypeUI(visit.visitType);
    dom.editReason.value = visit.reason || "";
    dom.editFilename.value = visit.fileName;
    dom.editTranscript.value = visit.transcript;
    dom.editError.classList.add("hidden");
    dom.editModal.classList.remove("hidden");
  }

  dom.editCancelBtn.addEventListener("click", () => {
    dom.editModal.classList.add("hidden");
    state.editingVisitId = null;
  });

  dom.editSaveBtn.addEventListener("click", () => {
    const doctors = Store.getDoctors();
    const doctor = doctors.find((d) => d.id === dom.editDoctorSelect.value);
    const fileName = sanitizeFileName(dom.editFilename.value);

    if (!doctor) {
      dom.editError.textContent = "Choose a doctor first.";
      dom.editError.classList.remove("hidden");
      return;
    }

    const visits = Store.getVisits();
    const index = visits.findIndex((v) => v.id === state.editingVisitId);
    if (index === -1) {
      dom.editModal.classList.add("hidden");
      return;
    }

    visits[index] = {
      ...visits[index],
      doctorId: doctor.id,
      doctorName: doctor.name,
      visitType: state.editVisitType,
      reason: dom.editReason.value.trim(),
      fileName,
      transcript: dom.editTranscript.value.trim()
    };
    Store.saveVisits(visits);

    dom.editModal.classList.add("hidden");
    state.editingVisitId = null;
    renderHistory();
    showToast("Visit updated.");
  });

  function escapeHTML(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  // ---------- Settings tab / Backup & Restore ----------

  function showBackupStatus(message) {
    dom.backupStatus.textContent = message;
    dom.backupStatus.classList.remove("hidden");
  }

  dom.backupExportBtn.addEventListener("click", async () => {
    const data = {
      app: "MedRecall",
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      doctors: Store.getDoctors(),
      visits: Store.getVisits()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const fileName = `MedRecall Backup ${todayStamp()}.json`;
    try {
      await saveLocally(fileName, blob);
      showBackupStatus("Backup saved. Keep a copy somewhere off this phone too — email it to yourself, or save it to Drive/iCloud.");
    } catch (err) {
      showToast(err.message || "Couldn't create the backup.");
    }
  });

  dom.backupDocxBtn.addEventListener("click", async () => {
    const visits = Store.getVisits();
    if (visits.length === 0) {
      showToast("No saved visits yet.");
      return;
    }
    showToast(`Building a zip of ${visits.length} visit(s)…`);
    try {
      const zip = new JSZip();
      const usedNames = new Set();
      for (const visit of visits) {
        const blob = await DocxBuilder.build({
          doctorName: visit.doctorName,
          visitType: visit.visitType,
          reason: visit.reason,
          date: new Date(visit.date),
          title: visit.fileName,
          transcript: visit.transcript
        });
        const base = sanitizeFileName(visit.fileName);
        let name = `${base}.docx`;
        let attempt = 1;
        while (usedNames.has(name)) {
          name = `${base} (${attempt}).docx`;
          attempt += 1;
        }
        usedNames.add(name);
        zip.file(name, await blob.arrayBuffer());
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      await saveLocally(`MedRecall Visits ${todayStamp()}.zip`, zipBlob);
      showBackupStatus(`Saved a zip with ${visits.length} Word document(s).`);
    } catch (err) {
      showToast(err.message || "Couldn't build the zip.");
    }
  });

  dom.backupImportInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.doctors) || !Array.isArray(data.visits)) {
        throw new Error("That file doesn't look like a MedRecall backup.");
      }

      const existingDoctors = Store.getDoctors();
      const existingDoctorIds = new Set(existingDoctors.map((d) => d.id));
      const newDoctors = data.doctors.filter((d) => d && d.id && !existingDoctorIds.has(d.id));
      Store.saveDoctors(existingDoctors.concat(newDoctors));

      const existingVisits = Store.getVisits();
      const existingVisitIds = new Set(existingVisits.map((v) => v.id));
      const newVisits = data.visits.filter((v) => v && v.id && !existingVisitIds.has(v.id));
      Store.saveVisits(existingVisits.concat(newVisits));

      renderDoctors();
      renderHistory();
      showBackupStatus(`Restored ${newDoctors.length} new doctor(s) and ${newVisits.length} new visit(s). Anything already here was left as-is.`);
      showToast("Backup restored.");
    } catch (err) {
      showToast(err.message || "Couldn't read that backup file.");
    } finally {
      e.target.value = "";
    }
  });

  // ---------- Settings tab / Google Drive connect ----------

  const driveAutoSyncKey = "medrecall.driveAutoSync";
  let driveSyncTimer = null;

  function isAutoSyncEnabled() {
    return localStorage.getItem(driveAutoSyncKey) === "on";
  }

  function notifyDataChanged() {
    if (!isAutoSyncEnabled()) return;
    if (typeof Drive === "undefined" || !Drive.isConnected) return;
    clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(runDriveSync, 3000);
  }

  async function runDriveSync() {
    try {
      await Drive.syncBackup({
        doctors: Store.getDoctors(),
        visits: Store.getVisits(),
        exportedAt: new Date().toISOString()
      });
      if (dom.driveAutosyncStatus) {
        dom.driveAutosyncStatus.textContent = "Last synced " + new Date().toLocaleTimeString();
      }
    } catch (err) {
      if (dom.driveAutosyncStatus) {
        dom.driveAutosyncStatus.textContent = "Sync failed — will retry on the next change.";
      }
    }
  }

  function updateDriveUI() {
    if (!Drive.isConfigured) {
      dom.driveStatus.textContent = "Not set up — add a Google Client ID in config.js (see README).";
      dom.driveConnectBtn.classList.add("hidden");
      dom.driveDisconnectBtn.classList.add("hidden");
      dom.driveAutosyncBlock.classList.add("hidden");
      return;
    }
    if (Drive.isConnected) {
      dom.driveStatus.textContent = "Connected";
      dom.driveConnectBtn.classList.add("hidden");
      dom.driveDisconnectBtn.classList.remove("hidden");
      dom.driveAutosyncBlock.classList.remove("hidden");
      dom.driveAutosyncToggle.checked = isAutoSyncEnabled();
      dom.driveAutosyncStatus.textContent = isAutoSyncEnabled() ? "On" : "Off";
    } else {
      dom.driveStatus.textContent = "Not connected";
      dom.driveConnectBtn.classList.remove("hidden");
      dom.driveDisconnectBtn.classList.add("hidden");
      dom.driveAutosyncBlock.classList.add("hidden");
    }
  }

  dom.driveConnectBtn.addEventListener("click", async () => {
    try {
      await Drive.requestToken();
      updateDriveUI();
      showToast("Connected to Google Drive.");
      if (isAutoSyncEnabled()) notifyDataChanged();
    } catch (err) {
      showToast(err.message || "Couldn't connect to Google Drive.");
    }
  });

  dom.driveDisconnectBtn.addEventListener("click", () => {
    Drive.disconnect();
    updateDriveUI();
  });

  dom.driveAutosyncToggle.addEventListener("change", () => {
    const on = dom.driveAutosyncToggle.checked;
    localStorage.setItem(driveAutoSyncKey, on ? "on" : "off");
    dom.driveAutosyncStatus.textContent = on ? "On" : "Off";
    if (on) {
      showToast("Auto-backup to Drive turned on.");
      dom.driveAutosyncStatus.textContent = "Syncing…";
      runDriveSync();
    } else {
      clearTimeout(driveSyncTimer);
      showToast("Auto-backup to Drive turned off.");
    }
  });

  // ---------- Settings tab / App Lock ----------

  function updateAppLockUI() {
    if (!AppLock.isSupported) {
      dom.applockStatus.textContent = "Not supported in this browser.";
      dom.applockEnableBtn.classList.add("hidden");
      dom.applockDisableBtn.classList.add("hidden");
      return;
    }
    if (AppLock.isEnabled) {
      dom.applockStatus.textContent = "On";
      dom.applockEnableBtn.classList.add("hidden");
      dom.applockDisableBtn.classList.remove("hidden");
    } else {
      dom.applockStatus.textContent = "Off";
      dom.applockEnableBtn.classList.remove("hidden");
      dom.applockDisableBtn.classList.add("hidden");
    }
    updatePinSettingsUI();
  }

  function updatePinSettingsUI() {
    if (AppLock.hasPin) {
      dom.applockPinStatus.textContent = "Set";
      dom.applockSetPinBtn.textContent = "Change PIN";
      dom.applockRemovePinBtn.classList.remove("hidden");
    } else {
      dom.applockPinStatus.textContent = "Not set";
      dom.applockSetPinBtn.textContent = "Set a PIN";
      dom.applockRemovePinBtn.classList.add("hidden");
    }
  }

  dom.applockEnableBtn.addEventListener("click", async () => {
    try {
      await AppLock.enable();
      updateAppLockUI();
      showToast("Face ID lock enabled.");
    } catch (err) {
      showToast(err.message || "Couldn't set up Face ID on this device.");
    }
  });

  dom.applockDisableBtn.addEventListener("click", () => {
    AppLock.disable();
    updateAppLockUI();
    showToast("Face ID lock turned off.");
  });

  // ---------- Settings tab / PIN fallback ----------

  function openPinSetupModal() {
    dom.pinSetupNew.value = "";
    dom.pinSetupConfirm.value = "";
    dom.pinSetupError.classList.add("hidden");
    dom.pinSetupModal.classList.remove("hidden");
    dom.pinSetupNew.focus();
  }

  function closePinSetupModal() {
    dom.pinSetupModal.classList.add("hidden");
  }

  dom.applockSetPinBtn.addEventListener("click", openPinSetupModal);

  dom.applockRemovePinBtn.addEventListener("click", () => {
    if (!confirm("Remove your backup PIN? You'll only be able to unlock with Face ID.")) return;
    AppLock.removePin();
    updatePinSettingsUI();
    showToast("PIN removed.");
  });

  dom.pinSetupCancelBtn.addEventListener("click", closePinSetupModal);

  dom.pinSetupSaveBtn.addEventListener("click", async () => {
    const pin = dom.pinSetupNew.value.trim();
    const confirmPin = dom.pinSetupConfirm.value.trim();
    dom.pinSetupError.classList.add("hidden");

    if (!/^\d{4,8}$/.test(pin)) {
      dom.pinSetupError.textContent = "PIN must be 4-8 digits.";
      dom.pinSetupError.classList.remove("hidden");
      return;
    }
    if (pin !== confirmPin) {
      dom.pinSetupError.textContent = "PINs don't match.";
      dom.pinSetupError.classList.remove("hidden");
      return;
    }

    await AppLock.setPin(pin);
    updatePinSettingsUI();
    closePinSetupModal();
    showToast("PIN saved.");
  });

  // ---------- Lock screen ----------

  function showLockScreen() {
    dom.lockScreen.classList.remove("hidden");
    dom.lockError.classList.add("hidden");
    dom.pinEntry.classList.add("hidden");
    dom.pinEntryInput.value = "";
    if (AppLock.hasPin) {
      dom.usePinLinkBtn.classList.remove("hidden");
      dom.usePinLinkBtn.textContent = "Use PIN instead";
    } else {
      dom.usePinLinkBtn.classList.add("hidden");
    }
  }

  async function attemptUnlock() {
    dom.lockError.classList.add("hidden");
    dom.unlockBtn.textContent = "Verifying…";
    dom.unlockBtn.disabled = true;
    const success = await AppLock.verify();
    dom.unlockBtn.textContent = "Unlock";
    dom.unlockBtn.disabled = false;
    if (success) {
      dom.lockScreen.classList.add("hidden");
    } else {
      dom.lockError.textContent = "Couldn't verify. Try again.";
      dom.lockError.classList.remove("hidden");
    }
  }

  dom.unlockBtn.addEventListener("click", attemptUnlock);

  dom.usePinLinkBtn.addEventListener("click", () => {
    const showingPin = !dom.pinEntry.classList.contains("hidden");
    if (showingPin) {
      dom.pinEntry.classList.add("hidden");
      dom.usePinLinkBtn.textContent = "Use PIN instead";
    } else {
      dom.pinEntry.classList.remove("hidden");
      dom.usePinLinkBtn.textContent = "Use Face ID instead";
      dom.lockError.classList.add("hidden");
      dom.pinEntryInput.value = "";
      dom.pinEntryInput.focus();
    }
  });

  async function attemptPinUnlock() {
    dom.lockError.classList.add("hidden");
    const pin = dom.pinEntryInput.value.trim();
    if (!pin) return;
    const success = await AppLock.verifyPin(pin);
    if (success) {
      dom.lockScreen.classList.add("hidden");
      dom.pinEntryInput.value = "";
    } else {
      dom.lockError.textContent = "Wrong PIN. Try again.";
      dom.lockError.classList.remove("hidden");
      dom.pinEntryInput.value = "";
      dom.pinEntryInput.focus();
    }
  }

  dom.pinEntryUnlockBtn.addEventListener("click", attemptPinUnlock);
  dom.pinEntryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptPinUnlock();
  });

  // Safety valve: if Face ID stops working (device changed, browser data
  // partially cleared, etc.) and no PIN was ever set, there'd otherwise be no
  // way back into the app. This turns the lock off entirely without touching
  // doctors/visits — you can set it back up again afterward in Settings.
  dom.lockResetBtn.addEventListener("click", () => {
    if (
      !confirm(
        "This turns off Face ID / PIN lock so you can get back into MedRecall. Your doctors and visits are not affected — only the lock itself is removed. Continue?"
      )
    ) {
      return;
    }
    AppLock.disable();
    AppLock.removePin();
    dom.lockScreen.classList.add("hidden");
    updateAppLockUI();
    showToast("App lock turned off. You can set it up again anytime in Settings.");
  });

  // Re-lock whenever the app is backgrounded (screen locked, app switched
  // away from, etc.), so a glance at the phone later requires unlocking again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && AppLock.isEnabled) {
      showLockScreen();
    }
  });

  // ---------- Init ----------

  function init() {
    renderDoctors();
    renderHistory();
    populateRecordDoctorSelect(state.pendingVisitDoctorId);
    updateAppLockUI();

    if (AppLock.isEnabled) {
      showLockScreen();
    }

    // Google's script loads asynchronously; poll briefly for it to be ready.
    let attempts = 0;
    const tryInitDrive = () => {
      attempts += 1;
      if (Drive.init() || attempts > 20) {
        updateDriveUI();
        return;
      }
      setTimeout(tryInitDrive, 250);
    };
    tryInitDrive();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch(() => {});
      });
    }
  }

  init();
})();
