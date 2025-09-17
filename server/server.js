// server.js (Supabase-backed) - Updated for matching by name+email+phone and Telegram webhook handling
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

// Telegram / Bot configs (could be same token for all)
const CFG = {
  BOT_ORDER_TOKEN: process.env.BOT_ORDER_TOKEN || "",
  BOT_ORDER_CHAT: process.env.BOT_ORDER_CHAT || "",
  BOT_BALANCE_TOKEN: process.env.BOT_BALANCE_TOKEN || "",
  BOT_BALANCE_CHAT: process.env.BOT_BALANCE_CHAT || "",
  BOT_LOGIN_REPORT_TOKEN: process.env.BOT_LOGIN_REPORT_TOKEN || "",
  BOT_LOGIN_REPORT_CHAT: process.env.BOT_LOGIN_REPORT_CHAT || "",
  BOT_HELP_TOKEN: process.env.BOT_HELP_TOKEN || "",
  BOT_HELP_CHAT: process.env.BOT_HELP_CHAT || ""
};

// multer memory for upload forwarding to Supabase Storage
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({ storage: memoryStorage });

// ----------------- upload -> saves to Supabase Storage bucket 'uploads' -----------------
app.post('/api/upload', uploadMemory.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ ok:false, error:'no file' });

  try{
    const bucket = 'uploads';
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

    const { publicURL } = supabase.storage.from(bucket).getPublicUrl(path);
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

    const text = `تسجيل مستخدم جديد:\nالاسم: ${data.name}\nالبريد: ${data.email || 'لا'}\nالهاتف: ${data.phone || 'لا'}\nالرقم الشخصي: ${data.personal_number}\n`;
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

// ----------------- Login: allow matching by personalNumber OR (name+email+phone) -----------------
app.post('/api/login', async (req, res) => {
  const { personalNumber, email, password, name, phone } = req.body || {};
  try{
    // If personalNumber provided => query by personal_number
    if(personalNumber) {
      const { data, error } = await supabase.from('profiles').select('*').eq('personal_number', String(personalNumber)).maybeSingle();
      if(error) throw error;
      if(!data) return res.status(404).json({ ok:false, error:'not_found' });
      // password check (plain-text as before; recommend bcrypt)
      if(data.password && String(data.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(data.password)){
          return res.status(401).json({ ok:false, error:'invalid_password' });
        }
      }
      await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('personal_number', data.personal_number);
      (async ()=>{ try{ if(CFG.BOT_LOGIN_REPORT_TOKEN && CFG.BOT_LOGIN_REPORT_CHAT) await fetch(`https://api.telegram.org/bot${CFG.BOT_LOGIN_REPORT_TOKEN}/sendMessage`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: CFG.BOT_LOGIN_REPORT_CHAT, text: `تسجيل دخول: ${data.name} - ${data.personal_number}` }) }); }catch(e){} })();
      return res.json({ ok:true, profile: data });
    }

    // Otherwise try match by name + email + phone (all three must exist and match)
    if(name && email && phone) {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .ilike('name', name)     // case-insensitive match; ilike supports patterns — using exact (no %)
        .ilike('email', email)
        .ilike('phone', phone)
        .limit(1)
        .maybeSingle();

      if(error) throw error;
      if(!data) {
        // Not found by full match — also try matching by email+phone (in case name slightly different)
        const { data: alt, error: altErr } = await supabase
          .from('profiles')
          .select('*')
          .ilike('email', email)
          .ilike('phone', phone)
          .limit(1)
          .maybeSingle();
        if(altErr) throw altErr;
        if(alt) {
          // success
          await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('personal_number', alt.personal_number);
          return res.json({ ok:true, profile: alt });
        }
        return res.status(404).json({ ok:false, error:'not_found' });
      }
      // password check if exists
      if(data.password && String(data.password).length > 0){
        if(typeof password === 'undefined' || String(password) !== String(data.password)){
          return res.status(401).json({ ok:false, error:'invalid_password' });
        }
      }
      await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('personal_number', data.personal_number);
      return res.json({ ok:true, profile: data });
    }

    return res.status(400).json({ ok:false, error:'missing_login_identifier' });
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
    const reqId = Date.now();
    const { data, error } = await supabase.from('profile_edit_requests').insert({
      id: reqId,
      personal_number: String(personal),
      status: 'pending'
    }).select().single();
    if(error) throw error;

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

// ----------------- Create order (updated to store telegram_message_id) -----------------
app.post('/api/orders', async (req, res) => {
  const { personal, phone, type, item, idField, fileLink, cashMethod, paidWithBalance, paidAmount } = req.body;
  if(!personal || !type || !item) return res.status(400).json({ ok:false, error:'missing fields' });
  const orderId = Date.now();

  try{
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
      await supabase.from('notifications').insert({
        id: Date.now(),
        personal_number: String(personal),
        text: `تم خصم ${price} ل.س من رصيدك لطلب: ${item}`,
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
    // insert order
    const { error: insertErr } = await supabase.from('orders').insert(order);
    if(insertErr) throw insertErr;

    // send telegram admin message and capture message_id
    const text = `📥 طلب شحن جديد:\nرقم شخصي: ${order.personal_number}\nالهاتف: ${order.phone || 'لا'}\nالنوع: ${order.type}\nالتفاصيل: ${order.item}\nالايدي: ${order.id_field || ''}\nطريقة الدفع: ${order.cash_method || ''}\nرابط الملف: ${order.file_link || ''}\nمعرف الطلب: ${order.id}\n\n(للرد: قم بالرد على هذه الرسالة واذكر المبلغ أو 'تم')`;
    try{
      if(CFG.BOT_ORDER_TOKEN && CFG.BOT_ORDER_CHAT){
        const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_ORDER_TOKEN}/sendMessage`, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ chat_id: CFG.BOT_ORDER_CHAT, text })
        });
        const d = await r.json().catch(()=>null);
        if(d && d.ok && d.result && d.result.message_id){
          // store telegram_message_id in orders row
          await supabase.from('orders').update({ telegram_message_id: d.result.message_id }).eq('id', orderId);
        }
      }
    }catch(e){ console.warn('send order failed', e); }

    return res.json({ ok:true, order });
  }catch(e){
    console.error('orders error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----------------- Charge (top-up) (updated to store telegram_message_id) -----------------
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
    const { error: insertErr } = await supabase.from('charges').insert(charge);
    if(insertErr) throw insertErr;

    // send telegram and capture message id
    const text = `🔔 طلب شحن رصيد:\nرقم شخصي: ${personal}\nالهاتف: ${phone || 'لا'}\nالمبلغ: ${amount}\nطريقة الدفع: ${method || ''}\nرابط الملف: ${fileLink || ''}\nمعرف الطلب: ${chargeId}\n\n(قم بالرد على هذه الرسالة بالمبلغ لإضافة الرصيد)`;
    try{
      if(CFG.BOT_BALANCE_TOKEN && CFG.BOT_BALANCE_CHAT){
        const r = await fetch(`https://api.telegram.org/bot${CFG.BOT_BALANCE_TOKEN}/sendMessage`, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ chat_id: CFG.BOT_BALANCE_CHAT, text })
        });
        const d = await r.json().catch(()=>null);
        if(d && d.ok && d.result && d.result.message_id){
          await supabase.from('charges').update({ telegram_message_id: d.result.message_id }).eq('id', chargeId);
        }
      }
    }catch(e){ console.warn('send charge failed', e); }

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

// ----------------- Telegram webhook to handle replies from admin (crediting balance / approving) -----------------
app.post('/api/telegram/webhook/:token', async (req, res) => {
  const token = req.params.token;
  // ensure token is one of allowed bot tokens (order or balance or help)
  const allowed = [CFG.BOT_ORDER_TOKEN, CFG.BOT_BALANCE_TOKEN, CFG.BOT_LOGIN_REPORT_TOKEN, CFG.BOT_HELP_TOKEN].filter(Boolean);
  if(!allowed.includes(token)) {
    return res.status(403).json({ ok:false, error:'forbidden' });
  }

  const body = req.body || {};
  try {
    // Telegram updates may have message or edited_message
    const message = body.message || body.edited_message || null;
    if(!message) {
      return res.json({ ok:true, info:'no message' });
    }

    // if admin replied to a bot message:
    if(message.reply_to_message && message.reply_to_message.message_id) {
      const replyToId = message.reply_to_message.message_id;
      const chatId = message.chat && (message.chat.id || message.chat.username) ? message.chat.id : null;
      const text = (message.text || message.caption || '').trim();

      // Try to find matching charge first, then order
      // charges
      const { data: foundCharges } = await supabase.from('charges').select('*').eq('telegram_message_id', replyToId).limit(1).maybeSingle();
      if(foundCharges) {
        const charge = foundCharges;
        // parse amount from admin reply
        const amountMatch = (text.match(/[\d\.,]+/) || [null])[0];
        let amount = null;
        if(amountMatch) {
          amount = parseFloat(amountMatch.replace(/,/g, '.'));
        }
        // if amount found -> credit user and mark charge approved
        if(amount && amount > 0) {
          // update profile balance
          const { data: profile } = await supabase.from('profiles').select('*').eq('personal_number', charge.personal_number).maybeSingle();
          if(profile) {
            const newBalance = Number(profile.balance || 0) + Number(amount);
            await supabase.from('profiles').update({ balance: newBalance, topup_total: (Number(profile.topup_total || 0) + Number(amount)) }).eq('personal_number', profile.personal_number);
            // update charge row
            await supabase.from('charges').update({ status: 'approved', telegram_message_id: replyToId, paid_amount: amount }).eq('id', charge.id);
            // add notification
            await supabase.from('notifications').insert({
              id: Date.now()+Math.floor(Math.random()*1000),
              personal_number: profile.personal_number,
              text: `تم اضافة ${amount} ل.س إلى رصيدك من قبل الإدارة.`,
              read: false
            });
            // reply to admin to confirm
            try{
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method:'POST',
                headers:{'content-type':'application/json'},
                body: JSON.stringify({ chat_id: chatId, text: `تم اضافة ${amount} ل.س لرصيد المستخدم (${profile.personal_number}).` })
              });
            }catch(e){ console.warn('telegram reply error', e); }
            return res.json({ ok:true, action:'credited', amount });
          } else {
            return res.json({ ok:false, error:'profile_not_found' });
          }
        } else {
          // no amount parsed — just mark approved without credit (admin may have processed externally)
          await supabase.from('charges').update({ status: 'approved', telegram_message_id: replyToId }).eq('id', charge.id);
          // optionally notify
          const { data: profile } = await supabase.from('profiles').select('*').eq('personal_number', charge.personal_number).maybeSingle();
          if(profile) {
            await supabase.from('notifications').insert({
              id: Date.now()+Math.floor(Math.random()*1000),
              personal_number: profile.personal_number,
              text: `تمت معالجة طلب شحن (${charge.id}) من قبل الإدارة.`,
              read: false
            });
            try{
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method:'POST',
                headers:{'content-type':'application/json'},
                body: JSON.stringify({ chat_id: chatId, text: `تم وضع حالة 'مقبول' لطلب الشحن ${charge.id} (لم يُذكر مبلغ).` })
              });
            }catch(e){}
          }
          return res.json({ ok:true, action:'approved_no_amount' });
        }
      } // end foundCharges

      // orders
      const { data: foundOrders } = await supabase.from('orders').select('*').eq('telegram_message_id', replyToId).limit(1).maybeSingle();
      if(foundOrders){
        const order = foundOrders;
        const amountMatch = (text.match(/[\d\.,]+/) || [null])[0];
        let amount = null;
        if(amountMatch) amount = parseFloat(amountMatch.replace(/,/g, '.'));

        // if order is supposed to give credit to user (some flows credit after admin replies), handle similarly:
        if(amount && amount > 0) {
          const { data: profile } = await supabase.from('profiles').select('*').eq('personal_number', order.personal_number).maybeSingle();
          if(profile) {
            const newBalance = Number(profile.balance || 0) + Number(amount);
            await supabase.from('profiles').update({ balance: newBalance }).eq('personal_number', profile.personal_number);
            // update order status
            await supabase.from('orders').update({ status: 'completed', replied: true }).eq('id', order.id);
            await supabase.from('notifications').insert({
              id: Date.now()+Math.floor(Math.random()*1000),
              personal_number: profile.personal_number,
              text: `تمت معالجة طلبك (${order.id}) وإضافة ${amount} ل.س إلى رصيدك.`,
              read: false
            });
            try{
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method:'POST',
                headers:{'content-type':'application/json'},
                body: JSON.stringify({ chat_id: chatId, text: `تم اضافة ${amount} ل.س للمستخدم ${profile.personal_number} بناء على الرد.` })
              });
            }catch(e){}
            return res.json({ ok:true, action:'order_credited', amount });
          }
        } else {
          // mark as replied/processed
          await supabase.from('orders').update({ replied: true, status: 'processing' }).eq('id', order.id);
          try{
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method:'POST',
              headers:{'content-type':'application/json'},
              body: JSON.stringify({ chat_id: chatId, text: `تم وضع حالة 'قيد المعالجة' للطلب ${order.id}.` })
            });
          }catch(e){}
          return res.json({ ok:true, action:'order_processing' });
        }
      } // end foundOrders

      // no matching record found
      return res.json({ ok:true, info:'no matching charge/order for reply_to_message_id' });
    } // end if reply_to_message

    // Other message types: just ack
    return res.json({ ok:true, info:'no action' });
  } catch (err) {
    console.error('telegram webhook error', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

// ----------------- debug / health -----------------
app.get('/api/debug/health', async (req, res) => {
  res.json({ ok:true, now: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Supabase-backed server running on port ${PORT}`);
});
