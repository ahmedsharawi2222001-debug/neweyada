/* ---------------- state ---------------- */
let DB = { services: [], patients: [], bookings: [], settings: { clinicName:'عيادة الابتسامة', clinicPhone:'', webhookUrl:'', bookingsUrl:'' } };
let syncTimer = null;
let currentPatientId = null;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const p2 = n => String(n).padStart(2,'0');

// تاريخ اليوم بالتوقيت المحلي (toISOString بيرجّع UTC وده بيغلّط اليوم بعد 12 بالليل في مصر)
const todayStr = () => {
  const d = new Date();
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
};

/* ---------------- normalizers (بيانات n8n / جوجل شيت) ---------------- */
const toLatin = s => (s??'').toString().replace(/[٠-٩]/g, d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));

// توحيد حالة الحجز (عربي/إنجليزي) لواحدة من: confirmed / done / cancelled
function normStatus(s){
  s = (s||'').toString().trim().toLowerCase();
  if(['done','completed','تم','مكتمل'].includes(s)) return 'done';
  if(['cancelled','canceled','ملغي','ملغى','إلغاء','الغاء'].includes(s)) return 'cancelled';
  return 'confirmed';
}
// التاريخ → YYYY-MM-DD (بيقبل 29/10/2026 و 2026-10-29T18:30:00)
function normDate(d){
  d = toLatin(d).trim();
  if(!d) return '';
  let m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return m[1]+'-'+p2(m[2])+'-'+p2(m[3]);
  m = d.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if(m) return m[3]+'-'+p2(m[2])+'-'+p2(m[1]);
  return d;
}
// الوقت → HH:MM (بيقبل 6:30 PM و 18:30:00)
function normTime(t){
  t = toLatin(t).trim();
  if(!t) return '';
  const m = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?/i);
  if(!m) return t;
  let h = +m[1]; const ap = (m[3]||'').toLowerCase();
  if((ap==='pm'||ap==='م') && h<12) h+=12;
  if((ap==='am'||ap==='ص') && h===12) h=0;
  return p2(h)+':'+m[2];
}
// توحيد صيغة الرقم عشان نفس المريض ميتكررش (+20 / 0020 / 20 / 0)
function normPhone(p){
  let d = toLatin(p).replace(/\D/g,'');
  if(d.startsWith('0020')) d = '0'+d.slice(4);
  else if(d.startsWith('20') && d.length===12) d = '0'+d.slice(2);
  else if(d.length===10 && d.startsWith('1')) d = '0'+d;
  return d;
}
const pick = (r, keys) => { for(const k of keys){ if(r[k]!==undefined && r[k]!==null && r[k]!=='') return r[k]; } return ''; };

// صف جاي من n8n/الشيت → شكل موحد (بيقبل أسماء أعمدة مختلفة)
function readRow(r){
  if(r && r.json && typeof r.json==='object') r = r.json; // شكل items بتاع n8n
  return {
    id: pick(r,['id','bookingId','booking_id']),
    patientName: String(pick(r,['patientName','patient_name','name','الاسم','اسم المريض'])).trim(),
    phone: String(pick(r,['phone','patientPhone','patient_phone','mobile','رقم الهاتف','الهاتف','رقم التليفون','التليفون'])).trim(),
    serviceName: String(pick(r,['serviceName','service_name','service','الخدمة'])).trim(),
    serviceId: pick(r,['serviceId','service_id']),
    date: normDate(pick(r,['date','التاريخ','bookingDate'])),
    time: normTime(pick(r,['time','الوقت','bookingTime'])),
    status: pick(r,['status','الحالة']),
    notes: String(pick(r,['notes','note','ملاحظات'])).trim()
  };
}

/* ---------------- storage ---------------- */
function ensureShape(){
  if(!DB.services) DB.services=[];
  if(!DB.patients) DB.patients=[];
  if(!DB.bookings) DB.bookings=[];
  if(!DB.settings) DB.settings={};
  if(DB.settings.clinicName===undefined) DB.settings.clinicName='عيادة الابتسامة';
  if(DB.settings.clinicPhone===undefined) DB.settings.clinicPhone='';
  if(DB.settings.webhookUrl===undefined) DB.settings.webhookUrl='';
  if(DB.settings.bookingsUrl===undefined) DB.settings.bookingsUrl='';
}

