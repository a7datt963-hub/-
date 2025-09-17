// server.js (Supabase-backed)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Supabase client (server/service role key recommended)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Telegram configs (reused from original design)
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
  BOT_OFFERS_CHAT: process.env.BOT_OFFERS_CHAT || ""
};

// multer memory for upload forwarding to Supabase Storage
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

// ----------------- upload -> saves to Supabase Storage bucket 'uploads' -----------------
app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });

  try{
    const bucket = 'uploads';
    // ensure bucket exists manually in Supabase dashboard, or create programmatically if needed
    const filename = `${Date.now()}-${Math.random().toString(36).substring(2,8)}-${req.file.originalname.replace(/\s+/g,'_')}`;
    const path = filename;

    const { data, error } = await supabase.storage.from(bucket).upload(path, req.file.buffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: req.file.mimetype
    });
    if(error){
      console.error('storage upload error', error);
      return res.status(500).json({ ok:false, error: error.message || error });
    }

    // get public URL (bucket must be public) or generate signed URL
    const { publicURL } = supabase.storage.from(bucket).getPublicUrl(path);
    // alternatively: const { data: sdata, error: serr } = await supabase.storage.from(bucket).createSignedUrl(path, 60*60*24);

    return res.json({ ok:true, url: publicURL, provider: 'supabase' });
  }catch(e){
    console.error('upload handler error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Register / upsert profile -----------------
app.post('/api/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  const personalNumber = req.body.personalNumber || req.body.personal || null;
  if(!personalNumber) return res.status(400).json({ ok:false, error:'missing personalNumber' });

  try{
    // upsert profile by personal_number
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        personal_number: String(personalNumber),
        name: name || 'غير معروف',
        email: email || null,
        password: password || null,
        phone: phone || null
      }, { onConflict: 'personal_number' })
      .select()
      .single();

    if(error) throw error;

    // send telegram (optional) similar to original
    const text = `تسجيل مستخدم جديد:\nالاسم: ${data.name}\nالبريد: ${data.email || 'لا'}\nالهاتف: ${data.phone || 'لا'}\nالرقم الشخصي: ${data.personal_number}\nكلمة السر: ${data.password || '---'}`;
    try{
      if(CFG.BOT_LOGIN_REPORT_TOKEN && CFG.BOT_LOGIN_REPORT_CHAT){
        await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
        });
      }
    }catch(e){ console.warn('send login report failed', e); }

    return res.json({ ok:true, profile: data });
  }catch(e){
    console.error('register error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Login -----------------
app.post('/api/login', async (req, res) => {
  const { personalNumber, email, password } = req.body || {};
  try{
    let query = supabase.from('profiles').select('*');
    if(personalNumber) query = query.eq('personal_number', String(personalNumber));
    else if(email) query = query.eq('email', String(email).toLowerCase());
    else return res.status(400).json({ ok:false, error:'missing login identifier' });

    const { data, error } = await query.limit(1).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({ ok:false, error:'not_found' });

    // password check (note: plaintext like original; for prod use bcrypt)
    if(data.password && String(data.password).length > 0){
      if(typeof password === 'undefined' || String(password) !== String(data.password)){
        return res.status(401).json({ ok:false, error:'invalid_password' });
      }
    }

    // update last login timestamp
    await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('personal_number', data.personal_number);

    // notify telegram (async)
    (async ()=>{
      try{
        const text = `تسجيل دخول:\nالاسم: ${data.name || 'غير معروف'}\nالرقم الشخصي: ${data.personal_number}\nالهاتف: ${data.phone || 'لا'}\nالبريد: ${data.email || 'لا'}\nالوقت: ${new Date().toISOString()}`;
        if(CFG.BOT_LOGIN_REPORT_TOKEN && CFG.BOT_LOGIN_REPORT_CHAT){
          await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
            method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
          });
        }
      }catch(e){ console.warn('send login notify failed', e); }
    })();

    return res.json({ ok:true, profile: data });
  }catch(e){
    console.error('login error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Get profile -----------------
app.get('/api/profile/:personal', async (req, res) => {
  const personal = req.params.personal;
  try{
    const { data, error } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({ ok:false, error:'not found' });
    return res.json({ ok:true, profile: data });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Profile edit request -----------------
app.post('/api/profile/request-edit', async (req, res) => {
  const { personal } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  try{
    // insert a request record
    const reqId = Date.now();
    const { data, error } = await supabase.from('profile_edit_requests').insert({
      id: reqId,
      personal_number: String(personal),
      status: 'pending'
    }).select().single();
    if(error) throw error;

    // send to telegram admin and if message id exists, update record.message_id
    const text = `طلب تعديل بيانات المستخدم:\nالرقم الشخصي: ${personal}\n(رد بتم للموافقة)`;
    try{
      if(CFG.BOT_LOGIN_REPORT_TOKEN && CFG.BOT_LOGIN_REPORT_CHAT){
        const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text })
        });
        const d = await r.json().catch(()=>null);
        if(d && d.ok && d.result && d.result.message_id){
          await supabase.from('profile_edit_requests').update({ message_id: d.result.message_id }).eq('id', reqId);
        }
      }
    }catch(e){ console.warn('profile request send error', e); }

    return res.json({ ok:true, reqId: data.id });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Submit profile edit (admin-granted once) -----------------
app.post('/api/profile/submit-edit', async (req, res) => {
  const { personal, name, email, phone, password } = req.body;
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  try{
    // check can_edit flag
    const { data: prof, error: pe } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).maybeSingle();
    if(pe) throw pe;
    if(!prof) return res.status(404).json({ ok:false, error:'not found' });
    if(!prof.can_edit) return res.status(403).json({ ok:false, error:'edit_not_allowed' });

    const updates = {};
    if(name) updates.name = name;
    if(email) updates.email = email;
    if(phone) updates.phone = phone;
    if(password) updates.password = password;
    updates.can_edit = false;

    const { data, error } = await supabase.from('profiles').update(updates).eq('personal_number', String(personal)).select().maybeSingle();
    if(error) throw error;

    return res.json({ ok:true, profile: data });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Help ticket -----------------
app.post('/api/help', async (req, res) => {
  const { personal, issue, fileLink, desc, name, email, phone } = req.body;
  try{
    const id = Date.now();
    const { data, error } = await supabase.from('help_tickets').insert({
      id,
      personal_number: personal || null,
      name: name || null,
      email: email || null,
      phone: phone || null,
      issue: issue || null,
      description: desc || null,
      file_link: fileLink || null
    }).select().single();
    if(error) throw error;

    // send telegram as before
    const text = `مشكلة من المستخدم:\nالاسم: ${name || 'غير معروف'}\nالرقم الشخصي: ${personal || '-'}\nالهاتف: ${phone || '-'}\nالمشكلة: ${issue}\nالوصف: ${desc || ''}\nرابط الملف: ${fileLink || ''}`;
    if(CFG.BOT_HELP_TOKEN && CFG.BOT_HELP_CHAT){
      try{
        await fetch(`https://api.telegram.org/bot${CFG.BOT_HELP_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_HELP_CHAT, text })
        });
      }catch(e){ console.warn('help send error', e); }
    }

    return res.json({ ok:true, ticket: data });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Create order -----------------
app.post('/api/orders', async (req, res) => {
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const orderId = Date.now();

  try{
    // start transaction-ish: use simple sequential ops
    // debit balance if paying with balance
    if(paidWithBalance){
      const { data: prof, error: pe } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).maybeSingle();
      if(pe) throw pe;
      if(!prof) return res.status(404).json({ ok:false, error:'profile not found' });

      const price = Number(paidAmount || 0);
      if(isNaN(price) || price <= 0) return res.status(400).json({ ok:false, error:'invalid_paid_amount' });
      if(Number(prof.balance || 0) < price) return res.status(402).json({ ok:false, error:'insufficient_balance' });

      const newBalance = Number(prof.balance || 0) - price;
      await supabase.from('profiles').update({ balance: newBalance }).eq('personal_number', String(personal));
      // create notification
      await supabase.from('notifications').insert({
        id: Date.now(),
        personal_number: String(personal),
        text: `تم خصم ${price.toLocaleString('en-US')} ل.س من رصيدك لطلب: ${item}`,
        read: false
      });
    }

    const order = {
      id: orderId,
      personal_number: String(personal),
      phone: phone || null,
      type, item, id_field: idField || null,
      file_link: fileLink || null,
      cash_method: cashMethod || null,
      status: 'قيد المراجعة',
      replied: false,
      paid_with_balance: !!paidWithBalance,
      paid_amount: Number(paidAmount || 0),
      created_at: new Date().toISOString()
    };
    await supabase.from('orders').insert(order);

    // send telegram admin message (optional)
    const text = `طلب شحن جديد:\n\nرقم شخصي: ${order.personal_number}\nالهاتف: ${order.phone || 'لا'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.id_field || ''}\nطريقة الدفع: ${order.cash_method || ''}\nرابط الملف: ${order.file_link || ''}\nمعرف الطلب: ${order.id}`;
    if(CFG.BOT_ORDER_TOKEN && CFG.BOT_ORDER_CHAT){
      try{
        await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
        });
      }catch(e){ console.warn('send order failed', e); }
    }

    return res.json({ ok:true, order });
  }catch(e){
    console.error('orders error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Charge (top-up) -----------------
app.post('/api/charge', async (req, res) => {
  const { personal, phone, amount, method, fileLink } = req.body;
  if(!personal || !amount) return res.status(400).json({ ok:false, error:'missing fields' });
  const chargeId = Date.now();

  try{
    const charge = {
      id: chargeId,
      personal_number: String(personal),
      phone: phone || null,
      amount: Number(amount),
      method: method || null,
      file_link: fileLink || null,
      status: 'قيد المراجعة',
      created_at: new Date().toISOString()
    };
    await supabase.from('charges').insert(charge);

    // send telegram
    const text = `طلب شحن رصيد:\n\nرقم شخصي: ${personal}\nالهاتف: ${phone || 'لا'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method || ''}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}`;
    if(CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT){
      try{
        await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
        });
      }catch(e){ console.warn('send charge failed', e); }
    }

    return res.json({ ok:true, charge });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Notifications endpoint -----------------
app.get('/api/notifications/:personal', async (req, res) => {
  const personal = req.params.personal;
  try{
    const { data: profile } = await supabase.from('profiles').select('*').eq('personal_number', String(personal)).maybeSingle();
    if(!profile) return res.json({ ok:false, error:'not found' });

    // offers: example logic: if personal length==7 show offers else []
    let offers = [];
    if(String(personal).length === 7) {
      const { data: off } = await supabase.from('offers').select('*').order('created_at', { ascending: false }).limit(20);
      offers = off || [];
    }

    const { data: orders } = await supabase.from('orders').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false });
    const { data: charges } = await supabase.from('charges').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false });
    const { data: notifications } = await supabase.from('notifications').select('*').eq('personal_number', String(personal)).order('created_at', { ascending: false });

    return res.json({ ok:true, profile, offers, orders: orders || [], charges: charges || [], notifications: notifications || [], canEdit: !!profile.can_edit });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- mark-read (notifications) -----------------
app.post('/api/notifications/mark-read/:personal?', async (req, res) => {
  const personal = req.body && req.body.personal ? String(req.body.personal) : (req.params.personal ? String(req.params.personal) : null);
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });

  try{
    await supabase.from('notifications').update({ read: true }).eq('personal_number', personal);
    // reset replied flags (similar to original)
    await supabase.from('orders').update({ replied: false }).eq('personal_number', personal);
    await supabase.from('charges').update({ replied: false }).eq('personal_number', personal);
    return res.json({ ok:true });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- clear notifications -----------------
app.post('/api/notifications/clear', async (req, res) => {
  const { personal } = req.body || {};
  if(!personal) return res.status(400).json({ ok:false, error:'missing personal' });
  try{
    await supabase.from('notifications').delete().eq('personal_number', String(personal));
    return res.json({ ok:true });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- debug / health -----------------
app.get('/api/debug/health', async (req, res) => {
  res.json({ ok:true, now: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Supabase-backed server running on port ${PORT}`);
});
