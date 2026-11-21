
const $ = id => document.getElementById(id);

const API = location.origin;

let ws = null;
let stream = null;
let ctx = null;
let processor = null;
let source = null;
let muteNode = null;

let pcmBuffer = [];
let captureActive = false;
let correctionMode = false;

let finalTranscript = "";
let partialTranscript = "";
let dangerAlreadySpoken = false;


// ---------------- BASIC HELPERS ----------------

function status(message) {
    $("micStatus").textContent = message;
}

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}


// ---------------- SPOKEN NUMBER CONVERSION ----------------

function normalizeSpokenNumbers(input) {
    const small = {
        zero: 0, oh: 0,
        one: 1, two: 2, three: 3, four: 4,
        five: 5, six: 6, seven: 7, eight: 8,
        nine: 9, ten: 10, eleven: 11, twelve: 12,
        thirteen: 13, fourteen: 14, fifteen: 15,
        sixteen: 16, seventeen: 17, eighteen: 18,
        nineteen: 19
    };

    const tens = {
        twenty: 20, thirty: 30, forty: 40,
        fifty: 50, sixty: 60, seventy: 70,
        eighty: 80, ninety: 90
    };

    const pattern = Object.keys(small)
        .concat(Object.keys(tens), ["hundred", "thousand"]);

    const re = new RegExp(
        "\\b(?:" + pattern.join("|") +
        ")(?:[\\s-]+(?:" + pattern.join("|") +
        "|and|point))*\\b",
        "gi"
    );

    return String(input || "").replace(
        re,
        (phrase, offset, whole) => {
            const words = phrase.toLowerCase()
                .replace(/-/g, " ")
                .split(/\s+/)
                .filter(word => word !== "and");

            const prefix = whole
                .slice(Math.max(0, offset - 24), offset)
                .toLowerCase();

            // Preserve spoken digit sequences in IDs.
            if (
                /\b(?:id|identifier)\s*$/.test(prefix) &&
                words.length > 1 &&
                words.every(word =>
                    Object.prototype.hasOwnProperty.call(small, word) &&
                    small[word] < 10
                )
            ) {
                return words.map(word => small[word]).join("");
            }

            let total = 0;
            let current = 0;
            let decimal = false;
            let decimalDigits = "";

            for (const word of words) {
                if (word === "point") {
                    decimal = true;
                    continue;
                }

                if (decimal) {
                    if (
                        Object.prototype.hasOwnProperty.call(small, word) &&
                        small[word] < 10
                    ) {
                        decimalDigits += small[word];
                    } else {
                        return phrase;
                    }
                } else if (
                    Object.prototype.hasOwnProperty.call(small, word)
                ) {
                    current += small[word];
                } else if (
                    Object.prototype.hasOwnProperty.call(tens, word)
                ) {
                    current += tens[word];
                } else if (word === "hundred") {
                    current = (current || 1) * 100;
                } else if (word === "thousand") {
                    total += (current || 1) * 1000;
                    current = 0;
                } else {
                    return phrase;
                }
            }

            const value = total + current;

            return decimal
                ? (decimalDigits ? `${value}.${decimalDigits}` : phrase)
                : String(value);
        }
    );
}


// ---------------- VISIT RECORD ----------------

function getRecord() {
    return {
        beneficiary_id: $("beneficiary_id").value.trim(),
        visit_type: $("visit_type").value || null,

        weight_kg: $("weight_kg").value === ""
            ? null
            : Number($("weight_kg").value),

        vaccination_status:
            $("vaccination_status").value.trim() || null,

        vaccinations_due:
            $("vaccinations_due").value.trim() || null,

        next_visit_date: $("next_visit_date").value || null,

        original_note: $("note").value.trim(),
        confirmed: $("confirmed").checked
    };
}

function fillRecord(record) {
    $("beneficiary_id").value = record.beneficiary_id || "";
    $("visit_type").value = record.visit_type || "";

    $("weight_kg").value = record.weight_kg ?? "";

    $("vaccination_status").value =
        record.vaccination_status || "";

    $("vaccinations_due").value =
        record.vaccinations_due || "";

    $("next_visit_date").value =
        record.next_visit_date || "";

    $("confirmed").checked = false;
    $("saveBtn").disabled = true;
}