async function loadDB(){
  try{
    const raw = localStorage.getItem('clinic-db');
    if(raw){ DB = JSON.parse(raw); }
  }catch(e){ /* first run, no data yet */ }
  ensureShape();

  if(DB.services.length===0){
    DB.services = [
      {id:uid(), name:'كشف وتنظيف أسنان', desc:'كشف عام وتنظيف الجير والتلميع', price:300, duration:30},
      {id:uid(), name:'حشو أسنان', desc:'حشو تجميلي أبيض للأسنان المصابة بالتسوس', price:450, duration:40},
      {id:uid(), name:'تبييض أسنان', desc:'جلسة تبييض بالليزر أو الكاسات المنزلية', price:1500, duration:60},
      {id:uid(), name:'تقويم أسنان (استشارة)', desc:'كشف وتقييم أولي لحالة التقويم', price:250, duration:30},
    ];
    await saveDB();
  }
}

async function saveDB(){
  try{
    localStorage.setItem('clinic-db', JSON.stringify(DB));
  }catch(e){
    console.error('storage error', e);
    showToast('حصل خطأ في حفظ البيانات');
  }
}

/* ---------------- tabs ---------------- */
document.getElementById('tabs').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-tab]');
  if(!btn) return;
  switchTab(btn.dataset.tab);
});
function switchTab(tab){
  document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+tab).classList.add('active');
  render();
}

/* ---------------- toast ---------------- */
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* ---------------- n8n: إرسال (Webhook) ---------------- */
// بيبعت تغيير حالة الحجز (تم / إلغاء) لـ n8n. ملاحظات الدكتور والبيانات الطبية مش بتتبعت.
async function sendWebhook(payload){
  const url = (DB.settings.webhookUrl||'').trim();
  if(!url) return {sent:false, reason:'no-url'};
  try{
    await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    return {sent:true};
  }catch(e){
    console.error('webhook error', e);
    return {sent:false, reason:e.message};
  }
}

/* ---------------- n8n: استقبال الحجوزات ---------------- */
// المصدر: رابط n8n (GET) لو مكتوب في الإعدادات، وإلا ملف bookings.json في نفس مجلد الموقع
const BOOKINGS_JSON_PATH = 'bookings.json';

function bookingsSourceUrl(){
  const u = (DB.settings.bookingsUrl||'').trim() || BOOKINGS_JSON_PATH;
  // t=Date.now() عشان نمنع كاش المتصفح
  return u + (u.includes('?')?'&':'?') + 't=' + Date.now();
}

async function fetchBookingsFromSheet(silent){
  try{
    const res = await fetch(bookingsSourceUrl());
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    // array مباشرة، أو object فيه bookings/data، أو object واحد (حجز واحد)
    let rows = Array.isArray(data) ? data : (data.bookings || data.data || (data.patientName||data.name ? [data] : []));
    if(!Array.isArray(rows)) rows = [];
    mergeBookingsFromSheet(rows);
    mergeDuplicatePatients();
    await saveDB();
    render();
    if(!silent) showToast('تم تحديث الحجوزات ✓');
    return {ok:true, count: rows.length};
  }catch(e){
    console.error('sync error', e);
    if(!silent) showToast('فشل تحديث الحجوزات — راجع رابط n8n أو ملف bookings.json');
    return {ok:false, reason:e.message};
  }
}

/* ---------------- ملف المريض (بالرقم) ---------------- */
// بيدور على ملف المريض بالرقم (أو الاسم لو مفيش رقم)، ولو مش موجود بيفتح ملف جديد تلقائيًا
function findPatientByPhone(phone, exceptId){
  const np = normPhone(phone);
  if(!np) return null;
  return DB.patients.find(x=>x.id!==exceptId && normPhone(x.phone)===np) || null;
}

function ensurePatient(name, phone, auto){
  name = (name||'').trim();
  const np = normPhone(phone);
  if(!name && !np) return null;
  let p = np ? findPatientByPhone(phone)
             : DB.patients.find(x=>x.name===name && !normPhone(x.phone));
  if(p){
    if((!p.name || p.name==='مريض بدون اسم') && name) p.name = name;
    if(!p.phone && phone) p.phone = phone;
    return p;
  }
  p = { id: uid(), name: name || 'مريض بدون اسم', phone: phone||'', age:'', address:'', history:'', alerts:'', plan:'',
        auto: !!auto, createdAt: new Date().toISOString() };
  DB.patients.push(p);
  return p;
}

