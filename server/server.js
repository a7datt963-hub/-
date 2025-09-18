// server.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/** ---------- Google Sheets init + helpers ---------- **/
let sheetsClient = null;
async function initSheets() {
  try {
    let credsJson = process.env.GOOGLE_SA_KEY_JSON || null;
    if (!credsJson && process.env.GOOGLE_SA_CRED_PATH && fs.existsSync(process.env.GOOGLE_SA_CRED_PATH)) {
      credsJson = fs.readFileSync(process.env.GOOGLE_SA_CRED_PATH, 'utf8');
    }
    if (!credsJson) {
      console.warn('Google Sheets credentials not provided. Sheets disabled.');
      return;
    }
    const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
    const jwt = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    await jwt.authorize();
    sheetsClient = google.sheets({ version: 'v4', auth: jwt });
    console.log('Google Sheets initialized');
  } catch (e) {
    console.warn('initSheets error', e);
    sheetsClient = null;
  }
}
initSheets();

const SPREADSHEET_ID = process.env.SHEET_ID || null;

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function getProfileFromSheet(personal) {
  if (!sheetsClient || !SPREADSHEET_ID) return null;
  try {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Profiles!A2:F10000'
    });
    const rows = (resp.data && resp.data.values) || [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (String(r[0] || '') === String(personal)) {
        return {
          rowIndex: i + 2,
          personalNumber: r[0] || '',
          name: r[1] || '',
          email: r[2] || '',
          password: r[3] || '',
          phone: r[4] || '',
          balance: Number(r[5] || 0)
        };
      }
    }
    return null;
  } catch (e) {
    console.warn('getProfileFromSheet error', e);
    return null;
  }
}

async function upsertProfileRow(profile) {
  if (!sheetsClient || !SPREADSHEET_ID) return false;
  try {
    const existing = await getProfileFromSheet(profile.personalNumber);
    const values = [
      String(profile.personalNumber || ''),
      profile.name || '',
      profile.email || '',
      profile.password || '',
      profile.phone || '',
      String(profile.balance == null ? 0 : profile.balance)
    ];
    if (existing && existing.rowIndex) {
      const range = `Profiles!A${existing.rowIndex}:F${existing.rowIndex}`;
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [values] }
      });
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Profiles!A2:F2',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] }
      });
    }
    return true;
  } catch (e) {
    console.warn('upsertProfileRow error', e);
    return false;
  }
}

// retry wrapper for updating balance (3 attempts)
async function updateBalanceInSheet(personal, newBalance) {
  if (!sheetsClient || !SPREADSHEET_ID) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const existing = await getProfileFromSheet(personal);
      if (existing && existing.rowIndex) {
        const range = `Profiles!F${existing.rowIndex}`;
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: [[ String(newBalance) ]] }
        });
        return true;
      } else {
        await upsertProfileRow({ personalNumber: personal, name:'', email:'', password:'', phone:'', balance: newBalance });
        return true;
      }
    } catch (e) {
      console.warn(`updateBalanceInSheet attempt ${attempt} failed`, e);
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  return false;
}

/** ---------- Config & DB ---------- **/
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "",
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "",
  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "",
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "",
  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "",
  IMGBB_KEY: process.env.IMGBB_KEY || ""
};

const DATA_FILE = path.join(__dirname, 'data.json');
function loadData(){
  try{
    if(!fs.existsSync(DATA_FILE)){
      const init = { profiles: [], orders: [], charges: [], offers: [], notifications: [], profileEditRequests: {}, blocked: [], tgOffsets: {} };
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DATA_FILE,'utf8');
    return JSON.parse(raw || '{}');
  }catch(e){
    console.error('loadData error', e);
    return { profiles:[], orders:[], charges:[], offers:[], notifications:[], profileEditRequests:{}, blocked:[], tgOffsets:{} };
  }
}
function saveData(d){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }catch(e){ console.error('saveData error', e); } }
let DB = loadData();

function findProfileByPersonal(n){ return DB.profiles.find(p => String(p.personalNumber) === String(n)) || null; }
function ensureProfile(personal){
  let p = findProfileByPersonal(personal);
  if(!p){
    p = { personalNumber: String(personal), name: 'ضيف', email:'', phone:'', password:'', balance: 0, canEdit:false };
    DB.profiles.push(p); saveData(DB);
  } else { if(typeof p.balance === 'undefined') p.balance = 0; }
  return p;
}

/** ---------- Static + uploads ---------- **/
const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

/** ---------- Endpoints (register/login/profile/orders/charges) ---------- **/

app.post('/api/register', async (req,res)=>{
  const { name, email, password, phone } = req.body;
  const personalNumber = req.body.personalNumber || req.body.personal || null;
  if(!personalNumber) return res.status(400).json({ ok:false, error:'missing personalNumber' });
  let p = findProfileByPersonal(personalNumber);
  if(!p){
    p = { personalNumber: String(personalNumber), name:name||'غير معروف', email:email||'', password:password||'', phone:phone||'', balance:0, canEdit:false };
    DB.profiles.push(p);
  } else {
    p.name = name || p.name; p.email = email || p.email; p.password = password || p.password; p.phone = phone || p.phone;
    if(typeof p.balance === 'undefined') p.balance = 0;
  }
  saveData(DB);
  upsertProfileRow(p).catch(()=>{});
  // notify admin (best-effort)
  (async ()=>{
    try{
      const text = `تسجيل مستخدم جديد:\n${p.name}\nالرقم: ${p.personalNumber}\nالهاتف: ${p.phone || '---'}`;
      await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
    }catch(e){ console.warn('register notify failed', e); }
  })();
  return res.json({ ok:true, profile:p });
});

