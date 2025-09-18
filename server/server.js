/**
 * server/server.js
 * نسخة معدّلة بسيطة: يطبع ردود Telegram للتشخيص، يدعم BOT_NOTIFY_TOKEN و BOT_NOTIFY_CHAT من env،
 * ويمد endpoint mark-read ليدعم body أو param، ويعيد تهيئة flags المرتبطة بالباج.
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: "*" }));

const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "",

  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "",

  BOT_ADMIN_CMD_TOKEN: process.env.BOT_ADMIN_CMD_TOKEN || "",
  BOT_ADMIN_CMD_CHAT: process.env.BOT_ADMIN_CMD_CHAT || "",

  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "",

  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || "",

  BOT_OFFERS_TOKEN: process.env.BOT_OFFERS_TOKEN || "",
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || "",

  // البوت الذي تستخدمه لإرسال رسائل مباشرة للمستخدمين (تم إضافة هذا)
  BOT_NOTIFY_TOKEN: process.env.BOT_NOTIFY_TOKEN || "",
  BOT_NOTIFY_CHAT: process.env.BOT_NOTIFY_CHAT || "",

  IMGBB_KEY: process.env.IMGBB_KEY || ""
};

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData(){
  try{
    if(!fs.existsSync(DATA_FILE)){
      const init = {
        profiles: [],
        orders: [],
        charges: [],
        offers: [],
        notifications: [],
        profileEditRequests: {},
        blocked: [],
        tgOffsets: {}
      };
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

function findProfileByPersonal(n){
  return DB.profiles.find(p => String(p.personalNumber) === String(n)) || null;
}
function ensureProfile(personal){
  let p = findProfileByPersonal(personal);
  if(!p){
    p = { personalNumber: String(personal), name: 'ضيف', email:'', phone:'', password:'', balance: 0, canEdit:false };
    DB.profiles.push(p); saveData(DB);
  } else {
    if(typeof p.balance === 'undefined') p.balance = 0;
  }
  return p;
}

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({ extended:true, limit:'10mb'}));

const PUBLIC_DIR = path.join(__dirname, 'public');
if(!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/', express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });
  try{
    if(CFG.IMGBB_KEY){
      try{
        const imgBase64 = req.file.buffer.toString('base64');
        const params = new URLSearchParams();
        params.append('image', imgBase64);
        params.append('name', req.file.originalname || `upload-${Date.now()}`);
        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${CFG.IMGBB_KEY}`, { method:'POST', body: params });
        const imgbbJson = await imgbbResp.json().catch(()=>null);
        if(imgbbJson && imgbbJson.success && imgbbJson.data && imgbbJson.data.url){
          return res.json({ ok:true, url: imgbbJson.data.url, provider:'imgbb' });
        }
      }catch(e){ console.warn('imgbb upload failed', e); }
    }
    const safeName = Date.now() + '-' + (req.file.originalname ? req.file.originalname.replace(/\s+/g,'_') : 'upload.jpg');
    const destPath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(destPath, req.file.buffer);
    const fullUrl = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(safeName)}`;
    return res.json({ ok:true, url: fullUrl, provider:'local' });
  }catch(err){
    console.error('upload handler error', err);
    return res.status(500).json({ ok:false, error: err.message || 'upload_failed' });
  }
});

// register
app.post('/api/register', async (req,res)=>{
  const { name, email, password, phone } = req.body;
  const personalNumber = req.body.personalNumber || req.body.personal || null;
  if(!personalNumber) return res.status(400).json({ ok:false, error:'missing personalNumber' });
  let p = findProfileByPersonal(personalNumber);
  if(!p){
    p = { personalNumber: String(personalNumber), name:name||'غير معروف', email:email||'', password:password||'', phone:phone||'', balance:0, canEdit:false };
    DB.profiles.push(p);
  } else {
    p.name = name || p.name;
    p.email = email || p.email;
    p.password = password || p.password;
    p.phone = phone || p.phone;
    if(typeof p.balance === 'undefined') p.balance = 0;
  }
  saveData(DB);

  const text = `تسجيل مستخدم جديد:\nالاسم: ${p.name}\nالبريد: ${p.email || 'لا يوجد'}\nالهاتف: ${p.phone || 'لا يوجد'}\nالرقم الشخصي: ${p.personalNumber}\nكلمة السر: ${p.password || '---'}`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const d = await r.json().catch(()=>null);
    console.log('register telegram result:', d);
  }catch(e){ console.warn('send login report failed', e); }

  return res.json({ ok:true, profile:p });
});

// login
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
  p.lastLogin = new Date().toISOString();
  saveData(DB);

  (async ()=>{
    try{
      const text = `تسجيل دخول:\nالاسم: ${p.name || 'غير معروف'}\nالرقم الشخصي: ${p.personalNumber}\nالهاتف: ${p.phone || 'لا يوجد'}\nالبريد: ${p.email || 'لا يوجد'}\nالوقت: ${p.lastLogin}`;
      const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
      });
      const d = await r.json().catch(()=>null);
      console.log('login notify result:', d);
    }catch(e){ console.warn('send login notify failed', e); }
  })();

  return res.json({ ok:true, profile:p });
});

app.get('/api/profile/:personal', (req,res)=>{
  const p = findProfileByPersonal(req.params.personal);
  if(!p) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, profile:p });
});

// profile edit request -> send message to admin bot, save mapping
app.post('/api/profile/request-edit', async (req,res)=>{
  const { personal } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = ensureProfile(personal);
  const text = `طلب تعديل بيانات المستخدم:\nالاسم: ${prof.name || 'غير معروف'}\nالرقم الشخصي: ${prof.personalNumber}\n(اكتب "تم" كرد هنا للموافقة على التعديل لمرة واحدة)`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('profile request-edit telegram result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      DB.profileEditRequests[String(data.result.message_id)] = String(prof.personalNumber);
      saveData(DB);
      return res.json({ ok:true, msgId: data.result.message_id });
    }
  }catch(e){ console.warn('profile request send error', e); }
  return res.json({ ok:false });
});

// submit profile edit (one-time)
app.post('/api/profile/submit-edit', (req,res)=>{
  const { personal, name, email, phone, password } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  const prof = findProfileByPersonal(personal);
  if(!prof) return res.status(404).json({ ok:false, error:'not found' });
  if(prof.canEdit !== true) return res.status(403).json({ ok:false, error:'edit_not_allowed' });

  if(name) prof.name = name;
  if(email) prof.email = email;
  if(phone) prof.phone = phone;
  if(password) prof.password = password;
  prof.canEdit = false;
  saveData(DB);

  return res.json({ ok:true, profile: prof });
});

// help ticket
app.post('/api/help', async (req,res)=>{
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  const prof = ensureProfile(personal);
  const text = `مشكلة من المستخدم:\nالاسم: ${name || prof.name || 'غير معروف'}\nالرقم الشخصي: ${personal}\nالهاتف: ${phone || prof.phone || 'لا يوجد'}\nالبريد: ${email || prof.email || 'لا يوجد'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || 'لا يوجد'}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('help telegram result:', data);
    return res.json({ ok:true, telegramResult: data });
  }catch(e){
    console.warn('help send error', e);
    return res.json({ ok:false, error: e.message || String(e) });
  }
});

// create order (supports paidWithBalance server-side)
app.post('/api/orders', async (req,res)=>{
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const prof = ensureProfile(personal);

  if(paidWithBalance){
    const price = Number(paidAmount || 0);
    if(isNaN(price) || price <= 0) return res.status(400).json({ ok:false, error:'invalid_paid_amount' });
    if(Number(prof.balance || 0) < price) return res.status(402).json({ ok:false, error:'insufficient_balance' });
    prof.balance = Number(prof.balance || 0) - price;
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

  const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personalNumber}\nالهاتف: ${order.phone || 'لا يوجد'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.idField || ''}\nطريقة الدفع: ${order.cashMethod || ''}\nرابط الملف: ${order.fileLink || ''}\nمعرف الطلب: ${order.id}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('order telegram send result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      order.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send order failed', e); }
  saveData(DB);
  return res.json({ ok: true, order: order, profile: prof });
});

// charge (طلب شحن رصيد)
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

  const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${charge.phone || 'لا يوجد'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;

  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('charge telegram send result:', data);
    if(data && data.ok && data.result && data.result.message_id){
      charge.telegramMessageId = data.result.message_id;
      saveData(DB);
    }
  }catch(e){ console.warn('send charge failed', e); }
  return res.json({ ok:true, charge });
});

// offer ack
app.post('/api/offer/ack', async (req,res)=>{
  const { personal, offerId } = req.body;
  if(!personal || !offerId) return res.status(400).json({ ok:false, error:'missing' });
  const prof = ensureProfile(personal);
  const offer = DB.offers.find(o=>String(o.id)===String(offerId));
  const text = `لقد حصل على العرض او الهدية\nالرقم الشخصي: ${personal}\nالبريد: ${prof.email||'لا يوجد'}\nالهاتف: ${prof.phone||'لا يوجد'}\nالعرض: ${offer ? offer.text : 'غير معروف'}`;
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_OFFERS_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_OFFERS_CHAT, text })
    });
    const data = await r.json().catch(()=>null);
    console.log('offer ack telegram result:', data);
    return res.json({ ok:true });
  }catch(e){
    return res.json({ ok:false, error: String(e) });
  }
});

// notifications endpoint
app.get('/api/notifications/:personal', (req,res)=>{
  const personal = req.params.personal;
  const prof = findProfileByPersonal(personal);
  if(!prof) return res.json({ ok:false, error:'not found' });
  const is7 = String(personal).length === 7;
  const visibleOffers = is7 ? DB.offers : [];
  const userOrders = DB.orders.filter(o => String(o.personalNumber)===String(personal));
  const userCharges = DB.charges.filter(c => String(c.personalNumber)===String(personal));
  const userNotifications = (DB.notifications || []).filter(n => String(n.personal) === String(personal));
  return res.json({ ok:true, profile:prof, offers: visibleOffers, orders:userOrders, charges:userCharges, notifications: userNotifications, canEdit: !!prof.canEdit });
});

// mark-read: supports body { personal } OR param /:personal
app.post('/api/notifications/mark-read/:personal?', (req, res) => {
  const personal = req.body && req.body.personal ? String(req.body.personal) : (req.params.personal ? String(req.params.personal) : null);
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  if(!DB.notifications) DB.notifications = [];
  DB.notifications.forEach(n => { if(String(n.personal) === String(personal)) n.read = true; });

  // also clear replied flags so badge calculation reflects read
  if(Array.isArray(DB.orders)){
    DB.orders.forEach(o => {
      if(String(o.personalNumber) === String(personal) && o.replied) {
        o.replied = false;
      }
    });
  }
  if(Array.isArray(DB.charges)){
    DB.charges.forEach(c => {
      if(String(c.personalNumber) === String(personal) && c.replied) {
        c.replied = false;
      }
    });
  }

  saveData(DB);
  return res.json({ ok:true });
});

// clear notifications
app.post('/api/notifications/clear', (req,res)=>{
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  if(!DB.notifications) DB.notifications = [];
  DB.notifications = DB.notifications.filter(n => String(n.personal) !== String(personal));
  saveData(DB);
  return res.json({ ok:true });
});

// poll/getUpdates logic
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

async function adminCmdHandler(update){
  if(!update.message || !update.message.text) return;
  const text = String(update.message.text || '').trim();
  if(/^حظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){ const num = m[1]; if(!DB.blocked.includes(String(num))){ DB.blocked.push(String(num)); saveData(DB); } }
    return;
  }
  if(/^الغاء الحظر/i.test(text) || /^إلغاء الحظر/i.test(text)){
    const m = text.match(/الرقم الشخصي[:\s]*([0-9]+)/i);
    if(m){ const num = m[1]; DB.blocked = DB.blocked.filter(x => x !== String(num)); saveData(DB); }
    return;
  }
}

async function genericBotReplyHandler(update){
  if(!update.message) return;
  const msg = update.message;
  const text = String(msg.text || '').trim();

  if(msg.reply_to_message && msg.reply_to_message.message_id){
    const repliedId = msg.reply_to_message.message_id;

    // orders replies
    const ord = DB.orders.find(o => o.telegramMessageId && Number(o.telegramMessageId) === Number(repliedId));
    if(ord){
      const low = text.toLowerCase();
      if(/^(تم|مقبول|accept)/i.test(low)){
        ord.status = 'تم قبول طلبك'; ord.replied = true; saveData(DB);
      } else if(/^(رفض|مرفوض|reject)/i.test(low)){
        ord.status = 'تم رفض طلبك'; ord.replied = true; saveData(DB);
      } else { ord.status = text; ord.replied = true; saveData(DB); }

      // notify user
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-order',
        personal: String(ord.personalNumber),
        text: `تحديث حالة الطلب #${ord.id}: ${ord.status}`,
        read: false,
        createdAt: new Date().toISOString()
      });
      saveData(DB);
      return;
    }

    // charges replies
    const ch = DB.charges.find(c => c.telegramMessageId && Number(c.telegramMessageId) === Number(repliedId));
    if(ch){
      const m = text.match(/الرصيد[:\s]*([0-9]+)/i);
      const mPersonal = text.match(/الرقم الشخصي[:\s\-\(\)]*([0-9]+)/i);
      if(m && mPersonal){
        const amount = Number(m[1]);
        const personal = String(mPersonal[1]);
        const prof = findProfileByPersonal(personal);
        if(prof){
          prof.balance = (prof.balance || 0) + amount;
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
        if(/^(تم|مقبول|accept)/i.test(text)) { ch.status = 'تم شحن الرصيد'; ch.replied = true; saveData(DB); }
        else if(/^(رفض|مرفوض|reject)/i.test(text)) { ch.status = 'تم رفض الطلب'; ch.replied = true; saveData(DB); }
        else { ch.status = text; ch.replied = true; saveData(DB); }

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

    // profile edit reply mapping
    if(DB.profileEditRequests && DB.profileEditRequests[String(repliedId)]){
      const personal = DB.profileEditRequests[String(repliedId)];
      if(/^تم$/i.test(text.trim())){
        const p = findProfileByPersonal(personal);
        if(p){
          p.canEdit = true;
          if(!DB.notifications) DB.notifications = [];
          DB.notifications.unshift({
            id: String(Date.now()) + '-edit',
            personal: String(p.personalNumber),
            text: 'تم قبول طلبك بتعديل معلوماتك الشخصية. تحقق من ذلك في ملفك الشخصي.',
            read: false,
            createdAt: new Date().toISOString()
          });
          saveData(DB);
        }
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
        return;
      } else {
        delete DB.profileEditRequests[String(repliedId)];
        saveData(DB);
        return;
      }
    }
  }

  // direct notification by personal number in plain message (admin writes message containing "الرقم الشخصي: <digits>")
  try{
    const mPersonal = text.match(/الرقم\s*الشخصي[:\s\-\(\)]*([0-9]+)/i);
    if(mPersonal){
      const personal = String(mPersonal[1]);
      const cleanedText = text.replace(mPersonal[0], '').trim();
      if(!DB.notifications) DB.notifications = [];
      DB.notifications.unshift({
        id: String(Date.now()) + '-direct',
        personal: personal,
        text: cleanedText || text,
        read: false,
        createdAt: new Date().toISOString()
      });
      saveData(DB);
      return;
    }
  }catch(e){ console.warn('personal direct notify parse error', e); }

  // offers
  if(/^عرض|^هدية/i.test(text)){
    const offerId = Date.now(); DB.offers.unshift({ id: offerId, text, createdAt: new Date().toISOString() }); saveData(DB);
  }
}

// poll wrapper
async function pollAllBots(){
  try{
    // admin commands
    if(CFG.BOT_ADMIN_CMD_TOKEN) await pollTelegramForBot(CFG.BOT_ADMIN_CMD_TOKEN, adminCmdHandler);
    // order/balance/help/offers/login
    if(CFG.BOT_ORDER_TOKEN) await pollTelegramForBot(CFG.BOT_ORDER_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_BALANCE_TOKEN) await pollTelegramForBot(CFG.BOT_BALANCE_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_LOGIN_REPORT_TOKEN) await pollTelegramForBot(CFG.BOT_LOGIN_REPORT_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_HELP_TOKEN) await pollTelegramForBot(CFG.BOT_HELP_TOKEN, genericBotReplyHandler);
    if(CFG.BOT_OFFERS_TOKEN) await pollTelegramForBot(CFG.BOT_OFFERS_TOKEN, genericBotReplyHandler);
    // notify bot (direct admin notifications)
    if(CFG.BOT_NOTIFY_TOKEN) await pollTelegramForBot(CFG.BOT_NOTIFY_TOKEN, genericBotReplyHandler);
  }catch(e){ console.warn('pollAllBots error', e); }
}

setInterval(pollAllBots, 2500);

// debug endpoints
app.get('/api/debug/db', (req,res)=> res.json({ ok:true, size: { profiles: DB.profiles.length, orders: DB.orders.length, charges: DB.charges.length, offers: DB.offers.length, notifications: (DB.notifications||[]).length }, tgOffsets: DB.tgOffsets || {} }));
app.post('/api/debug/clear-updates', (req,res)=>{ DB.tgOffsets = {}; saveData(DB); res.json({ok:true}); });

app.listen(PORT, ()=> {
  console.log(`Server listening on ${PORT}`);
  DB = loadData();
  console.log('DB loaded items:', DB.profiles.length, 'profiles');
});
// === /api/redeem-gift with Telegram notify ===
app.post('/api/redeem-gift', (req, res) => {
  const body = req.body || {};
  const personal = String(body.personal || body.personalNumber || req.headers['x-personal'] || '').trim();
  const codeIn = String(body.code || body.giftCode || '').trim().toUpperCase();

  if(!codeIn) return res.status(400).json({ ok:false, error:'missing_code', msg:'حقل code مطلوب' });
  if(!personal) return res.status(400).json({ ok:false, error:'missing_personal', msg:'الرقم الشخصي مطلوب (personal)' });

  // reload DB to get latest
  DB = loadData();
  const prof = ensureProfile(personal);

  if(!Array.isArray(prof.redeemedCodes)) prof.redeemedCodes = [];

  // server-side mapping of valid codes -> amounts
  const GIFT_CODES = {
    'A693D0M': 500,
    'FJGYFRDG': 100
    // أضف رموزاً أخرى هنا حسب الحاجة
  };

  if(!Object.prototype.hasOwnProperty.call(GIFT_CODES, codeIn)){
    console.log(`[redeem] invalid code attempt by ${personal}: ${codeIn}`);
    return res.status(404).json({ ok:false, error:'invalid_code', msg:'الرمز غير صالح' });
  }

  if(prof.redeemedCodes.includes(codeIn)){
    console.log(`[redeem] already redeemed by ${personal}: ${codeIn}`);
    return res.status(409).json({ ok:false, error:'already_redeemed', msg:'تمت الاستفادة من هذا الرمز مسبقاً' });
  }

  const amount = Number(GIFT_CODES[codeIn] || 0);
  prof.balance = (Number(prof.balance || 0) + amount);
  prof.redeemedCodes.push(codeIn);

  // add an in-app notification
  if(!DB.notifications) DB.notifications = [];
  DB.notifications.unshift({
    id: String(Date.now()) + '-gift',
    personal: String(prof.personalNumber),
    text: `تم اضافة ${amount.toLocaleString('en-US')} ل.س إلى رصيدك عن طريق رمز هدية (${codeIn})`,
    read: false,
    createdAt: new Date().toISOString()
  });

  // save DB now (so profile updated before sending telegram)
  saveData(DB);

  // Prepare telegram message (Arabic)
  const botToken = CFG.BOT_NOTIFY_TOKEN;
  const botChat = CFG.BOT_NOTIFY_CHAT;
  (async () => {
    if(botToken && botChat){
      try {
        const userName = prof.name || 'غير معروف';
        const text = `🔔 إشعار رمز هدية\nالمستخدم: ${userName}\nالرقم الشخصي: ${prof.personalNumber}\nالرمز: ${codeIn}\nالمبلغ: ${amount.toLocaleString('en-US')} ل.س\nالوقت: ${new Date().toLocaleString()}`;
        // send via Telegram sendMessage
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: botChat, text, parse_mode: 'HTML' })
        });
        const tgJson = await tgRes.json().catch(()=>null);
        if(!tgRes.ok || !tgJson || !tgJson.ok){
          console.warn('[redeem] telegram notify failed', tgRes.status, tgJson);
        } else {
          console.log('[redeem] telegram notified', codeIn, prof.personalNumber);
        }
      } catch (err) {
        console.warn('[redeem] telegram notify error', err);
      }
    } else {
      console.log('[redeem] telegram notify skipped (BOT_NOTIFY_TOKEN or BOT_NOTIFY_CHAT not set)');
    }
  })();

  // return success to client with updated profile
  return res.json({ ok:true, msg:'تم اضافة الرصيد', added: amount, profile: prof });
});
