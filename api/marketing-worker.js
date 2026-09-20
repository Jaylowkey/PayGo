import { Resend } from 'resend';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'PayGo Moçambique <noreply@paygo.co.mz>';
const BATCH = Math.max(1, Number(process.env.MARKETING_BATCH_SIZE || 100));

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
  try { return getFirestore(getApps()[0], 'paygodb'); } catch { return getFirestore(); }
}
function auth(req) { return !!process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`; }
function vars(s,u={}) {
  const firstName=u.firstName||u.first_name||u.name?.split?.(' ')?.[0]||'Cliente';
  const name=u.name||u.displayName||firstName;
  const balance=u.balance??u.walletBalance??u.wallet?.balance??0;
  return String(s||'').replace(/{{\s*firstName\s*}}/gi,String(firstName)).replace(/{{\s*name\s*}}/gi,String(name)).replace(/{{\s*balance\s*}}/gi,String(balance));
}
function audience(u,a) {
  if(a==='all') return true;
  const status=String(u.status||'').toLowerCase();
  const balance=Number(u.balance??u.walletBalance??u.wallet?.balance??0);
  if(a==='active') return ['active','verified'].includes(status)||u.active===true||u.emailVerified===true;
  if(a==='wallet') return balance>0;
  if(a==='affiliate') return !!(u.affiliateCode||u.affiliate_code||u.referralCode||u.isAffiliate);
  return true;
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
async function email(to,subject,body,id){
  if(!resend) return false;
  const r=await resend.emails.send({from:FROM_EMAIL,to:[to],subject,html:`<div style="max-width:620px;margin:auto;padding:32px;font-family:Arial;color:#0f172a"><b style="font-size:28px;color:#2563eb">PayGo</b><p style="white-space:pre-wrap;line-height:1.7">${esc(body)}</p><hr><small>PayGo Moçambique · contact@paygo.co.mz</small></div>`,text:body,headers:{'X-PayGo-Campaign':id}});
  return !r.error;
}
async function runCampaign(database,ref){
  const c=ref.data()||{}, id=ref.id, channels=Array.isArray(c.channels)?c.channels:['in_app'], aud=c.audience||'all';
  let sent=Number(c.stats?.sent||0), delivered=Number(c.stats?.delivered||0), failed=Number(c.stats?.failed||0);
  let q=database.collection('users').orderBy(FieldPath.documentId()).limit(BATCH);
  if(c.workerCursor) q=q.startAfter(c.workerCursor);
  const snap=await q.get();
  if(snap.empty){await ref.ref.update({status:'sent',completedAt:FieldValue.serverTimestamp(),stats:{...c.stats,sent,delivered,failed}});return {id,status:'sent'};}
  let cursor=snap.docs[snap.docs.length-1].id;
  for(const d of snap.docs){
    const u=d.data()||{}; cursor=d.id;
    if(!audience(u,aud)) continue;
    const title=vars(c.title||c.subject||'PayGo',u), body=vars(c.message||c.body||'',u);
    let ok=0, bad=0;
    if(channels.includes('in_app')) try{await database.collection('notifications').add({userId:d.id,uid:d.id,type:'marketing',campaignId:id,title,body,message:body,read:false,createdAt:FieldValue.serverTimestamp(),metadata:{audience:aud,channels}});ok++;delivered++;}catch{bad++;}
    if(channels.includes('email')) { const to=u.email||u.emailAddress; if(to && await email(to,vars(c.subject||c.title||'Notificação PayGo',u),body,id)) ok++; else bad++; }
    // Push/WhatsApp are not faked; count them as unavailable until providers are configured.
    bad += channels.filter(x=>x==='push'||x==='whatsapp').length;
    sent+=ok; failed+=bad;
  }
  const more=snap.size===BATCH;
  await ref.ref.update({status:more?'queued':'sent',workerCursor:more?cursor:FieldValue.delete(),completedAt:more?FieldValue.delete():FieldValue.serverTimestamp(),stats:{...c.stats,sent,delivered,failed,processed:sent+failed},lastProcessedAt:FieldValue.serverTimestamp()});
  return {id,status:more?'queued':'sent',processed:snap.size};
}
export default async function handler(req,res){
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
  try{
    const database=db(), now=Timestamp.now(), results=[];
    const queued=await database.collection('marketingCampaigns').where('status','==','queued').limit(10).get();
    for(const d of queued.docs) results.push(await runCampaign(database,d));
    const scheduled=await database.collection('marketingCampaigns').where('status','==','scheduled').where('scheduleAt','<=',now).limit(10).get();
    for(const d of scheduled.docs){await d.ref.update({status:'queued',queuedAt:FieldValue.serverTimestamp()});results.push(await runCampaign(database,d));}
    res.status(200).json({ok:true,processed:results.length,results,at:new Date().toISOString()});
  }catch(e){console.error('[marketing-worker]',e);res.status(500).json({error:'Marketing worker failed',message:e.message});}
}