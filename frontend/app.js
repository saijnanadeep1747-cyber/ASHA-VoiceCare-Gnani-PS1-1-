const $ = id => document.getElementById(id);
let ws=null, stream=null, ctx=null, processor=null, source=null, muteNode=null, pcmBuffer=[], captureActive=false, correctionMode=false;
let noteParts=[], finalTranscript="", partialTranscript="", dangerAlreadySpoken=false;
const API=location.origin;
function status(t){$('micStatus').textContent=t;}

// Convert common English spoken number words into digits before extraction.
function normalizeSpokenNumbers(input) {
  const small = {zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19};
  const tens = {twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90};
  const pattern = "zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
  const re = new RegExp("\\\\b(?:" + pattern + ")(?:[\\\\s-]+(?:" + pattern + "|and|point))*\\\\b", "gi");
  return String(input || "").replace(re, (phrase, offset, whole) => {
    const words = phrase.toLowerCase().replace(/-/g, " ").split(/\\s+/).filter(w => w !== "and");
    const prefix = whole.slice(Math.max(0, offset - 24), offset).toLowerCase();
    if (/\\b(?:id|identifier)\\s*$/i.test(prefix) && words.length > 1 && words.every(w => Object.prototype.hasOwnProperty.call(small, w) && small[w] < 10)) return words.map(w => small[w]).join("");
    let total = 0, current = 0, decimal = false, decimalDigits = "";
    for (const w of words) {
      if (w === "point") { decimal = true; continue; }
      if (decimal) {
        if (Object.prototype.hasOwnProperty.call(small, w) && small[w] < 10) decimalDigits += small[w]; else return phrase;
      } else if (Object.prototype.hasOwnProperty.call(small, w)) current += small[w];
      else if (Object.prototype.hasOwnProperty.call(tens, w)) current += tens[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w === "thousand") { total += (current || 1) * 1000; current = 0; }
      else return phrase;
    }
    const value = total + current;
    return decimal ? (decimalDigits ? `${value}.${decimalDigits}` : phrase) : String(value);
  });
}
function getRecord(){return {beneficiary_id:$('beneficiary_id').value.trim(),visit_type:$('visit_type').value||null,weight_kg:$('weight_kg').value===""?null:Number($('weight_kg').value),vaccination_status:$('vaccination_status').value.trim()||null,vaccinations_due:$('vaccinations_due').value.trim()||null,next_visit_date:$('next_visit_date').value||null,original_note:$('note').value.trim(),confirmed:$('confirmed').checked};}
function fillRecord(r){$('beneficiary_id').value=r.beneficiary_id||"";$('visit_type').value=r.visit_type||"";$('weight_kg').value=r.weight_kg??"";$('vaccination_status').value=r.vaccination_status||"";$('vaccinations_due').value=r.vaccinations_due||"";$('next_visit_date').value=r.next_visit_date||"";$('confirmed').checked=false;$('saveBtn').disabled=true;}
function renderTranscript(){const raw=[finalTranscript,partialTranscript].filter(Boolean).join(finalTranscript&&partialTranscript?" ":"");$('note').value=normalizeSpokenNumbers(raw);$('note').scrollTop=$('note').scrollHeight;}
function appendTranscript(text){if(!text)return;partialTranscript="";finalTranscript+=(finalTranscript?" ":"")+text;renderTranscript();status("Gnani transcript received. Check names, dates and numbers.");checkDangerLive(text);}
function showPartialTranscript(text){partialTranscript=text||"";renderTranscript();if(partialTranscript)status("Listening… live words appearing");}
function checkDangerLive(text){
  const accumulated=(finalTranscript+" "+text).toLowerCase();
  fetch("/api/validate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note:accumulated})})
    .then(r=>r.json()).then(d=>{
      const matches=d.danger_matches||[];
      if(!dangerAlreadySpoken&&matches.length){dangerAlreadySpoken=true;$('dangerBox').classList.remove("hidden");$('dangerBox').textContent="⚠ DANGER SIGN — Immediate PHC referral: "+matches.map(x=>x.label).join(", ")+". Rule-list match only; no diagnosis or treatment advice.";speak(matches.map(x=>x.referral_message).join(" "));}
    }).catch(()=>{});
}

async function speak(text){status("Speaking read-back / alert…");try{const resp=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,language:$('language').value,voice:$('ttsVoice').value})});if(!resp.ok)throw new Error((await resp.json()).detail||"Gnani TTS unavailable");const data=await resp.json();const audio=new Audio('data:'+data.mime+';base64,'+data.audio_base64);await audio.play();status("Voice message played using Gnani Timbre.");}catch(e){console.warn(e);if('speechSynthesis'in window){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang=$('language').value;speechSynthesis.speak(u);status("Browser voice fallback: "+e.message);}else status("Speech unavailable: "+e.message);}}
function readForm(){const r=getRecord();const lines=[`Beneficiary ID ${r.beneficiary_id||"not captured"}.`,`Visit type ${r.visit_type||"not captured"}.`,`Weight ${r.weight_kg===null?"not captured":r.weight_kg+" kilograms"}.`,`Vaccination status ${r.vaccination_status||"not specified"}.`,`Vaccinations due or mentioned ${r.vaccinations_due||"not specified"}.`,`Next visit date ${r.next_visit_date||"not captured"}.`,`Please say correct, or tell me what to change.`];return lines.join(" ");}
function pcm16FromFloat(input,srcRate,targetRate=16000){let outLen=Math.floor(input.length*targetRate/srcRate),out=new Int16Array(outLen);for(let i=0;i<outLen;i++){const start=Math.floor(i*srcRate/targetRate),end=Math.max(start+1,Math.floor((i+1)*srcRate/targetRate));let sum=0,n=0;for(let j=start;j<Math.min(end,input.length);j++){sum+=input[j];n++;}let s=n?sum/n:input[Math.min(start,input.length-1)];s=Math.max(-1,Math.min(1,s));out[i]=s<0?s*32768:s*32767;}return out;}
function sendPcmFrames(floatData,rate){
 const converted=pcm16FromFloat(floatData,rate);
 for(let i=0;i<converted.length;i++)pcmBuffer.push(converted[i]);
 while(pcmBuffer.length>=512){
  const frame=pcmBuffer.splice(0,512),bytes=new Uint8Array(1024),view=new DataView(bytes.buffer);
  for(let i=0;i<frame.length;i++)view.setInt16(i*2,frame[i],true);
  if(ws?.readyState===WebSocket.OPEN)ws.send(bytes);
 }
}
function flushPcmFrames(){
 if(!pcmBuffer.length||ws?.readyState!==WebSocket.OPEN){pcmBuffer=[];return;}
 const frame=pcmBuffer.splice(0),bytes=new Uint8Array(frame.length*2),view=new DataView(bytes.buffer);
 for(let i=0;i<frame.length;i++)view.setInt16(i*2,frame[i],true);
 ws.send(bytes);
}
async function openGnaniStream(lang){
 const proto=location.protocol==='https:'?'wss':'ws';
 ws=new WebSocket(`${proto}://${location.host}/ws/gnani-stt?language=${encodeURIComponent(lang)}`);
 ws.binaryType='arraybuffer';
 await new Promise((resolve,reject)=>{
  let settled=false;
  const timer=setTimeout(()=>finish(new Error("Gnani handshake timed out")),8000);
  function finish(err){if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve();}
  ws.onerror=()=>finish(new Error("WebSocket connection failed"));
  ws.onclose=()=>{if(!settled)finish(new Error("Gnani WebSocket closed before it was ready"));};
  ws.onmessage=e=>{
   if(typeof e.data!=='string')return;
   let d;try{d=JSON.parse(e.data);}catch(err){console.warn("Ignored invalid Gnani message",err);return;}
   if(d.type==='ready'){status("Connected to Gnani Prisma. Speak now.");finish();}
   else if(d.type==='partial_transcript'||(d.type==='transcript'&&d.is_final===false)){showPartialTranscript(d.text);}
   else if(d.type==='transcript'){if(correctionMode)applyCorrection(d.text);else appendTranscript(d.text);}
   else if(d.type==='processing')status("Gnani is processing the speech segment…");
   else if(d.type==='stream_done'){
    status("Final transcript received. Extracting details…");
    if(!correctionMode && $('note').value.trim()) extract();
}
   else if(d.type==='error')status("Gnani error: "+(d.message||"Unknown error"));
  };
 });
}
async function startCapture(isCorrection=false){
 correctionMode=isCorrection;
 finalTranscript="";partialTranscript="";$('note').value="";
 if(!isCorrection)dangerAlreadySpoken=false;
 pcmBuffer=[];$('startBtn').disabled=true;$('stopBtn').disabled=false;status("Requesting microphone…");
 try{
  const audioOptions={echoCancellation:{ideal:true},noiseSuppression:{ideal:true},autoGainControl:{ideal:true},channelCount:{ideal:1}};
  try{stream=await navigator.mediaDevices.getUserMedia({audio:audioOptions});}
  catch(firstError){console.warn("Preferred microphone constraints unavailable; retrying basic audio.",firstError);stream=await navigator.mediaDevices.getUserMedia({audio:true});}
  // Establish the socket before processing audio to avoid losing the first spoken words.
  await openGnaniStream($('language').value||'indic-auto');
  ctx=new AudioContext({latencyHint:"interactive"});
  if(ctx.state==='suspended')await ctx.resume();
  source=ctx.createMediaStreamSource(stream);
  processor=ctx.createScriptProcessor(1024,1,1);
  muteNode=ctx.createGain();muteNode.gain.value=0;
  processor.onaudioprocess=e=>{if(captureActive)sendPcmFrames(e.inputBuffer.getChannelData(0),ctx.sampleRate);};
  source.connect(processor);processor.connect(muteNode);muteNode.connect(ctx.destination);
  captureActive=true;
  const settings=stream.getAudioTracks()[0]?.getSettings?.()||{};
  const applied=[settings.noiseSuppression===true?"noise suppression":"",settings.echoCancellation===true?"echo cancellation":"",settings.autoGainControl===true?"auto gain":""].filter(Boolean);
  status((isCorrection?"Correction listening. ":"Live capture started. ")+(applied.length?"Enabled: "+applied.join(", ")+". ":"Microphone active; browser audio enhancements may vary. ")+"Speak naturally.");
 }catch(err){status("Unable to start Gnani streaming: "+err.message);stopCapture();}
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
        ctx.close();
        ctx = null;
    }

    const socket = ws;

    if (socket && socket.readyState === WebSocket.OPEN) {
        try {
            flushPcmFrames();
            socket.send(JSON.stringify({ type: "stop" }));

            setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }
            }, 1500);

        } catch (e) {
            console.warn("Could not finish audio stream:", e);
        }
    }

    ws = null;

    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;

    status("Finishing speech recognition. Waiting for final words...");
}
function applyCorrection(text){
 const t=text.toLowerCase();let m=t.match(/(?:weight|ತೂಕ|वजन)[^\d]*(\d+(?:\.\d+)?)/i)||t.match(/(\d+(?:\.\d+)?)\s*(?:kilo|kg|ಕಿಲೋ|किलो)/i);
 if(m){$('weight_kg').value=m[1];$('confirmed').checked=false;$('saveBtn').disabled=true;speak(`Weight updated to ${m[1]} kilograms. ${readForm()}`);return;}
 m=t.match(/(?:beneficiary\s*id|beneficiary|id)[^a-z0-9]*([a-z0-9-]+)/i);if(m){$('beneficiary_id').value=m[1];$('confirmed').checked=false;$('saveBtn').disabled=true;speak(`Beneficiary ID updated to ${m[1]}. ${readForm()}`);return;}
 if(t.includes("anc")||t.includes("antenatal"))$('visit_type').value="ANC";else if(t.includes("pnc"))$('visit_type').value="PNC";else if(t.includes("newborn"))$('visit_type').value="Newborn";else if(t.includes("immun"))$('visit_type').value="Immunisation";
 else if(t.includes("tt")||t.includes("ifa")||t.includes("vaccine"))$('vaccinations_due').value=text;
 else if(/\b(save|yes|correct|confirm)\b/.test(t)){ $('confirmed').checked=true;saveVisit();return;}
 else if(/\b(no|wrong|change|correction)\b/.test(t)){speak("Please say the field and its correct value. For example, weight 2.8 kilo.");return;}
 else{const dm=t.match(/(?:next visit|date|visit)[^0-9]*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);if(dm){$('next_visit_date').value=`${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;}else{speak("I did not understand the correction. Please repeat the field and correct value.");return;}}
 $('confirmed').checked=false;$('saveBtn').disabled=true;speak("Correction received. "+readForm());
}

async function extract(){const note=normalizeSpokenNumbers($('note').value.trim());$('note').value=note;if(!note){status("No transcript yet.");return;}try{const res=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note,beneficiary_id:$('beneficiary_id').value.trim()||null})});const d=await res.json();if(!res.ok)throw Error(d.detail||"Extraction failed");fillRecord(d.record);if(d.danger_matches?.length){$('dangerBox').classList.remove('hidden');$('dangerBox').textContent="⚠ DANGER SIGN — "+d.danger_matches.map(x=>x.label+"; "+x.referral_message).join(" | ");speak(d.danger_matches.map(x=>x.referral_message).join(" "));}else{$('dangerBox').classList.add('hidden');}speak(readForm());}catch(e){status("Extract error: "+e.message);}}
async function saveVisit(){const r=getRecord();if(!r.beneficiary_id){status("Beneficiary ID is required. Correct by voice.");await speak("Beneficiary ID is missing. Please tell me the beneficiary ID.");return;}if(!r.confirmed){status("Please confirm the read-back first.");return;}try{const res=await fetch('/api/visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record:r})});const d=await res.json();if(!res.ok)throw Error(d.detail||"Save failed");$('saveStatus').textContent=`Saved visit ${d.visit_id}. Danger flag: ${d.danger_flag?"YES":"No"}`;await speak("Visit saved. I will now read your follow-up tasks.");await loadAllData();}catch(e){$('saveStatus').textContent="Save error: "+e.message;}}
async function loadFollowups(){
  const res=await fetch('/api/followups');
  if(!res.ok) throw new Error(`Follow-ups API: HTTP ${res.status}`);
  const d=await res.json(), items=Array.isArray(d.items)?d.items:[];
  $('followups').innerHTML=items.length?items.map(x=>`<div class="followup"><span>${esc(x.beneficiary_id)} · ${esc(x.task_description)} · ${esc(x.due_date||"date not set")}</span><strong class="${x.priority==='urgent'?'urgent':'normal'}">${esc(x.priority||'normal')}</strong></div>`).join(""):`<div class="empty">No follow-ups.</div>`;
  return items;
}
async function loadDashboard(){
  const res=await fetch('/api/visits');
  if(!res.ok) throw new Error(`Visits API: HTTP ${res.status}`);
  const d=await res.json(), visits=Array.isArray(d.items)?d.items:[];
  const followRes=await fetch('/api/followups');
  if(!followRes.ok) throw new Error(`Follow-ups API: HTTP ${followRes.status}`);
  const fd=await followRes.json(), tasks=Array.isArray(fd.items)?fd.items:[];
  const uniqueBeneficiaries=new Set(visits.map(v=>v.beneficiary_id).filter(Boolean));
  $('statBeneficiaries').textContent=uniqueBeneficiaries.size;
  $('statVisits').textContent=visits.length;
  $('statFollowups').textContent=tasks.filter(x=>(x.status||'pending').toLowerCase()==='pending').length;
  $('statDanger').textContent=visits.filter(v=>Boolean(v.danger_flag)).length;
  $('visitRows').innerHTML=visits.length?visits.slice(0,10).map(v=>`<tr>
    <td>${esc(v.beneficiary_id||'—')}</td><td>${esc(v.visit_type||'—')}</td>
    <td>${v.weight_kg==null?'—':esc(v.weight_kg)}</td>
    <td>${esc(v.vaccination_status||'Not specified')}</td>
    <td>${esc(v.next_visit_date||'—')}</td><td>${esc(v.created_at||'—')}</td>
  </tr>`).join(''):`<tr><td colspan="6" class="table-empty">No saved visits yet.</td></tr>`;
  $('dashboardStatus').textContent=`Loaded ${visits.length} saved visit(s) from SQLite.`;
}
async function loadAllData(){
  try{
    const results=await Promise.allSettled([loadFollowups(),loadDashboard()]);
    if(results.some(x=>x.status==='rejected')){
      const err=results.find(x=>x.status==='rejected').reason;
      $('dashboardStatus').textContent='Could not load all database data: '+err.message;
    }
  }catch(e){$('dashboardStatus').textContent='Dashboard error: '+e.message;}
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
$('startBtn').onclick=()=>startCapture(false);$('stopBtn').onclick=stopCapture;$('extractBtn').onclick=extract;$('readBtn').onclick=()=>speak(readForm());$('correctionBtn').onclick=()=>startCapture(true);$('saveBtn').onclick=saveVisit;$('refreshBtn').onclick=loadAllData;$('confirmed').onchange=()=>{$('saveBtn').disabled=!$('confirmed').checked;};$('note').oninput=()=>{finalTranscript=$('note').value;partialTranscript='';};
fetch('/api/health').then(r=>r.json()).then(d=>{$('apiStatus').textContent=d.gnani_configured?"Backend ready · Gnani key configured":"Backend ready · Add Gnani API key";}).catch(()=>{$('apiStatus').textContent="Backend unavailable";});loadAllData();


// Dashboard additions: these elements are created here so index.html can remain unchanged.
(function addDashboard(){
  const beneficiaryInput=$('beneficiary_id');
  if(beneficiaryInput) beneficiaryInput.readOnly=false;

  const hero=document.querySelector('.hero');
  if(!hero || $('liveDashboard')) return;
  const panel=document.createElement('section');
  panel.className='panel';
  panel.id='liveDashboard';
  panel.innerHTML=`
    <div class="section-title">
      <div><p class="eyebrow">LIVE DATABASE</p><h2>Beneficiary dashboard</h2></div>
      <button id="dashboardRefreshBtn" class="small" type="button">Refresh dashboard</button>
    </div>
    <div class="dashboard-cards">
      <article class="dashboard-card"><span>Total beneficiaries</span><strong id="statBeneficiaries">—</strong></article>
      <article class="dashboard-card"><span>Saved visits</span><strong id="statVisits">—</strong></article>
      <article class="dashboard-card"><span>Pending follow-ups</span><strong id="statFollowups">—</strong></article>
      <article class="dashboard-card"><span>Danger-flagged visits</span><strong id="statDanger">—</strong></article>
    </div>
    <h3 class="subheading">Recent saved visits</h3>
    <div class="table-wrap"><table class="records-table">
      <thead><tr><th>Beneficiary ID</th><th>Visit type</th><th>Weight (kg)</th><th>Vaccination</th><th>Next visit</th><th>Saved</th></tr></thead>
      <tbody id="visitRows"><tr><td colspan="6" class="table-empty">Loading records…</td></tr></tbody>
    </table></div>
    <p id="dashboardStatus" class="hint" aria-live="polite">Loading database records…</p>`;
  hero.insertAdjacentElement('afterend',panel);

  const style=document.createElement('style');
  style.textContent=`
    .dashboard-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .dashboard-card{background:#f2f8f5;border:1px solid #e1ebe6;border-radius:13px;padding:16px}
    .dashboard-card span{display:block;color:#61746e;font-size:.82rem}
    .dashboard-card strong{display:block;font-size:1.8rem;margin-top:7px;color:#176b53}
    .subheading{font-size:1rem;margin:24px 0 10px}
    .table-wrap{overflow-x:auto}.records-table{width:100%;border-collapse:collapse;font-size:.88rem}
    .records-table th,.records-table td{text-align:left;padding:11px 10px;border-bottom:1px solid #e8efeb;white-space:nowrap}
    .records-table th{color:#61746e;background:#f7faf8}.table-empty{text-align:center!important;color:#71817b;padding:20px!important}
    @media(max-width:650px){.dashboard-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  document.head.appendChild(style);
})();

if($('dashboardRefreshBtn')) $('dashboardRefreshBtn').onclick=loadAllData;
['beneficiary_id','visit_type','weight_kg','vaccination_status','vaccinations_due','next_visit_date'].forEach(id=>{
  const el=$(id);
  if(el){
    el.addEventListener('input',()=>{$('confirmed').checked=false;$('saveBtn').disabled=true;});
    el.addEventListener('change',()=>{$('confirmed').checked=false;$('saveBtn').disabled=true;});
  }
});