function renderTranscript() {
    const raw = [
        finalTranscript,
        partialTranscript
    ].filter(Boolean).join(
        finalTranscript && partialTranscript ? " " : ""
    );

    $("note").value = normalizeSpokenNumbers(raw);
    $("note").scrollTop = $("note").scrollHeight;
}

function appendTranscript(text) {
    if (!text) return;

    partialTranscript = "";

    finalTranscript +=
        (finalTranscript ? " " : "") + text;

    renderTranscript();

    status("Transcript received. Check names, dates and numbers.");

    checkDangerLive(text);
}

function showPartialTranscript(text) {
    partialTranscript = text || "";
    renderTranscript();

    if (partialTranscript) {
        status("Listening… live words appearing");
    }
}


// ---------------- DANGER RULE CHECK ----------------

function checkDangerLive(text) {
    const accumulated =
        (finalTranscript + " " + text).toLowerCase();

    fetch("/api/validate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            note: accumulated
        })
    })
    .then(response => response.json())
    .then(data => {
        const matches = data.danger_matches || [];

        if (!dangerAlreadySpoken && matches.length) {
            dangerAlreadySpoken = true;

            $("dangerBox").classList.remove("hidden");

            $("dangerBox").textContent =
                "⚠ DANGER SIGN — Immediate PHC referral: " +
                matches.map(item => item.label).join(", ") +
                ". Rule-list match only; no diagnosis or treatment advice.";

            speak(
                matches.map(item => item.referral_message).join(" ")
            );
        }
    })
    .catch(error => {
        console.warn("Validation request failed:", error);
    });
}


// ---------------- TEXT TO SPEECH ----------------

async function speak(text) {
    status("Speaking read-back / alert…");

    try {
        const response = await fetch("/api/tts", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text,
                language: $("language").value,
                voice: $("ttsVoice").value
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(
                errorData.detail || "Gnani TTS unavailable"
            );
        }

        const data = await response.json();

        const audio = new Audio(
            "data:" + data.mime +
            ";base64," + data.audio_base64
        );

        await audio.play();

        status("Voice message played using Gnani Timbre.");

    } catch (error) {
        console.warn("TTS error:", error);

        if ("speechSynthesis" in window) {
            speechSynthesis.cancel();

            const utterance =
                new SpeechSynthesisUtterance(text);

            utterance.lang = $("language").value;

            speechSynthesis.speak(utterance);

            status("Using browser voice fallback.");
        } else {
            status("Speech unavailable: " + error.message);
        }
    }
}

function readForm() {
    const record = getRecord();

    const lines = [
        `Beneficiary ID ${record.beneficiary_id || "not captured"}.`,
        `Visit type ${record.visit_type || "not captured"}.`,
        `Weight ${
            record.weight_kg === null
                ? "not captured"
                : record.weight_kg + " kilograms"
        }.`,
        `Vaccination status ${
            record.vaccination_status || "not specified"
        }.`,
        `Vaccinations due or mentioned ${
            record.vaccinations_due || "not specified"
        }.`,
        `Next visit date ${record.next_visit_date || "not captured"}.`,
        "Please check the information carefully before confirming."
    ];

    return lines.join(" ");
}


// ---------------- AUDIO CONVERSION ----------------

function pcm16FromFloat(input, sourceRate, targetRate = 16000) {
    const outputLength = Math.floor(
        input.length * targetRate / sourceRate
    );

    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const start = Math.floor(i * sourceRate / targetRate);

        const end = Math.max(
            start + 1,
            Math.floor((i + 1) * sourceRate / targetRate)
        );

        let sum = 0;
        let count = 0;

        for (let j = start; j < Math.min(end, input.length); j++) {
            sum += input[j];
            count++;
        }

        let sample = count
            ? sum / count
            : input[Math.min(start, input.length - 1)];

        sample = Math.max(-1, Math.min(1, sample));

        output[i] = sample < 0
            ? sample * 32768
            : sample * 32767;
    }

    return output;
}

function sendPcmFrames(floatData, rate) {
    const converted = pcm16FromFloat(floatData, rate);

    for (let i = 0; i < converted.length; i++) {
        pcmBuffer.push(converted[i]);
    }

    while (pcmBuffer.length >= 512) {
        const frame = pcmBuffer.splice(0, 512);

        const bytes = new Uint8Array(1024);
        const view = new DataView(bytes.buffer);

        for (let i = 0; i < frame.length; i++) {
            view.setInt16(i * 2, frame[i], true);
        }

        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(bytes);
        }
    }
}