// يدمج أي ملفين لنفس الرقم في ملف واحد (بيحافظ على كل البيانات والحجوزات)
function mergeDuplicatePatients(){
  const byPhone = {};
  const remove = new Set();
  DB.patients.forEach(p=>{
    const np = normPhone(p.phone);
    if(!np) return;
    const keep = byPhone[np];
    if(!keep){ byPhone[np] = p; return; }
    ['age','address'].forEach(k=>{ if(!keep[k] && p[k]) keep[k] = p[k]; });
    ['history','alerts','plan'].forEach(k=>{
      if(!keep[k] && p[k]) keep[k] = p[k];
      else if(keep[k] && p[k] && keep[k]!==p[k]) keep[k] = keep[k]+'\n'+p[k];
    });
    if(keep.auto && !p.auto){ keep.auto = false; if(p.name) keep.name = p.name; }
    if(p.createdAt && (!keep.createdAt || p.createdAt<keep.createdAt)) keep.createdAt = p.createdAt;
    DB.bookings.forEach(b=>{ if(b.patientId===p.id) b.patientId = keep.id; });
    remove.add(p.id);
  });
  if(remove.size) DB.patients = DB.patients.filter(p=>!remove.has(p.id));
  return remove.size>0;
}

// يربط أي حجوزات مالهاش ملف مريض
function linkOrphanBookings(){
  let changed = false;
  DB.bookings.forEach(b=>{
    if(!DB.patients.find(p=>p.id===b.patientId)){
      const p = ensurePatient(b.patientName, b.phone, true);
      if(p){ b.patientId = p.id; changed = true; }
    }
  });
  return changed;
}

// بيدمج الصفوف الجايه من n8n/الشيت مع الحجوزات المحلية من غير تكرار (وبيحافظ على ملاحظات الدكتور)
function mergeBookingsFromSheet(rawRows){
  rawRows.forEach(raw=>{
    const row = readRow(raw);
    if(!row.patientName && !row.phone && !row.date && !row.time) return; // تجاهل صفوف فاضية
    const sheetId = row.id ? String(row.id) : null;
    const rowNp = normPhone(row.phone);
    const sameSlot = b => b.date===row.date && b.time===row.time &&
      (rowNp && normPhone(b.phone) ? normPhone(b.phone)===rowNp : b.patientName===row.patientName);
    const existing = DB.bookings.find(b => sheetId ? b.sheetId===sheetId : sameSlot(b))
                  || (sheetId ? DB.bookings.find(b=>!b.sheetId && sameSlot(b)) : null);

    // افتح ملف مريض تلقائيًا (أو اربط الحجز بالملف الموجود بنفس الرقم)
    const patient = ensurePatient(row.patientName, row.phone, true);
    const booking = {
      ...(existing || {}),
      id: existing ? existing.id : uid(),
      sheetId: sheetId || (existing && existing.sheetId) || null,
      patientId: patient ? patient.id : (existing ? existing.patientId : uid()),
      patientName: row.patientName || (patient ? patient.name : ''),
      phone: row.phone,
      serviceId: existing ? existing.serviceId : (row.serviceId || ''),
      serviceName: row.serviceName,
      date: row.date,
      time: row.time,
      status: row.status ? normStatus(row.status) : (existing ? existing.status : 'confirmed'),
      notes: row.notes || (existing ? existing.notes : '') || ''
    };
    if(existing){
      DB.bookings = DB.bookings.map(b=> b.id===existing.id ? booking : b);
    } else {
      DB.bookings.push(booking);
    }
  });
}

// تشغيل/إيقاف المزامنة الدورية
function startAutoSync(){
  stopAutoSync();
  fetchBookingsFromSheet(true); // أول تحديث فورًا لما الموقع يفتح
  syncTimer = setInterval(()=>fetchBookingsFromSheet(true), 30000); // كل 30 ثانية
}
function stopAutoSync(){
  if(syncTimer){ clearInterval(syncTimer); syncTimer=null; }
}

/* ---------------- helpers: إحصائيات المريض ---------------- */
function patientStats(p){
  const t = todayStr();
  const visits = DB.bookings.filter(b=>b.patientId===p.id)
    .sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  const done = visits.filter(v=>v.status==='done');
  const upcoming = visits.filter(v=>v.status==='confirmed' && v.date>=t)
    .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  return { visits, doneCount: done.length, last: done[0]||null, next: upcoming[0]||null };
}