app.post('/api/login', async (req,res)=>{
  const { personalNumber, email, password } = req.body || {};
  let p = null;
  if(personalNumber) p = findProfileByPersonal(personalNumber);
  else if(email) p = DB.profiles.find(x => x.email && x.email.toLowerCase() === String(email).toLowerCase()) || null;
  if(!p) return res.status(404).json({ ok:false, error:'not_found' });
  if(typeof p.password !== 'undefined' && String(p.password).length > 0){
    if(typeof password === 'undefined' || String(password) !== String(p.password)){
      return res.status(401).json({ ok:false, error:'invalid_password' });
    }
  }

  try {
    const sheetProf = await getProfileFromSheet(String(p.personalNumber));
    if (sheetProf) {
      // important: do not overwrite local higher balance with an older sheet value
      p.balance = Math.max(Number(p.balance || 0), Number(sheetProf.balance || 0));
      p.name = p.name || sheetProf.name || p.name;
      p.email = p.email || sheetProf.email || p.email;
    } else {
      upsertProfileRow(p).catch(()=>{});
    }
  } catch (e) { console.warn('sheet sync on login failed', e); }

  p.lastLogin = new Date().toISOString();
  saveData(DB);

  // notify login async
  (async ()=>{
    try{
      const text = `تسجيل دخول:\n${p.name}\n${p.personalNumber}\n${p.lastLogin}`;
      await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
    }catch(e){ console.warn('login notify failed', e); }
  })();

  return res.json({ ok:true, profile:p });
});

app.get('/api/profile/:personal', (req,res)=>{
  const p = findProfileByPersonal(req.params.personal);
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
  return res.json({ ok:true, profile:p });
});

/** create order
 * IMPORTANT: if paidWithBalance we deduct and update sheet immediately, then return response
 * we send Telegram notification in background (non-blocking) so client won't timeout when telegram is slow.
 */