function flushPcmFrames() {
    if (
        !pcmBuffer.length ||
        ws?.readyState !== WebSocket.OPEN
    ) {
        pcmBuffer = [];
        return;
    }

    const frame = pcmBuffer.splice(0);

    const bytes = new Uint8Array(frame.length * 2);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < frame.length; i++) {
        view.setInt16(i * 2, frame[i], true);
    }

    ws.send(bytes);
}


// ---------------- GNANI WEBSOCKET ----------------

async function openGnaniStream(language) {
    const protocol =
        location.protocol === "https:" ? "wss" : "ws";

    const socketUrl =
        `${protocol}://${location.host}/ws/gnani-stt?language=${encodeURIComponent(language)}`;

    ws = new WebSocket(socketUrl);
    ws.binaryType = "arraybuffer";

    const socket = ws;

    await new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            finish(new Error("Gnani handshake timed out"));
        }, 8000);

        function finish(error) {
            if (settled) return;

            settled = true;
            clearTimeout(timer);

            if (error) reject(error);
            else resolve();
        }

        socket.onerror = () => {
            finish(new Error("WebSocket connection failed"));
        };

        socket.onclose = () => {
            if (!settled) {
                finish(
                    new Error("Gnani WebSocket closed before it was ready")
                );
            }
        };

        socket.onmessage = event => {
            if (typeof event.data !== "string") return;

            let data;

            try {
                data = JSON.parse(event.data);
            } catch (error) {
                console.warn("Invalid Gnani message:", error);
                return;
            }

            if (data.type === "ready") {
                status("Connected to Gnani Prisma. Speak now.");
                finish();
            }

            else if (
                data.type === "partial_transcript" ||
                (data.type === "transcript" && data.is_final === false)
            ) {
                showPartialTranscript(data.text);
            }

            else if (data.type === "transcript") {
                if (correctionMode) {
                    applyCorrection(data.text);
                } else {
                    appendTranscript(data.text);
                }
            }

            else if (data.type === "processing") {
                status("Gnani is processing the speech segment…");
            }

            else if (data.type === "stream_done") {
                status("Final transcript received.");

                if (!correctionMode && $("note").value.trim()) {
                    extract();
                }
            }

            else if (data.type === "error") {
                status(
                    "Gnani error: " +
                    (data.message || "Unknown error")
                );
            }
        };
    });
}


// ---------------- START AND STOP MICROPHONE ----------------

async function startCapture(isCorrection = false) {
    correctionMode = isCorrection;

    finalTranscript = "";
    partialTranscript = "";
    $("note").value = "";

    if (!isCorrection) {
        dangerAlreadySpoken = false;
    }

    pcmBuffer = [];

    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;

    status("Requesting microphone…");

    try {
        const audioOptions = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
        };

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: audioOptions
            });
        } catch (firstError) {
            console.warn(
                "Retrying with basic microphone settings:",
                firstError
            );

            stream = await navigator.mediaDevices.getUserMedia({
                audio: true
            });
        }

        await openGnaniStream(
            $("language").value || "indic-auto"
        );

        ctx = new AudioContext({
            latencyHint: "interactive"
        });

        if (ctx.state === "suspended") {
            await ctx.resume();
        }

        source = ctx.createMediaStreamSource(stream);

        processor = ctx.createScriptProcessor(1024, 1, 1);

        muteNode = ctx.createGain();
        muteNode.gain.value = 0;

        processor.onaudioprocess = event => {
            if (captureActive) {
                sendPcmFrames(
                    event.inputBuffer.getChannelData(0),
                    ctx.sampleRate
                );
            }
        };

        source.connect(processor);
        processor.connect(muteNode);
        muteNode.connect(ctx.destination);

        captureActive = true;

        status(
            isCorrection
                ? "Correction listening. Speak naturally."
                : "Live capture started. Speak naturally."
        );

    } catch (error) {
        status("Unable to start streaming: " + error.message);
        stopCapture();
    }
}

function stopCapture() {
    captureActive = false;

    if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
    }

    if (source) {
        source.disconnect();
        source = null;
    }

    if (muteNode) {
        muteNode.disconnect();
        muteNode = null;
    }

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    if (ctx) {
        ctx.close().catch(console.warn);
        ctx = null;
    }

    const socket = ws;

    if (socket && socket.readyState === WebSocket.OPEN) {
        try {
            flushPcmFrames();

            socket.send(JSON.stringify({
                type: "stop"
            }));

            setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }
            }, 1500);

        } catch (error) {
            console.warn("Could not finish audio stream:", error);
        }
    }

    ws = null;

    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;

    status("Finishing speech recognition. Waiting for final words...");
}