/* ---------------- render: home ---------------- */
function render(){
  renderHome();
  renderServices();
  renderBookings();
  renderPatients();
  renderSettings();
}

function renderHome(){
  const d = new Date();
  const days=['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  document.getElementById('heroDate').textContent = `أهلًا بيك يا دكتور، النهارده ${days[d.getDay()]} ${d.toLocaleDateString('ar-EG')}`;

  const t = todayStr();
  const todayBookings = DB.bookings.filter(b=>b.date===t).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
  document.getElementById('statToday').textContent = todayBookings.length;
  document.getElementById('statPatients').textContent = DB.patients.length;
  document.getElementById('statServices').textContent = DB.services.length;
  const curMonth = t.slice(0,7);
  document.getElementById('statMonth').textContent = DB.bookings.filter(b=>(b.date||'').startsWith(curMonth)).length;
  document.getElementById('todayCount').textContent = todayBookings.length;

  // smile arc
  const arc = document.getElementById('smileArc');
  arc.innerHTML='';
  const slots = todayBookings.length ? todayBookings.slice(0,9) : [];
  const n = Math.max(slots.length, 5);
  for(let i=0;i<n;i++){
    const dot = document.createElement('div');
    dot.className='tooth-dot'+(slots[i]?'':' empty');
    const mid=(n-1)/2;
    const offset = Math.round(Math.pow(Math.abs(i-mid),1.6)*3);
    dot.style.marginBottom = offset+'px';
    dot.textContent = slots[i] ? (slots[i].time||'').slice(0,5) : '🦷';
    if(slots[i]) dot.title = slots[i].patientName;
    arc.appendChild(dot);
  }

  const list = document.getElementById('todayBookingsList');
  if(todayBookings.length===0){
    list.innerHTML = `<div class="card empty-state"><div class="big">🗓️</div>مفيش حجوزات النهارده لسه.<br>الحجوزات الجديدة بتوصل تلقائيًا من فورم الحجز عن طريق n8n.</div>`;
  } else {
    list.innerHTML = bookingsTableHTML(todayBookings);
  }
}

/* ---------------- render: services ---------------- */
function renderServices(){
  const q = (document.getElementById('serviceSearch').value||'').trim();
  const items = DB.services.filter(s=>s.name.includes(q));
  document.getElementById('servicesCount').textContent = DB.services.length;
  const grid = document.getElementById('servicesGrid');
  if(items.length===0){
    grid.innerHTML = `<div class="card empty-state" style="grid-column:1/-1"><div class="big">🦷</div>مفيش خدمات مطابقة.</div>`;
    return;
  }
  grid.innerHTML = items.map(s=>`
    <div class="service-card">
      <h3>${esc(s.name)}</h3>
      <div class="price">${s.price} جنيه</div>
      <div class="desc">${esc(s.desc||'')}</div>
      <div class="meta">⏱ ${s.duration||0} دقيقة</div>
      <div class="row">
        <button class="btn btn-outline btn-sm" onclick="openServiceModal('${s.id}')">تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteService('${s.id}')">حذف</button>
      </div>
    </div>`).join('');
}
document.getElementById('serviceSearch').addEventListener('input', renderServices);

function openServiceModal(id){
  document.getElementById('serviceId').value = id||'';
  const s = DB.services.find(x=>x.id===id);
  document.getElementById('serviceModalTitle').textContent = s?'تعديل الخدمة':'إضافة خدمة';
  document.getElementById('serviceName').value = s?s.name:'';
  document.getElementById('serviceDesc').value = s?s.desc:'';
  document.getElementById('servicePrice').value = s?s.price:'';
  document.getElementById('serviceDuration').value = s?s.duration:'';
  openModal('modalService');
}
async function saveService(){
  const id = document.getElementById('serviceId').value;
  const name = document.getElementById('serviceName').value.trim();
  if(!name){ showToast('اكتب اسم الخدمة'); return; }
  const obj = {
    id: id||uid(),
    name,
    desc: document.getElementById('serviceDesc').value.trim(),
    price: Number(document.getElementById('servicePrice').value)||0,
    duration: Number(document.getElementById('serviceDuration').value)||0,
  };
  if(id){ DB.services = DB.services.map(s=>s.id===id?obj:s); }
  else DB.services.push(obj);
  await saveDB();
  closeModal('modalService');
  render();
  showToast('تم حفظ الخدمة');
}
async function deleteService(id){
  if(!confirm('تأكيد حذف الخدمة؟')) return;
  DB.services = DB.services.filter(s=>s.id!==id);
  await saveDB();
  render();
  showToast('تم الحذف');
}

/* ---------------- render: bookings (للعرض والمتابعة فقط — الحجز بيتم من فورم n8n) ---------------- */
function bookingsTableHTML(list){
  if(list.length===0) return `<div class="card empty-state">مفيش حجوزات.</div>`;
  const statusLabel = {confirmed:'مؤكد',done:'تم',cancelled:'ملغي'};
  return `<div class="table-wrap"><table><thead><tr>
    <th>المريض</th><th>الهاتف</th><th>الخدمة</th><th>التاريخ</th><th>الوقت</th><th>الحالة</th><th></th>
  </tr></thead><tbody>
  ${list.map(b=>`
    <tr>
      <td>${esc(b.patientName)}</td>
      <td dir="ltr" style="text-align:right">${esc(b.phone||'')}</td>
      <td>${esc(b.serviceName)}</td>
      <td>${esc(b.date)}</td>
      <td>${esc(b.time)}</td>
      <td><span class="pill pill-${esc(b.status)}">${statusLabel[b.status]||esc(b.status)}</span></td>
      <td>
        <div class="row-actions">
          ${b.status==='confirmed'?`<button class="btn btn-outline btn-sm" onclick="setBookingStatus('${b.id}','done')">تم</button>
          <button class="btn btn-danger btn-sm" onclick="setBookingStatus('${b.id}','cancelled')">إلغاء</button>`:''}
          <button class="btn btn-outline btn-sm" onclick="openVisitModal('${b.id}')">${(b.diagnosis||b.treatment||b.doctorNotes)?'📝 ملاحظات الدكتور':'+ ملاحظات'}</button>
          <button class="btn btn-outline btn-sm" onclick="viewPatient('${b.patientId}')">الملف</button>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderBookings(){
  const filterDate = document.getElementById('bookingDateFilter').value;
  let list = [...DB.bookings].sort((a,b)=> ((a.date||'')+(a.time||'')).localeCompare((b.date||'')+(b.time||'')));
  if(filterDate) list = list.filter(b=>b.date===filterDate);
  document.getElementById('bookingsCount').textContent = DB.bookings.length;
  document.getElementById('bookingsTableWrap').innerHTML = bookingsTableHTML(list);
}
document.getElementById('bookingDateFilter').addEventListener('change', renderBookings);
function clearDateFilter(){ document.getElementById('bookingDateFilter').value=''; renderBookings(); }

async function setBookingStatus(id, status){
  const b = DB.bookings.find(x=>x.id===id);
  if(!b) return;
  b.status = status;
  await saveDB();
  render();
  refreshPatientDetail();
  // لـ n8n بنبعت بيانات الحجز الأساسية بس (من غير ملاحظات الدكتور)
  const payload = {
    event: status==='cancelled'?'booking_cancelled':'booking_updated',
    id: b.sheetId || b.id, patientName: b.patientName, phone: b.phone,
    serviceName: b.serviceName, date: b.date, time: b.time, status: b.status,
    clinic: DB.settings.clinicName
  };
  sendWebhook(payload);
  showToast(status==='done'?'تم تحديد الحجز كمكتمل':'تم إلغاء الحجز');
}

/* ---------------- ملاحظات الدكتور على الزيارة ---------------- */
function openVisitModal(id){
  const b = DB.bookings.find(x=>x.id===id);
  if(!b) return;
  document.getElementById('visitId').value = id;
  document.getElementById('visitTitle').textContent = `زيارة ${b.patientName||''} — ${b.date||''} ${b.time||''}`;
  document.getElementById('visitDiagnosis').value = b.diagnosis||'';
  document.getElementById('visitTreatment').value = b.treatment||'';
  document.getElementById('visitDoctorNotes').value = b.doctorNotes||'';
  openModal('modalVisit');
}
async function saveVisit(){
  const id = document.getElementById('visitId').value;
  const b = DB.bookings.find(x=>x.id===id);
  if(!b) return;
  b.diagnosis = document.getElementById('visitDiagnosis').value.trim();
  b.treatment = document.getElementById('visitTreatment').value.trim();
  b.doctorNotes = document.getElementById('visitDoctorNotes').value.trim();
  await saveDB();
  closeModal('modalVisit');
  render();
  refreshPatientDetail();
  showToast('تم حفظ ملاحظات الزيارة');
}

/* ---------------- render: patients ---------------- */
function renderPatients(){
  const q = (document.getElementById('patientSearch').value||'').trim();
  const qDigits = normPhone(q);
  const sort = document.getElementById('patientSort').value;
  const upcomingOnly = document.getElementById('patientUpcomingOnly').checked;

  let items = DB.patients.map(p=>({p, s: patientStats(p)})).filter(({p})=>{
    if(!q) return true;
    return (p.name||'').includes(q) || (qDigits && normPhone(p.phone).includes(qDigits)) || (p.phone||'').includes(q);
  });
  if(upcomingOnly) items = items.filter(x=>x.s.next);

  items.sort((a,b)=>{
    if(sort==='name') return (a.p.name||'').localeCompare(b.p.name||'', 'ar');
    if(sort==='next'){
      const an = a.s.next ? a.s.next.date+a.s.next.time : '9999';
      const bn = b.s.next ? b.s.next.date+b.s.next.time : '9999';
      return an.localeCompare(bn);
    }
    // الأحدث زيارة (أو أحدث حجز) الأول
    const al = a.s.visits[0] ? a.s.visits[0].date+a.s.visits[0].time : '';
    const bl = b.s.visits[0] ? b.s.visits[0].date+b.s.visits[0].time : '';
    return bl.localeCompare(al);
  });

  document.getElementById('patientsCount').textContent = DB.patients.length;
  const wrap = document.getElementById('patientsTableWrap');
  if(items.length===0){
    wrap.innerHTML = `<div class="card empty-state"><div class="big">🗂️</div>${DB.patients.length?'مفيش نتائج مطابقة.':'مفيش مرضى مسجلين لسه — ملفاتهم بتتفتح تلقائيًا مع أول حجز.'}</div>`;
    return;
  }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>الاسم</th><th>الهاتف</th><th>آخر زيارة</th><th>الميعاد القادم</th><th>الزيارات</th><th></th>
  </tr></thead><tbody>
  ${items.map(({p,s})=>`<tr>
      <td>${esc(p.name)}${p.alerts?' <span class="pill pill-alert" title="'+esc(p.alerts)+'">⚠ تنبيه طبي</span>':''}</td>
      <td dir="ltr" style="text-align:right">${esc(p.phone||'')}</td>
      <td>${s.last?esc(s.last.date):'—'}</td>
      <td>${s.next?esc(s.next.date+' '+s.next.time):'—'}</td>
      <td>${s.doneCount} / ${s.visits.length}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-teal btn-sm" onclick="viewPatient('${p.id}')">عرض الملف</button>
          <button class="btn btn-outline btn-sm" onclick="openPatientModal('${p.id}')">تعديل</button>
          <button class="btn btn-danger btn-sm" onclick="deletePatient('${p.id}')">حذف</button>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
document.getElementById('patientSearch').addEventListener('input', renderPatients);
document.getElementById('patientSort').addEventListener('change', renderPatients);
document.getElementById('patientUpcomingOnly').addEventListener('change', renderPatients);

function openPatientModal(id){
  document.getElementById('patientId').value = id||'';
  const p = DB.patients.find(x=>x.id===id);
  document.getElementById('patientModalTitle').textContent = p?'تعديل بيانات المريض':'إضافة مريض';
  document.getElementById('patientName').value = p?p.name:'';
  document.getElementById('patientAge').value = p?p.age:'';
  document.getElementById('patientPhone').value = p?p.phone:'';
  document.getElementById('patientAddress').value = p?p.address:'';
  document.getElementById('patientAlerts').value = p?(p.alerts||''):'';
  document.getElementById('patientHistory').value = p?p.history:'';
  document.getElementById('patientPlan').value = p?(p.plan||''):'';
  openModal('modalPatient');
}
async function savePatient(){
  const id = document.getElementById('patientId').value;
  const name = document.getElementById('patientName').value.trim();
  const phone = document.getElementById('patientPhone').value.trim();
  if(!name || !phone){ showToast('اكتب الاسم ورقم الهاتف'); return; }

  const fields = {
    name, phone,
    age: document.getElementById('patientAge').value,
    address: document.getElementById('patientAddress').value.trim(),
    alerts: document.getElementById('patientAlerts').value.trim(),
    history: document.getElementById('patientHistory').value.trim(),
    plan: document.getElementById('patientPlan').value.trim(),
  };

  // منع التكرار: نفس الرقم = نفس الملف
  const dup = findPatientByPhone(phone, id||undefined);
  if(dup){
    if(id){ showToast('الرقم ده مسجل لمريض تاني: '+dup.name); return; }
    Object.assign(dup, fields, { auto:false });
    await saveDB();
    closeModal('modalPatient');
    render();
    showToast('المريض مسجل بالفعل — اتحدّث ملفه');
    return;
  }

  if(id){
    DB.patients = DB.patients.map(p=>p.id===id ? {...p, ...fields, auto:false} : p);
    DB.bookings = DB.bookings.map(b=> b.patientId===id ? {...b, patientName:name, phone} : b);
  } else {
    DB.patients.push({ id: uid(), ...fields, auto:false, createdAt: new Date().toISOString() });
  }
  await saveDB();
  closeModal('modalPatient');
  render();
  refreshPatientDetail();
  showToast('تم حفظ بيانات المريض');
}
async function deletePatient(id){
  if(!confirm('تأكيد حذف ملف المريض وحجوزاته من اللوحة؟\n(لو الحجز لسه موجود في n8n أو bookings.json هيرجع تاني مع المزامنة)')) return;
  DB.patients = DB.patients.filter(p=>p.id!==id);
  DB.bookings = DB.bookings.filter(b=>b.patientId!==id);
  await saveDB();
  render();
  showToast('تم الحذف');
}

function refreshPatientDetail(){
  const ov = document.getElementById('modalPatientDetail');
  if(ov.classList.contains('active') && currentPatientId) viewPatient(currentPatientId);
}
function editCurrentPatient(){
  const id = currentPatientId;
  closeModal('modalPatientDetail');
  openPatientModal(id);
}

function viewPatient(id){
  const p = DB.patients.find(x=>x.id===id);
  if(!p) return;
  currentPatientId = id;
  const s = patientStats(p);
  const statusLabel = {confirmed:'مؤكد',done:'تم',cancelled:'ملغي'};
  const wa = normPhone(p.phone);
  const waLink = wa ? `https://wa.me/2${wa}` : '';
  const block = (label, val) => `<div class="field"><label>${label}</label><div class="pre">${esc(val||'—')}</div></div>`;

  document.getElementById('patientDetailContent').innerHTML = `
    <h3>${esc(p.name)}${p.auto?' <span class="pill pill-auto">فُتح تلقائيًا من حجز</span>':''}</h3>
    ${p.alerts?`<div class="alert-box">⚠ <b>تنبيه طبي:</b> ${esc(p.alerts)}</div>`:''}
    <div class="patient-stats four">
      <div><b>${s.visits.length}</b><span>إجمالي الحجوزات</span></div>
      <div><b>${s.doneCount}</b><span>زيارات مكتملة</span></div>
      <div><b>${s.last?esc(s.last.date):'—'}</b><span>آخر زيارة</span></div>
      <div><b>${s.next?esc(s.next.date):'—'}</b><span>الميعاد القادم</span></div>
    </div>
    <div class="field"><label>رقم الهاتف</label><div>${esc(p.phone||'—')} ${waLink?`<a class="btn btn-outline btn-sm" href="${waLink}" target="_blank" rel="noopener">واتساب</a>`:''}</div></div>
    <div class="field-row">
      <div class="field"><label>السن</label><div>${esc(p.age||'—')}</div></div>
      <div class="field"><label>تاريخ فتح الملف</label><div>${p.createdAt?esc(p.createdAt.slice(0,10)):'—'}</div></div>
    </div>
    ${block('العنوان', p.address)}
    ${block('التاريخ المرضي', p.history)}
    ${block('خطة العلاج / المتابعة', p.plan)}
    <div class="field"><label>سجل الزيارات (${s.visits.length})</label>
      ${s.visits.length ? s.visits.map(v=>`
        <div class="visit-card">
          <div class="visit-head">
            <b>${esc(v.date)} ${esc(v.time)}</b>
            <span class="pill pill-${esc(v.status)}">${statusLabel[v.status]||esc(v.status)}</span>
          </div>
          <div class="visit-svc">${esc(v.serviceName||'—')}</div>
          ${v.notes?`<div class="visit-line"><span>ملاحظات الحجز:</span> ${esc(v.notes)}</div>`:''}
          ${v.diagnosis?`<div class="visit-line"><span>التشخيص:</span> ${esc(v.diagnosis)}</div>`:''}
          ${v.treatment?`<div class="visit-line"><span>العلاج:</span> ${esc(v.treatment)}</div>`:''}
          ${v.doctorNotes?`<div class="visit-line"><span>ملاحظات الدكتور:</span> ${esc(v.doctorNotes)}</div>`:''}
          <button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="openVisitModal('${v.id}')">${(v.diagnosis||v.treatment||v.doctorNotes)?'تعديل ملاحظات الزيارة':'+ إضافة ملاحظات الزيارة'}</button>
        </div>`).join('') : '<div class="empty-state">لا توجد زيارات سابقة</div>'}
    </div>
    <div class="modal-actions">
      <button class="btn btn-teal" onclick="editCurrentPatient()">تعديل الملف</button>
      <button class="btn btn-outline" onclick="closeModal('modalPatientDetail')">إغلاق</button>
    </div>
  `;
  openModal('modalPatientDetail');
}

/* ---------------- settings ---------------- */
function renderSettings(){
  // ما نكتبش فوق اللي المستخدم بيكتبه دلوقتي
  const active = document.activeElement && document.activeElement.id;
  const set = (id,v)=>{ if(active!==id) document.getElementById(id).value = v; };
  set('setClinicName', DB.settings.clinicName||'');
  set('setClinicPhone', DB.settings.clinicPhone||'');
  set('setWebhookUrl', DB.settings.webhookUrl||'');
  set('setBookingsUrl', DB.settings.bookingsUrl||'');
}
async function saveSettings(){
  DB.settings.clinicName = document.getElementById('setClinicName').value.trim();
  DB.settings.clinicPhone = document.getElementById('setClinicPhone').value.trim();
  DB.settings.webhookUrl = document.getElementById('setWebhookUrl').value.trim();
  DB.settings.bookingsUrl = document.getElementById('setBookingsUrl').value.trim();
  await saveDB();
  showToast('تم حفظ الإعدادات');
  startAutoSync(); // يبدأ يسحب من الرابط الجديد فورًا
}
async function testWebhook(){
  const box = document.getElementById('webhookStatus');
  box.innerHTML='';
  if(!DB.settings.webhookUrl){
    box.innerHTML = `<div class="status-msg status-err">اكتب رابط الـ Webhook الأول واحفظه</div>`;
    return;
  }
  const r = await sendWebhook({event:'test_connection', message:'رسالة اختبار من نظام عيادة الابتسامة', clinic: DB.settings.clinicName, timestamp: new Date().toISOString()});
  if(r.sent){
    box.innerHTML = `<div class="status-msg status-ok">تم إرسال طلب الاختبار بنجاح. تأكد من الاستلام في n8n.</div>`;
  } else {
    box.innerHTML = `<div class="status-msg status-err">فشل الإرسال — تأكد إن الرابط صحيح وإن n8n يسمح بالاتصال من المتصفح (CORS).</div>`;
  }
}

/* ---------------- نسخة احتياطية (البيانات محفوظة في متصفح الدكتور) ---------------- */
function exportBackup(){
  const blob = new Blob([JSON.stringify(DB, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'clinic-backup-'+todayStr()+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  showToast('تم تنزيل النسخة الاحتياطية');
}
function importBackup(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const data = JSON.parse(reader.result);
      if(!data || !Array.isArray(data.patients) || !Array.isArray(data.bookings)) throw new Error('bad format');
      if(!confirm('استرجاع النسخة هيستبدل كل البيانات الحالية. متأكد؟')) return;
      DB = data;
      ensureShape();
      mergeDuplicatePatients();
      await saveDB();
      render();
      showToast('تم استرجاع النسخة الاحتياطية ✓');
    }catch(e){
      showToast('الملف مش نسخة احتياطية صحيحة');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

/* ---------------- modal helpers ---------------- */
function openModal(id){ document.getElementById(id).classList.add('active'); }
function closeModal(id){ document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.overlay').forEach(ov=>{
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.classList.remove('active'); });
});
function esc(s){ return (s??'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------------- init ---------------- */
(async function init(){
  await loadDB();
  const a = linkOrphanBookings();
  const b = mergeDuplicatePatients(); // يدمج أي ملفات مكررة لنفس الرقم
  if(a || b) await saveDB();
  render();
  startAutoSync(); // يبدأ تحديث الحجوزات من n8n / bookings.json تلقائيًا كل 30 ثانية
})();
