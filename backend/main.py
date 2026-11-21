
from fastapi import (
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    Depends,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Optional
from pathlib import Path
from datetime import date, datetime, timezone
from dotenv import load_dotenv

import sqlite3
import json
import re
import uuid
import os
import asyncio
import logging
import secrets

from backend.auth import (
    router as auth_router,
    get_current_user,
    SESSION_COOKIE,
    hash_token,
)

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

BASE = Path(__file__).resolve().parent.parent

load_dotenv(BASE / ".env")

DB_PATH = BASE / "asha_voicecare.db"
RULES_PATH = BASE / "data" / "danger_signs.json"

log = logging.getLogger("asha_voicecare")

app = FastAPI(
    title="ASHA VoiceCare — Gnani PS1",
    version="3.0.0"
)

app.include_router(auth_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# DATABASE
# --------------------------------------------------

def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with db() as connection:

        connection.execute("""
            CREATE TABLE IF NOT EXISTS visits (
                visit_id TEXT PRIMARY KEY,
                beneficiary_id TEXT NOT NULL,
                visit_type TEXT,
                weight_kg REAL,
                vaccination_status TEXT,
                vaccinations_due TEXT,
                next_visit_date TEXT,
                original_note TEXT,
                confirmed INTEGER NOT NULL DEFAULT 0,
                danger_flag INTEGER NOT NULL DEFAULT 0,
                danger_matches TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS followups (
                task_id TEXT PRIMARY KEY,
                visit_id TEXT NOT NULL,
                beneficiary_id TEXT NOT NULL,
                task_description TEXT NOT NULL,
                due_date TEXT,
                priority TEXT DEFAULT 'normal',
                status TEXT DEFAULT 'pending'
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS patients (
                patient_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER NOT NULL,
                phone TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)


init_db()

# --------------------------------------------------
# REQUEST MODELS
# --------------------------------------------------

class ExtractRequest(BaseModel):
    note: str = Field(min_length=2, max_length=5000)
    beneficiary_id: Optional[str] = None


class VisitRecord(BaseModel):
    beneficiary_id: str
    visit_type: Optional[str] = None
    weight_kg: Optional[float] = None
    vaccination_status: Optional[str] = None
    vaccinations_due: Optional[str] = None
    next_visit_date: Optional[str] = None
    original_note: str
    confirmed: bool = False


class ConfirmRequest(BaseModel):
    record: VisitRecord


class PatientCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    age: int = Field(ge=0, le=120)
    phone: Optional[str] = Field(default=None, max_length=15)


# --------------------------------------------------
# DANGER SIGN RULES
# --------------------------------------------------

def load_rules():
    if not RULES_PATH.exists():
        log.warning("Danger-sign rules file was not found.")
        return []

    return json.loads(
        RULES_PATH.read_text(encoding="utf-8")
    )


def danger_check(note):
    text = note.casefold()
    matches = []

    for rule in load_rules():
        phrases = rule.get("phrases", [])

        if any(
            phrase.casefold() in text
            for phrase in phrases
        ):
            matches.append({
                "rule_id": rule["id"],
                "label": rule["label"],
                "referral_message": rule["referral_message"]
            })

    return matches


# --------------------------------------------------
# DATA EXTRACTION
# --------------------------------------------------

def extract_weight(note):

    patterns = [
        r"(?:weight|weighs?|wazan|ತೂಕ|वजन)\s*(?:is|of|=|:)?\s*(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?|ಕಿಲೋ|किलो)?",
        r"(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?|ಕಿಲೋ|किलो)"
    ]

    for pattern in patterns:
        match = re.search(pattern, note, re.I)

        if match:
            try:
                value = float(match.group(1))

                if 0.2 <= value <= 200:
                    return value

            except ValueError:
                pass

    return None


def extract_date(note):

    match = re.search(
        r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b",
        note
    )

    if match:
        day, month, year = map(int, match.groups())

        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return None

    match = re.search(
        r"\b(\d{4}-\d{2}-\d{2})\b",
        note
    )

    if match:
        try:
            return date.fromisoformat(match.group(1)).isoformat()
        except ValueError:
            return None

    months = {
        "january": 1, "jan": 1,
        "february": 2, "feb": 2,
        "march": 3, "mar": 3,
        "april": 4, "apr": 4,
        "may": 5,
        "june": 6, "jun": 6,
        "july": 7, "jul": 7,
        "august": 8, "aug": 8,
        "september": 9, "sep": 9, "sept": 9,
        "october": 10, "oct": 10,
        "november": 11, "nov": 11,
        "december": 12, "dec": 12
    }

    match = (
        re.search(
            r"\b(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\b",
            note,
            re.I
        )
        or
        re.search(
            r"\b([a-zA-Z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b",
            note,
            re.I
        )
    )

    if match:

        if match.group(1).isdigit():
            day = int(match.group(1))
            month = months.get(match.group(2).lower())
            year = (
                int(match.group(3))
                if match.group(3)
                else date.today().year
            )

        else:
            month = months.get(match.group(1).lower())
            day = int(match.group(2))
            year = (
                int(match.group(3))
                if match.group(3)
                else date.today().year
            )

        if month:
            try:
                result = date(year, month, day)

                if not match.group(3) and result < date.today():
                    result = date(year + 1, month, day)

                return result.isoformat()

            except ValueError:
                return None

    return None


def extract_record(note, beneficiary_id=None):

    text = note.casefold()
    bid = beneficiary_id or ""

    if not bid:
        match = re.search(
            r"(?:beneficiary\s*id|beneficiary|id)\s*[:#-]?\s*([a-z0-9-]+)",
            note,
            re.I
        )

        bid = match.group(1) if match else ""

    visit_type = None

    visit_categories = [
        (["anc", "antenatal", "pregnancy", "ಗರ್ಭಿಣಿ", "गर्भवती"], "ANC"),
        (["pnc", "postnatal", "post natal"], "PNC"),
        (["newborn", "new born", "ನವಜಾತ", "नवजात"], "Newborn"),
        (["immunisation", "immunization", "vaccination", "vaccine", "ಲಸಿಕೆ", "टीका"], "Immunisation")
    ]

    for terms, label in visit_categories:
        if any(term in text for term in terms):
            visit_type = label
            break

    status = None

    if any(term in text for term in [
        "given", "completed", "administered", "ಕೊಟ್ಟ", "दिया"
    ]):
        status = "Reported given (verify vaccine)"

    elif any(term in text for term in [
        "due", "pending", "not given", "ಬಾಕಿ", "नहीं लगा"
    ]):
        status = "Reported due/pending (verify vaccine)"

    items = []

    if any(term in text for term in [
        "ifa", "iron folic", "ifa goli", "ifa गोली"
    ]):
        items.append("IFA mentioned")

    if any(term in text for term in [
        "tt injection", "tetanus", "tt", "ಟಿಟಿ"
    ]):
        items.append("TT mentioned")

    return {
        "beneficiary_id": bid,
        "visit_type": visit_type,
        "weight_kg": extract_weight(note),
        "vaccination_status": status,
        "vaccinations_due": "; ".join(items) or None,
        "next_visit_date": extract_date(note),
        "original_note": note,
        "confirmed": False
    }


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.get("/api/health")
def health():

    return {
        "status": "ok",
        "app": "ASHA VoiceCare",
        "speech_provider": "Gnani Prisma v3 streaming / Timbre realtime TTS",
        "gnani_configured": bool(os.getenv("GNANI_API_KEY"))
    }


# --------------------------------------------------
# PATIENT REGISTRATION
# --------------------------------------------------

@app.post("/api/patients")
def register_patient(
    patient: PatientCreate,
    user=Depends(get_current_user)
):

    patient_id = "ASHA-" + secrets.token_hex(3).upper()

    with db() as connection:

        connection.execute(
            """
            INSERT INTO patients (
                patient_id,
                name,
                age,
                phone,
                created_by
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                patient_id,
                patient.name.strip(),
                patient.age,
                patient.phone,
                user["username"]
            )
        )

    return {
        "patient_id": patient_id,
        "name": patient.name.strip(),
        "age": patient.age,
        "phone": patient.phone
    }


# --------------------------------------------------
# PATIENT SEARCH
# --------------------------------------------------

@app.get("/api/patients/{patient_id}")
def get_patient(
    patient_id: str,
    user=Depends(get_current_user)
):

    with db() as connection:

        patient = connection.execute(
            """
            SELECT patient_id, name, age, phone, created_at
            FROM patients
            WHERE patient_id = ?
            """,
            (patient_id.strip(),)
        ).fetchone()

    if patient is None:
        raise HTTPException(
            status_code=404,
            detail="Patient not found"
        )

    return dict(patient)


# --------------------------------------------------
# EXTRACT API
# --------------------------------------------------

@app.post("/api/extract")
def extract(
    req: ExtractRequest,
    user=Depends(get_current_user)
):

    return extract_record(
        req.note,
        req.beneficiary_id
    )


# --------------------------------------------------
# VALIDATE API
# --------------------------------------------------

@app.post("/api/validate")
def validate(
    req: ExtractRequest,
    user=Depends(get_current_user)
):

    record = extract_record(
        req.note,
        req.beneficiary_id
    )

    matches = danger_check(req.note)

    return {
        "record": record,
        "danger_flag": bool(matches),
        "danger_matches": matches
    }


# --------------------------------------------------
# SAVE VISIT API
# --------------------------------------------------

@app.post("/api/visits")
def save_visit(
    req: ConfirmRequest,
    user=Depends(get_current_user)
):

    record = req.record

    if not record.beneficiary_id.strip():
        raise HTTPException(
            status_code=400,
            detail="Beneficiary ID is required"
        )

    if not record.confirmed:
        raise HTTPException(
            status_code=400,
            detail="Read-back confirmation is required before save"
        )

    matches = danger_check(record.original_note)
    visit_id = str(uuid.uuid4())

    with db() as connection:

        connection.execute(
            """
            INSERT INTO visits (
                visit_id,
                beneficiary_id,
                visit_type,
                weight_kg,
                vaccination_status,
                vaccinations_due,
                next_visit_date,
                original_note,
                confirmed,
                danger_flag,
                danger_matches
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                visit_id,
                record.beneficiary_id,
                record.visit_type,
                record.weight_kg,
                record.vaccination_status,
                record.vaccinations_due,
                record.next_visit_date,
                record.original_note,
                int(bool(matches)),
                json.dumps(matches, ensure_ascii=False)
            )
        )

        if record.next_visit_date:

            connection.execute(
                """
                INSERT INTO followups (
                    task_id,
                    visit_id,
                    beneficiary_id,
                    task_description,
                    due_date,
                    priority
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    visit_id,
                    record.beneficiary_id,
                    "Next household visit",
                    record.next_visit_date,
                    "urgent" if matches else "normal"
                )
            )

        if matches:

            connection.execute(
                """
                INSERT INTO followups (
                    task_id,
                    visit_id,
                    beneficiary_id,
                    task_description,
                    due_date,
                    priority
                )
                VALUES (?, ?, ?, ?, ?, 'urgent')
                """,
                (
                    str(uuid.uuid4()),
                    visit_id,
                    record.beneficiary_id,
                    "Urgent PHC referral — follow approved protocol",
                    date.today().isoformat()
                )
            )

    return {
        "saved": True,
        "visit_id": visit_id,
        "danger_flag": bool(matches),
        "danger_matches": matches
    }


# --------------------------------------------------
# FOLLOWUPS API
# --------------------------------------------------

@app.get("/api/followups")
def followups(user=Depends(get_current_user)):

    with db() as connection:

        rows = connection.execute(
            "SELECT * FROM followups ORDER BY due_date"
        ).fetchall()

    return [dict(row) for row in rows]


# --------------------------------------------------
# VISITS API
# --------------------------------------------------

@app.get("/api/visits")
def visits(user=Depends(get_current_user)):

    with db() as connection:

        rows = connection.execute(
            "SELECT * FROM visits ORDER BY rowid DESC"
        ).fetchall()

    return [dict(row) for row in rows]


# --------------------------------------------------
# WEBSOCKET SESSION AUTHENTICATION
# --------------------------------------------------

def websocket_user(token):

    if not token:
        return None

    token_hash = hash_token(token)

    with db() as connection:

        session = connection.execute(
            """
            SELECT users.user_id, users.username, users.role,
                   sessions.expires_at
            FROM sessions
            JOIN users ON users.user_id = sessions.user_id
            WHERE sessions.token_hash = ?
            """,
            (token_hash,)
        ).fetchone()

    if not session:
        return None

    try:
        expiry = datetime.fromisoformat(session["expires_at"])

        if expiry <= datetime.now(timezone.utc):
            return None

    except (ValueError, TypeError):
        return None

    return {
        "user_id": session["user_id"],
        "username": session["username"],
        "role": session["role"]
    }


# --------------------------------------------------
# GNANI PRISMA STREAMING SPEECH TO TEXT
# --------------------------------------------------

@app.websocket("/ws/gnani-stt")
async def gnani_stt_ws(ws: WebSocket):

    token = ws.cookies.get(SESSION_COOKIE)
    user = websocket_user(token)

    if not user:
        await ws.close(code=1008, reason="Login required")
        return

    await ws.accept()

    key = os.getenv("GNANI_API_KEY", "").strip()

    if not key:
        await ws.send_json({
            "type": "error",
            "message": "Set GNANI_API_KEY in .env to enable Prisma streaming."
        })
        await ws.close()
        return

    language = ws.query_params.get(
        "language",
        "indic-auto"
    )

    try:

        from gnani.stt import (
            GnaniSTTStreamClient,
            StreamTranscriptEvent,
            StreamProcessingEvent,
            StreamErrorEvent,
        )

        async with GnaniSTTStreamClient(
            api_key=key,
            language_code=language,
            model=os.getenv(
                "GNANI_STT_MODEL",
                "prisma-v3.0"
            ),
            format="codemix",
        ) as stream:

            await ws.send_json({
                "type": "ready",
                "provider": "Gnani Prisma v3.0",
                "sample_rate": 16000,
            })

            async def listen_events():

                async for event in stream.events():

                    if isinstance(event, StreamTranscriptEvent):

                        await ws.send_json({
                            "type": "transcript",
                            "text": event.text,
                            "language": getattr(
                                event,
                                "detected_language_code",
                                None
                            ),
                            "latency": getattr(
                                event,
                                "latency",
                                None
                            ),
                        })

                    elif isinstance(event, StreamProcessingEvent):

                        await ws.send_json({
                            "type": "processing"
                        })

                    elif isinstance(event, StreamErrorEvent):

                        await ws.send_json({
                            "type": "error",
                            "message": event.message,
                        })

            listener = asyncio.create_task(
                listen_events()
            )

            try:

                while True:

                    message = await ws.receive()

                    if message.get("bytes") is not None:

                        await stream.send_audio(
                            message["bytes"]
                        )

                    elif message.get("text"):

                        control = json.loads(
                            message["text"]
                        )

                        if control.get("type") == "stop":
                            await asyncio.sleep(0.8)
                            break

            except WebSocketDisconnect:
                pass

            finally:

                try:
                    await stream.close()
                except Exception:
                    pass

                if not listener.done():
                    listener.cancel()

                try:
                    await listener
                except asyncio.CancelledError:
                    pass

        try:
            await ws.send_json({
                "type": "stream_done"
            })
            await ws.close()
        except Exception:
            pass

    except WebSocketDisconnect:
        pass

    except Exception as error:

        log.exception(
            "Gnani STT websocket failed"
        )

        try:
            await ws.send_json({
                "type": "error",
                "message": str(error)[:350],
            })
            await ws.close()
        except Exception:
            pass


# --------------------------------------------------
# FRONTEND
# --------------------------------------------------

app.mount(
    "/",
    StaticFiles(
        directory=BASE / "frontend",
        html=True
    ),
    name="frontend"
)