// ---------------- VOICE CORRECTIONS ----------------

function applyCorrection(text) {
    const value = normalizeSpokenNumbers(text);
    const lower = value.toLowerCase();

    let match = lower.match(
        /(?:weight|ತೂಕ|वजन)[^\d]*(\d+(?:\.\d+)?)/
    );

    if (!match) {
        match = lower.match(
            /(\d+(?:\.\d+)?)\s*(?:kilo|kg|ಕಿಲೋ|किलो)/
        );
    }

    if (match) {
        $("weight_kg").value = match[1];

        $("confirmed").checked = false;
        $("saveBtn").disabled = true;

        speak(
            `Weight updated to ${match[1]} kilograms. ${readForm()}`
        );

        return;
    }

    match = lower.match(
        /(?:beneficiary\s*id|beneficiary|id)[^a-z0-9]*([a-z0-9-]+)/
    );

    if (match) {
        $("beneficiary_id").value = match[1];

        $("confirmed").checked = false;
        $("saveBtn").disabled = true;

        speak(
            `Beneficiary ID updated to ${match[1]}. ${readForm()}`
        );

        return;
    }

    if (lower.includes("anc") || lower.includes("antenatal")) {
        $("visit_type").value = "ANC";
    }

    else if (lower.includes("pnc")) {
        $("visit_type").value = "PNC";
    }

    else if (lower.includes("newborn")) {
        $("visit_type").value = "Newborn";
    }

    else if (lower.includes("immun")) {
        $("visit_type").value = "Immunisation";
    }

    else if (
        lower.includes("tt") ||
        lower.includes("ifa") ||
        lower.includes("vaccine")
    ) {
        $("vaccinations_due").value = value;
    }

    else if (/\b(save|yes|correct|confirm)\b/.test(lower)) {
        $("confirmed").checked = true;
        saveVisit();
        return;
    }

    else if (/\b(no|wrong|change|correction)\b/.test(lower)) {
        speak(
            "Please say the field and its correct value. " +
            "For example, weight 2.8 kilo."
        );
        return;
    }

    else {
        const dateMatch = lower.match(
            /(?:next visit|date|visit)[^0-9]*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/
        );

        if (dateMatch) {
            const day = dateMatch[1].padStart(2, "0");
            const month = dateMatch[2].padStart(2, "0");
            const year = dateMatch[3];

            $("next_visit_date").value =
                `${year}-${month}-${day}`;
        } else {
            speak(
                "I did not understand the correction. " +
                "Please repeat the field and correct value."
            );
            return;
        }
    }

    $("confirmed").checked = false;
    $("saveBtn").disabled = true;

    speak("Correction received. " + readForm());
}


// ---------------- EXTRACT VISIT ----------------

async function extract() {
    const note = normalizeSpokenNumbers(
        $("note").value.trim()
    );

    $("note").value = note;

    if (!note) {
        status("No transcript yet.");
        return;
    }

    try {
        const response = await fetch("/api/extract", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                note,
                beneficiary_id:
                    $("beneficiary_id").value.trim() || null
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Extraction failed");
        }

        fillRecord(data.record);

        if (data.danger_matches?.length) {
            $("dangerBox").classList.remove("hidden");

            $("dangerBox").textContent =
                "⚠ DANGER SIGN — " +
                data.danger_matches.map(item =>
                    item.label + "; " + item.referral_message
                ).join(" | ");

            speak(
                data.danger_matches
                    .map(item => item.referral_message)
                    .join(" ")
            );
        } else {
            $("dangerBox").classList.add("hidden");
        }

        speak(readForm());

    } catch (error) {
        status("Extract error: " + error.message);
    }
}


// ---------------- SAVE VISIT ----------------

async function saveVisit() {
    const record = getRecord();

    if (!record.beneficiary_id) {
        status("Beneficiary ID is required.");
        await speak("Beneficiary ID is missing.");
        return;
    }

    if (!record.confirmed) {
        status("Please confirm the read-back first.");
        return;
    }

    try {
        const response = await fetch("/api/visits", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                record
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Save failed");
        }

        $("saveStatus").textContent =
            `Saved visit ${data.visit_id}. ` +
            `Danger flag: ${data.danger_flag ? "YES" : "No"}`;

        $("saveBtn").disabled = true;

        await speak("Visit saved.");

        await loadAllData();

    } catch (error) {
        $("saveStatus").textContent =
            "Save error: " + error.message;
    }
}