app.post('/api/orders', async (req,res)=>{
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const prof = ensureProfile(personal);

  let price = 0;
  if(paidWithBalance){
    price = Number(paidAmount || 0);
    if(isNaN(price) || price <= 0) return res.status(400).json({ ok:false, error:'invalid_paid_amount' });
    if(Number(prof.balance || 0) < price) return res.status(402).json({ ok:false, error:'insufficient_balance' });
    prof.balance = Number(prof.balance || 0) - price;
    // update sheet (best-effort with retry)
    updateBalanceInSheet(prof.personalNumber, prof.balance).catch(e=>{ console.warn('updateBalanceInSheet(order) failed', e); });
    saveData(DB);
    if(!DB.notifications) DB.notifications = [];
    DB.notifications.unshift({
      id: String(Date.now()) + '-charge',
      personal: String(prof.personalNumber),
      text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  const orderId = Date.now();
  const order = {
    id: orderId,
    personalNumber: String(personal),
    phone: phone || prof.phone || '',
    type, item, idField: idField || '',
    fileLink: fileLink || '',
    cashMethod: cashMethod || '',
    status: 'قيد المراجعة',
    replied: false,
    telegramMessageId: null,
    paidWithBalance: !!paidWithBalance,
    paidAmount: Number(paidAmount || 0),
    createdAt: new Date().toISOString()
  };
  DB.orders.unshift(order);
  saveData(DB);

  // respond to client immediately (profile includes up-to-date balance)
  res.json({ ok: true, order: order, profile: prof });

  // send telegram in background (non-blocking)
  (async ()=>{
    try{
      const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      console.log('async order telegram result:', data);
      if(data && data.ok && data.result && data.result.message_id){
        order.telegramMessageId = data.result.message_id;
        saveData(DB);
      }
    }catch(e){
      console.warn('async send order failed', e);
    }
  })();
});

/** create charge (request to top-up) 
 * we store the charge and respond immediately; sending to admin bot is background.
 */
app.post('/api/charge', async (req,res)=>{
  const { personal, phone, amount, method, fileLink } = req.body;
  if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing fields' });
  const prof = ensureProfile(personal);
  const chargeId = Date.now();
  const charge = {
    id: chargeId,
    personalNumber: String(personal),
    phone: phone || prof.phone || '',
    amount, method, fileLink: fileLink || '',
    status: 'قيد المراجعة',
    telegramMessageId: null,
    createdAt: new Date().toISOString()
  };
  DB.charges.unshift(charge);
  saveData(DB);

  // respond quickly
  res.json({ ok:true, charge });

  // send telegram in background
  (async ()=>{
    try{
      const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${charge.phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
      });
      const data = await r.json().catch(()=>null);
      console.log('async charge telegram result:', data);
      if(data && data.ok && data.result && data.result.message_id){
        charge.telegramMessageId = data.result.message_id;
        saveData(DB);
      }
    }catch(e){ console.warn('async send charge failed', e); }
  })();
});

/** ---------- Telegram poll handlers (reply parsing) ---------- **/
async function pollTelegramForBot(botToken, handler){
  try{
    const last = DB.tgOffsets[botToken] || 0;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${last+1}&timeout=2`);
    const data = await res.json().catch(()=>null);
    if(!data || !data.ok) return;
    const updates = data.result || [];
    for(const u of updates){
      DB.tgOffsets[botToken] = u.update_id;
      try{ await handler(u); }catch(e){ console.warn('handler error', e); }
    }
    saveData(DB);
  }catch(e){ console.warn('pollTelegramForBot err', e); }
}

async function genericBotReplyHandler(update){
  if(!update.message) return;
  const msg = update.message;
  const text = String(msg.text || '').trim();

  // handle reply-to messages
  if(msg.reply_to_message && msg.reply_to_message.message_id){
    const repliedId = msg.reply_to_message.message_id;

    // orders replies (simple status)
    const ord = DB.orders.find(o => o.telegramMessageId && Number(o.telegramMessageId) === Number(repliedId));
    if(ord){
      if(/^(تم|مقبول|accept)/i.test(text)) ord.status = 'تم قبول طلبك';
      else if(/^(رفض|مرفوض|reject)/i.test(text)) ord.status = 'تم رفض طلبك';
      else ord.status = text;
      ord.replied = true;
      saveData(DB);
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({ id: String(Date.now()) + '-order', personal: String(ord.personalNumber), text: `تحديث حالة الطلب #${ord.id}: ${ord.status}`, read:false, createdAt: new Date().toISOString() });
      saveData(DB);
      return;
    }

    // charges replies -> this is important: increase local balance AND update sheet
    const ch = DB.charges.find(c => c.telegramMessageId && Number(c.telegramMessageId) === Number(repliedId));
    if (ch) {
      // accept reply with amount and personal number
      const m = text.match(/الرصيد[:\s]*([0-9\.,]+)/i);
      const mPersonal = text.match(/الرقم الشخصي[:\s\-\(\)]*([0-9]+)/i);

      if (m && mPersonal) {
        const amount = Number(String(m[1]).replace(/[,\s]+/g, ''));
        const personal = String(mPersonal[1]);
        const prof = findProfileByPersonal(personal);
        if (prof) {
          prof.balance = (prof.balance || 0) + amount;
          // try updating sheet with retry wrapper
          const ok = await updateBalanceInSheet(prof.personalNumber, prof.balance).catch(()=>false);
          if(!ok) console.warn('updateBalanceInSheet returned false after charge reply');
          ch.status = 'تم تحويل الرصيد';
          ch.replied = true;
          saveData(DB);
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-balance',
            personal: String(prof.personalNumber),
            text: `تم شحن رصيدك بمبلغ ${amount.toLocaleString('en-US')} ل.س. رصيدك الآن: ${(prof.balance||0).toLocaleString('en-US')} ل.س`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
      } else {
        // simple status-only reply
        if(/^(تم|مقبول|accept)/i.test(text)) ch.status = 'تم شحن الرصيد';
        else if(/^(رفض|مرفوض|reject)/i.test(text)) ch.status = 'تم رفض الطلب';
        else ch.status = text;
        ch.replied = true;
        saveData(DB);
        const prof = findProfileByPersonal(ch.personalNumber);
        if(prof){
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-charge-status',
            personal: String(prof.personalNumber),
            text: `تحديث حالة شحن الرصيد #${ch.id}: ${ch.status}`,
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
      }
      return;
    }

  } // end reply_to_message
  // ... other generic handlers (direct notifications / offers) omitted for brevity
}

// poll wrapper (every 2.5s)
async function pollAllBots(){
  try{
    if(CFG.BOT_ORDER_TOKEN) await pollTelegramForBot(CFG.BOT_ORDER_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_BALANCE_TOKEN) await pollTelegramForBot(CFG.BOT_BALANCE_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_LOGIN_REPORT_TOKEN) await pollTelegramForBot(CFG.BOT_LOGIN_REPORT_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_HELP_TOKEN) await pollTelegramForBot(CFG.BOT_HELP_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_OFFERS_TOKEN) await pollTelegramForBot(CFG.BOT_OFFERS_TOKEN, genericBotReplyHandler);
  }catch(e){ console.warn('pollAllBots error', e); }
}
setInterval(pollAllBots, 2500);

/** debug */
app.get('/api/debug/db', (req,res)=> res.json({ ok:true, size: { profiles: DB.profiles.length, orders: DB.orders.length, charges: DB.charges.length, notifications: (DB.notifications||[]).length }, tgOffsets: DB.tgOffsets || {} }));

/** start server */
app.listen(PORT, ()=> {
  console.log(`Server listening on ${PORT}`);
  DB = loadData();
  console.log('DB loaded items:', DB.profiles.length, 'profiles');
});
