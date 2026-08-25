(()=>{
const pages={
'dashboard.html':['Dashboard','layout-dashboard','Principal'],'relatorios.html':['Relatórios','bar-chart-3','Principal'],'clientes.html':['Clientes','users','Operações'],'pedidos.html':['Pedidos','shopping-bag','Operações'],'payout.html':['Payouts','send','Operações'],'cartoes.html':['Cartões','credit-card','Operações'],'gerar-fatura.html':['Faturas','file-text','Operações'],'afiliados.html':['Afiliados','users-round','Ecossistema'],'candidaturas.html':['Candidaturas','badge-check','Ecossistema'],'logs.html':['Transações & Logs','activity','Ecossistema'],'logs-admin.html':['Auditoria Admin','shield-check','Ecossistema'],'configuracoes.html':['Configurações','settings','Sistema'],'admin.html':['Administradores','user-cog','Sistema'],'mensagem.html':['Mensagens','message-square','Ecossistema']};
const file=location.pathname.split('/').pop()||'dashboard.html'; const groups=['Principal','Operações','Ecossistema','Sistema'];
function icon(n){return `<i data-lucide="${n}"></i>`}
function ensureTheme(){
 if(document.querySelector('link[data-paygo-admin-theme]'))return;
 const link=document.createElement('link');link.rel='stylesheet';link.href='admin-theme.css';link.dataset.paygoAdminTheme='true';document.head.appendChild(link);
}
function shell(){
 ensureTheme();
 const old=document.querySelector('aside'); if(!old)return;
 const labels={Principal:['dashboard.html','relatorios.html'],Operações:['clientes.html','pedidos.html','payout.html','cartoes.html','gerar-fatura.html'],Ecossistema:['afiliados.html','candidaturas.html','logs.html','logs-admin.html','mensagem.html'],Sistema:['configuracoes.html','admin.html']};
 let nav=''; groups.forEach(g=>{nav+=`<div class="pg-label">${g}</div>`;labels[g].forEach(p=>{const d=pages[p];if(!d)return;nav+=`<a class="pg-item ${p===file?'active':''}" href="${p}">${icon(d[1])}<span>${d[0]}</span></a>`})});
 const aside=document.createElement('aside');aside.id='sidebar';aside.className='pg-sidebar';aside.innerHTML=`<div class="pg-brand"><div class="pg-brand-mark">⚡</div><div><div class="pg-brand-title">PayGo</div><div class="pg-brand-sub">Admin Financeiro</div></div></div><nav class="pg-nav">${nav}</nav><div class="pg-footer"><a class="pg-item" href="../index.html">${icon('arrow-left')}<span>Voltar ao PayGo</span></a></div>`;old.replaceWith(aside);
 const main=document.querySelector('main');if(main){main.classList.add('pg-main')}
 let overlay=document.getElementById('pgOverlay');if(!overlay){overlay=document.createElement('div');overlay.id='pgOverlay';overlay.className='pg-overlay';document.body.prepend(overlay)}
 let menu=document.getElementById('menu');if(!menu){menu=document.createElement('button');menu.id='menu';menu.className='pg-menu';menu.innerHTML=icon('menu');const h=document.querySelector('header');if(h)h.prepend(menu)}
 menu.onclick=()=>{aside.classList.add('open');overlay.classList.add('open')};overlay.onclick=()=>{aside.classList.remove('open');overlay.classList.remove('open')};
 if(window.lucide)lucide.createIcons();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',shell);else shell();
})();