// ---------------- FOLLOW-UPS ----------------

async function loadFollowups() {
    const response = await fetch("/api/followups");

    if (!response.ok) {
        throw new Error(
            `Follow-ups API: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    // Backend returns a direct array.
    const items = Array.isArray(data) ? data : [];

    $("followups").innerHTML = items.length
        ? items.map(item => `
            <div class="followup">
                <span>
                    ${esc(item.beneficiary_id)} ·
                    ${esc(item.task_description)} ·
                    ${esc(item.due_date || "date not set")}
                </span>

                <strong class="${
                    item.priority === "urgent" ? "urgent" : "normal"
                }">
                    ${esc(item.priority || "normal")}
                </strong>
            </div>
        `).join("")
        : `<div class="empty">No follow-ups.</div>`;

    return items;
}


// ---------------- DASHBOARD ----------------

async function loadDashboard() {
    const visitsResponse = await fetch("/api/visits");

    if (!visitsResponse.ok) {
        throw new Error(
            `Visits API: HTTP ${visitsResponse.status}`
        );
    }

    const visitsData = await visitsResponse.json();

    const visits = Array.isArray(visitsData)
        ? visitsData
        : [];

    const followResponse = await fetch("/api/followups");

    if (!followResponse.ok) {
        throw new Error(
            `Follow-ups API: HTTP ${followResponse.status}`
        );
    }

    const followData = await followResponse.json();

    const tasks = Array.isArray(followData)
        ? followData
        : [];

    const uniqueBeneficiaries = new Set(
        visits.map(item => item.beneficiary_id).filter(Boolean)
    );

    if ($("statBeneficiaries")) {
        $("statBeneficiaries").textContent =
            uniqueBeneficiaries.size;
    }

    if ($("statVisits")) {
        $("statVisits").textContent = visits.length;
    }

    if ($("statFollowups")) {
        $("statFollowups").textContent =
            tasks.filter(item =>
                (item.status || "pending").toLowerCase() === "pending"
            ).length;
    }

    if ($("statDanger")) {
        $("statDanger").textContent =
            visits.filter(item => Boolean(item.danger_flag)).length;
    }

    if ($("visitRows")) {
        $("visitRows").innerHTML = visits.length
            ? visits.slice(0, 10).map(item => `
                <tr>
                    <td>${esc(item.beneficiary_id || "—")}</td>
                    <td>${esc(item.visit_type || "—")}</td>
                    <td>${
                        item.weight_kg == null
                            ? "—"
                            : esc(item.weight_kg)
                    }</td>
                    <td>${esc(item.vaccination_status || "Not specified")}</td>
                    <td>${esc(item.next_visit_date || "—")}</td>
                    <td>${esc(item.created_at || "—")}</td>
                </tr>
            `).join("")
            : `
                <tr>
                    <td colspan="6" class="table-empty">
                        No saved visits yet.
                    </td>
                </tr>
            `;
    }

    if ($("dashboardStatus")) {
        $("dashboardStatus").textContent =
            `Loaded ${visits.length} saved visit(s) from SQLite.`;
    }
}


// This function is called by auth-patients.js after successful login.
async function loadAllData() {
    if ($("appContent") && $("appContent").hidden) {
        return;
    }

    const results = await Promise.allSettled([
        loadFollowups(),
        loadDashboard()
    ]);

    const failed = results.find(
        result => result.status === "rejected"
    );

    if (failed && $("dashboardStatus")) {
        $("dashboardStatus").textContent =
            "Could not load all database data: " +
            failed.reason.message;
    }
}


// ---------------- DASHBOARD ADDITIONS ----------------

(function addDashboard() {
    const beneficiaryInput = $("beneficiary_id");

    if (beneficiaryInput) {
        beneficiaryInput.readOnly = false;
    }

    const hero = document.querySelector(".hero");

    if (!hero || $("liveDashboard")) {
        return;
    }

    const panel = document.createElement("section");

    panel.className = "panel";
    panel.id = "liveDashboard";

    panel.innerHTML = `
        <div class="section-title">
            <div>
                <p class="eyebrow">LIVE DATABASE</p>
                <h2>Beneficiary dashboard</h2>
            </div>

            <button
                id="dashboardRefreshBtn"
                class="small"
                type="button"
            >
                Refresh dashboard
            </button>
        </div>

        <div class="dashboard-cards">
            <article class="dashboard-card">
                <span>Total beneficiaries</span>
                <strong id="statBeneficiaries">—</strong>
            </article>

            <article class="dashboard-card">
                <span>Saved visits</span>
                <strong id="statVisits">—</strong>
            </article>

            <article class="dashboard-card">
                <span>Pending follow-ups</span>
                <strong id="statFollowups">—</strong>
            </article>

            <article class="dashboard-card">
                <span>Danger-flagged visits</span>
                <strong id="statDanger">—</strong>
            </article>
        </div>

        <h3 class="subheading">Recent saved visits</h3>

        <div class="table-wrap">
            <table class="records-table">
                <thead>
                    <tr>
                        <th>Beneficiary ID</th>
                        <th>Visit type</th>
                        <th>Weight (kg)</th>
                        <th>Vaccination</th>
                        <th>Next visit</th>
                        <th>Saved</th>
                    </tr>
                </thead>

                <tbody id="visitRows">
                    <tr>
                        <td colspan="6" class="table-empty">
                            Loading records…
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <p
            id="dashboardStatus"
            class="hint"
            aria-live="polite"
        >
            Waiting for login…
        </p>
    `;

    hero.insertAdjacentElement("afterend", panel);

    const style = document.createElement("style");

    style.textContent = `
        .dashboard-cards {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
        }

        .dashboard-card {
            background: #f2f8f5;
            border: 1px solid #e1ebe6;
            border-radius: 13px;
            padding: 16px;
        }

        .dashboard-card span {
            display: block;
            color: #61746e;
            font-size: .82rem;
        }

        .dashboard-card strong {
            display: block;
            font-size: 1.8rem;
            margin-top: 7px;
            color: #176b53;
        }

        .subheading {
            font-size: 1rem;
            margin: 24px 0 10px;
        }

        .table-wrap {
            overflow-x: auto;
        }

        .records-table {
            width: 100%;
            border-collapse: collapse;
            font-size: .88rem;
        }

        .records-table th,
        .records-table td {
            text-align: left;
            padding: 11px 10px;
            border-bottom: 1px solid #e8efeb;
            white-space: nowrap;
        }

        .records-table th {
            color: #61746e;
            background: #f7faf8;
        }

        .table-empty {
            text-align: center !important;
            color: #71817b;
            padding: 20px !important;
        }

        @media (max-width: 650px) {
            .dashboard-cards {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
        }
    `;

    document.head.appendChild(style);

    $("dashboardRefreshBtn").onclick = loadAllData;
})();


// ---------------- BUTTON EVENTS ----------------

$("startBtn").onclick = () => startCapture(false);
$("stopBtn").onclick = stopCapture;
$("extractBtn").onclick = extract;

$("readBtn").onclick = () => speak(readForm());

$("correctionBtn").onclick = () => startCapture(true);

$("saveBtn").onclick = saveVisit;

$("refreshBtn").onclick = loadAllData;

$("confirmed").onchange = () => {
    $("saveBtn").disabled = !$("confirmed").checked;
};

$("note").oninput = () => {
    finalTranscript = $("note").value;
    partialTranscript = "";
};


// Editing any extracted field requires a new confirmation.
[
    "beneficiary_id",
    "visit_type",
    "weight_kg",
    "vaccination_status",
    "vaccinations_due",
    "next_visit_date"
].forEach(id => {
    const element = $(id);

    if (!element) return;

    element.addEventListener("input", () => {
        $("confirmed").checked = false;
        $("saveBtn").disabled = true;
    });

    element.addEventListener("change", () => {
        $("confirmed").checked = false;
        $("saveBtn").disabled = true;
    });
});


// ---------------- API STATUS ----------------

fetch("/api/health")
    .then(response => {
        if (!response.ok) {
            throw new Error("Backend health check failed");
        }

        return response.json();
    })
    .then(data => {
        $("apiStatus").textContent =
            data.gnani_configured
                ? "Backend ready · Gnani key configured"
                : "Backend ready · Add Gnani API key";
    })
    .catch(() => {
        $("apiStatus").textContent = "Backend unavailable";
    });


// Do not call loadAllData() here.
// auth-patients.js calls it after successful login.
