const $id = (id) => document.getElementById(id);
let currentPatient = null;
let qrScanner = null;
async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || `Error ${response.status}`);
    }
    return data;
}
// LOGIN AND DASHBOARD
function showLogin() {
    $id("authPanel").hidden = false;
    $id("appContent").hidden = true;
}
function showApplication(username) {
    $id("authPanel").hidden = true;
    $id("appContent").hidden = false;
    $id("workerInfo").textContent = `Logged in as: ${username}`;

    if (typeof loadAllData === "function") {
        loadAllData();
    }
}
$id("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = $id("username").value.trim();
    const password = $id("password").value;

    $id("loginStatus").textContent = "Checking login...";

    try {
        const result = await api("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        $id("loginForm").reset();
        $id("loginStatus").textContent = "";
        showApplication(result.username);
    } catch (error) {
        $id("loginStatus").textContent = error.message;
    }
});

async function checkSession() {
    try {
        const result = await api("/api/auth/me");
        showApplication(result.username);
    } catch {
        showLogin();
    }
}

$id("logoutBtn").addEventListener("click", async () => {
    try {
        await api("/api/auth/logout", { method: "POST" });
    } catch (error) {
        console.error(error);
    }

    await stopQrScanner();
    currentPatient = null;
    $id("patientProfile").hidden = true;
    showLogin();
});

// PATIENT REGISTRATION

$id("patientForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const patient = {
        name: $id("patientName").value.trim(),
        age: Number($id("patientAge").value),
        phone: $id("patientPhone").value.trim() || null
    };

    $id("registrationStatus").textContent = "Registering...";

    try {
        const result = await api("/api/patients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patient)
        });

        $id("registrationStatus").textContent =
            `Patient registered. ID: ${result.patient_id}`;

        $id("patientForm").reset();
        displayPatient(result);
    } catch (error) {
        $id("registrationStatus").textContent =
            `Registration failed: ${error.message}`;
    }
});

// SEARCH PATIENT BY ID

$id("manualSearchBtn").addEventListener("click", async () => {
    const patientId = $id("patientSearchId").value.trim();

    if (!patientId) {
        $id("lookupStatus").textContent = "Enter a patient ID.";
        return;
    }

    await findPatient(patientId);
});

async function findPatient(patientId) {
    $id("lookupStatus").textContent = "Searching...";

    try {
        const patient = await api(
            `/api/patients/${encodeURIComponent(patientId)}`
        );

        displayPatient(patient);
        $id("lookupStatus").textContent = "Patient found.";
    } catch (error) {
        currentPatient = null;
        $id("patientProfile").hidden = true;
        $id("lookupStatus").textContent = error.message;
    }
}

function displayPatient(patient) {
    currentPatient = patient;

    $id("profilePatientId").textContent = patient.patient_id;
    $id("profilePatientName").textContent = patient.name;
    $id("profilePatientAge").textContent = patient.age;
    $id("profilePatientPhone").textContent =
        patient.phone || "Not provided";

    $id("patientProfile").hidden = false;
    $id("idCard").hidden = true;

    // Link this patient to the visit form.
    $id("beneficiary_id").value = patient.patient_id;
}

// GENERATE QR ID CARD

$id("generateCardBtn").addEventListener("click", () => {
    if (!currentPatient) return;

    if (typeof QRCode === "undefined") {
        $id("lookupStatus").textContent =
            "QR code library did not load.";
        return;
    }

    $id("cardPatientName").textContent = currentPatient.name;
    $id("cardPatientId").textContent = currentPatient.patient_id;

    const qrBox = $id("cardQr");
    qrBox.replaceChildren();

    new QRCode(qrBox, {
        text: currentPatient.patient_id,
        width: 160,
        height: 160
    });

    $id("idCard").hidden = false;
});

// PRINT ID CARD

$id("printCardBtn").addEventListener("click", () => {
    if (!currentPatient || $id("idCard").hidden) return;

    const card = $id("idCard");
    const qrImage = card.querySelector("img");
    const qrCanvas = card.querySelector("canvas");

    const qrSource = qrImage?.src ||
        (qrCanvas ? qrCanvas.toDataURL() : "");

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
        $id("lookupStatus").textContent =
            "Please allow pop-ups to print the ID card.";
        return;
    }

    const safeName = escapeHtml(currentPatient.name);
    const safeId = escapeHtml(currentPatient.patient_id);

    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ASHA Project ID Card</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 30px;
                }
                .card {
                    border: 2px solid #26745c;
                    border-radius: 14px;
                    padding: 25px;
                    width: 300px;
                    margin: auto;
                }
                img { margin: 15px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>ASHA VoiceCare</h2>
                <p>PROJECT PATIENT ID CARD</p>
                <h3>${safeName}</h3>
                <p>${safeId}</p>
                <img src="${qrSource}" alt="Project patient QR code">
                <p>Project demonstration only</p>
            </div>
            <script>
                window.onload = () => window.print();
            <\/script>
        </body>
        </html>
    `);

    printWindow.document.close();
});

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

// SCAN QR CODE USING CAMERA

$id("startScanBtn").addEventListener("click", startQrScanner);
$id("stopScanBtn").addEventListener("click", stopQrScanner);

async function startQrScanner() {
    if (typeof Html5Qrcode === "undefined") {
        $id("scanStatus").textContent =
            "QR scanner library did not load.";
        return;
    }

    try {
        qrScanner = new Html5Qrcode("qrVideo");

        await qrScanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            async (decodedText) => {
                const patientId = decodedText.trim();

                await stopQrScanner();

                $id("patientSearchId").value = patientId;
                await findPatient(patientId);
            },
            () => {}
        );

        $id("qrVideo").hidden = false;
        $id("startScanBtn").disabled = true;
        $id("stopScanBtn").disabled = false;
        $id("scanStatus").textContent =
            "Camera active. Scan the project ID card.";
    } catch (error) {
        $id("scanStatus").textContent =
            `Camera error: ${error.message}`;
        await stopQrScanner();
    }
}

async function stopQrScanner() {
    if (qrScanner) {
        try {
            if (qrScanner.isScanning) {
                await qrScanner.stop();
            }
            await qrScanner.clear();
        } catch (error) {
            console.warn("QR scanner cleanup:", error);
        }

        qrScanner = null;
    }

    $id("qrVideo").hidden = true;
    $id("startScanBtn").disabled = false;
    $id("stopScanBtn").disabled = true;
}

// CHECK WHETHER A WORKER IS ALREADY LOGGED IN

checkSession();
