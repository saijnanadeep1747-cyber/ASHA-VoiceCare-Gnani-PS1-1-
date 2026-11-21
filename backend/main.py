from fastapi import FastAPI, HTTPException, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Optional
from pathlib import Path
from datetime import date, datetime
import sqlite3, json, re, uuid, os, tempfile, base64, asyncio, logging
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "asha_voicecare.db"
RULES_PATH = BASE / "data" / "danger_signs.json"
log = logging.getLogger("asha_voicecare")
app = FastAPI(title="ASHA VoiceCare — Gnani PS1", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# ---- SQLite (demo data only) ----
def db():
    c = sqlite3.connect(DB_PATH); c.row_factory = sqlite3.Row; return c

def init_db():
    with db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS visits(
            visit_id TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL, visit_type TEXT,
            weight_kg REAL, vaccination_status TEXT, vaccinations_due TEXT,
            next_visit_date TEXT, original_note TEXT, confirmed INTEGER NOT NULL DEFAULT 0,
            danger_flag INTEGER NOT NULL DEFAULT 0, danger_matches TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP)""")
        c.execute("""CREATE TABLE IF NOT EXISTS followups(
            task_id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, beneficiary_id TEXT NOT NULL,
            task_description TEXT NOT NULL, due_date TEXT, priority TEXT DEFAULT 'normal',
            status TEXT DEFAULT 'pending')""")
init_db()

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

# Phrase rules are intentionally deterministic. Do not replace with diagnostic inference.
def load_rules(): return json.loads(RULES_PATH.read_text(encoding="utf-8"))
def danger_check(note):
    low=note.casefold(); matches=[]
    for rule in load_rules():
        if any(p.casefold() in low for p in rule.get("phrases", [])):
            matches.append({"rule_id":rule["id"],"label":rule["label"],"referral_message":rule["referral_message"]})
    return matches

def extract_weight(note):
    # Numeric values and common spoken-unit variants; range is sanity check only.
    patterns=[r"(?:weight|weighs?|wazan|ತೂಕ|वजन)\s*(?:is|of|=|:)?\s*(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?|ಕಿಲೋ|ಕिलो)?",
             r"(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?|ಕಿಲೋ|किलो)"]
    for p in patterns:
        m=re.search(p,note,re.I)
        if m:
            try:
                v=float(m.group(1)); return v if 0.2 <= v <= 200 else None
            except ValueError: pass
    return None

def extract_date(note):
    for m in re.finditer(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b",note):
        d,mo,y=map(int,m.groups())
        try: return date(y,mo,d).isoformat()
        except ValueError: pass
    m=re.search(r"\b(\d{4}-\d{2}-\d{2})\b",note)
    if m:
        try: return date.fromisoformat(m.group(1)).isoformat()
        except ValueError: return None
    # Recognize explicit English month names. Relative expressions are not guessed.
    months={"january":1,"jan":1,"february":2,"feb":2,"march":3,"mar":3,"april":4,"apr":4,"may":5,"june":6,"jun":6,"july":7,"jul":7,"august":8,"aug":8,"september":9,"sep":9,"sept":9,"october":10,"oct":10,"november":11,"nov":11,"december":12,"dec":12}
    m=re.search(r"\b(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\b",note,re.I) or re.search(r"\b([a-zA-Z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b",note,re.I)
    if m:
        if m.group(1).isdigit(): day=int(m.group(1)); month=months.get(m.group(2).lower()); year=int(m.group(3)) if m.group(3) else date.today().year
        else: month=months.get(m.group(1).lower()); day=int(m.group(2)); year=int(m.group(3)) if m.group(3) else date.today().year
        if month:
            try:
                d=date(year,month,day)
                if not m.group(3) and d<date.today(): d=date(year+1,month,day)
                return d.isoformat()
            except ValueError: return None
    # Relative expressions are deliberately not guessed; ask the worker to specify a date.
    return None

def extract_record(note, beneficiary_id=None):
    low=note.casefold(); bid=beneficiary_id or ""
    if not bid:
        m=re.search(r"(?:beneficiary\s*id|beneficiary|id)\s*[:#-]?\s*([a-z0-9-]+)",note,re.I)
        bid=m.group(1) if m else ""
    vt=None
    for terms,label in [(["anc","antenatal","pregnancy","ಗರ್ಭಿಣಿ","गर्भवती"],"ANC"),(["pnc","postnatal","post natal"],"PNC"),(["newborn","new born","ನವಜಾತ","नवजात"],"Newborn"),(["immunisation","immunization","vaccination","vaccine","ಲಸಿಕೆ","टीका"],"Immunisation")]:
        if any(t in low for t in terms): vt=label; break
    status=None
    if any(t in low for t in ["given","completed","administered","ಕೊಟ್ಟ","दिया"]): status="Reported given (verify vaccine)"
    elif any(t in low for t in ["due","pending","not given","ಬಾಕಿ","नहीं लगा"]): status="Reported due/pending (verify vaccine)"
    items=[]
    if any(t in low for t in ["ifa","iron folic","ifa goli","ifa गोली"]): items.append("IFA mentioned")
    if any(t in low for t in ["tt injection","tetanus","tt","ಟಿಟಿ"]): items.append("TT mentioned")
    return {"beneficiary_id":bid,"visit_type":vt,"weight_kg":extract_weight(note),"vaccination_status":status,"vaccinations_due":"; ".join(items) or None,"next_visit_date":extract_date(note),"original_note":note,"confirmed":False}

@app.get("/api/health")
def health():
    return {"status":"ok","app":"ASHA VoiceCare","speech_provider":"Gnani Prisma v3 streaming / Timbre realtime TTS","gnani_configured":bool(os.getenv("GNANI_API_KEY"))}

@app.post("/api/extract")
def extract(req:ExtractRequest):
    rec=extract_record(req.note,req.beneficiary_id); matches=danger_check(req.note)
    return {"record":rec,"danger_matches":matches,"needs_beneficiary_id":not bool(rec["beneficiary_id"])}
@app.post("/api/validate")
def validate(req:ExtractRequest): return {"danger_matches":danger_check(req.note)}

@app.post("/api/visits")
def save_visit(req:ConfirmRequest):
    r=req.record
    if not r.beneficiary_id.strip(): raise HTTPException(400,"Beneficiary ID is required")
    if not r.confirmed: raise HTTPException(400,"Read-back confirmation is required before save")
    matches=danger_check(r.original_note); vid=str(uuid.uuid4())
    with db() as c:
        c.execute("INSERT INTO visits(visit_id,beneficiary_id,visit_type,weight_kg,vaccination_status,vaccinations_due,next_visit_date,original_note,confirmed,danger_flag,danger_matches) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
                  (vid,r.beneficiary_id,r.visit_type,r.weight_kg,r.vaccination_status,r.vaccinations_due,r.next_visit_date,r.original_note,int(bool(matches)),json.dumps(matches,ensure_ascii=False)))
        if r.next_visit_date:
            c.execute("INSERT INTO followups(task_id,visit_id,beneficiary_id,task_description,due_date,priority) VALUES(?,?,?,?,?,?)",(str(uuid.uuid4()),vid,r.beneficiary_id,"Next household visit",r.next_visit_date,"urgent" if matches else "normal"))
        if matches:
            c.execute("INSERT INTO followups(task_id,visit_id,beneficiary_id,task_description,due_date,priority) VALUES(?,?,?,?,?,'urgent')",(str(uuid.uuid4()),vid,r.beneficiary_id,"Urgent PHC referral — follow approved protocol",date.today().isoformat()))
    return {"saved":True,"visit_id":vid,"danger_flag":bool(matches),"danger_matches":matches}
@app.get("/api/followups")
def followups():
    with db() as c: rows=c.execute("SELECT task_id,beneficiary_id,task_description,due_date,priority,status FROM followups ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,due_date").fetchall()
    return {"items":[dict(x) for x in rows]}
@app.get("/api/visits")
def visits():
    with db() as c: rows=c.execute("SELECT * FROM visits ORDER BY created_at DESC LIMIT 100").fetchall()
    return {"items":[dict(x) for x in rows]}

# Gnani Prisma v3.0 streaming. Browser sends mono 16 kHz signed PCM16 frames.

# Gnani Prisma streaming speech-to-text
# Browser sends mono 16 kHz signed PCM16 audio frames.

@app.websocket("/ws/gnani-stt")
async def gnani_stt_ws(ws: WebSocket):
    await ws.accept()

    key = os.getenv("GNANI_API_KEY", "").strip()

    if not key:
        await ws.send_json({
            "type": "error",
            "message": "Set GNANI_API_KEY in .env to enable Prisma streaming."
        })
        await ws.close()
        return

    language = ws.query_params.get("language", "indic-auto")

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
            model=os.getenv("GNANI_STT_MODEL", "prisma-v3.0"),
            format="codemix",
        ) as stream:

            await ws.send_json({
                "type": "ready",
                "provider": "Gnani Prisma v3.0",
                "sample_rate": 16000,
            })

            async def listen_events():
                async for ev in stream.events():

                    if isinstance(ev, StreamTranscriptEvent):
                        await ws.send_json({
                            "type": "transcript",
                            "text": ev.text,
                            "language": getattr(
                                ev, "detected_language_code", None
                            ),
                            "latency": getattr(ev, "latency", None),
                        })

                    elif isinstance(ev, StreamProcessingEvent):
                        await ws.send_json({
                            "type": "processing"
                        })

                    elif isinstance(ev, StreamErrorEvent):
                        await ws.send_json({
                            "type": "error",
                            "message": ev.message,
                        })

            listener = asyncio.create_task(listen_events())

            try:
                while True:
                    msg = await ws.receive()

                    if msg.get("bytes") is not None:
                        await stream.send_audio(msg["bytes"])

                    elif msg.get("text"):
                        control = json.loads(msg["text"])

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
            await ws.send_json({"type": "stream_done"})
            await ws.close()
        except Exception:
            pass

        except WebSocketDisconnect:
            pass

    except Exception as e:
        log.exception("Gnani STT websocket failed")

        try:
            await ws.send_json({
                "type": "error",
                "message": str(e)[:350],
            })
            await ws.close()
        except Exception:
            pass

        try:
            await ws.send_json({
                "type": "error",
                "message": str(e)[:350],
            })
            await ws.close()
        except Exception:
            pass


# Serve frontend files
app.mount(
    "/",
    StaticFiles(
        directory=BASE / "frontend",
        html=True
    ),
    name="frontend"
)
