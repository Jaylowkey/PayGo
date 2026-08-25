(()=>{
const pages={
'dashboard.html':['Dashboard','layout-dashboard','Principal'],'relatorios.html':['Relatórios','bar-chart-3','Principal'],'clientes.html':['Clientes','users','Operações'],'pedidos.html':['Pedidos','shopping-bag','Operações'],'payout.html':['Payouts','send','Operações'],'cartoes.html':['Cartões','credit-card','Operações'],'gerar-fatura.html':['Faturas','file-text','Operações'],'afiliados.html':['Afiliados','users-round','Ecossistema'],'candidaturas.html':['Candidaturas','badge-check','Ecossistema'],'logs.html':['Transações & Logs','activity','Ecossistema'],'logs-admin.html':['Auditoria Admin','shield-check','Ecossistema'],'configuracoes.html':['Configurações','settings','Sistema'],'admin.html':['Administradores','user-cog','Sistema'],'mensagem.html':['Mensagens','message-square','Ecossistema']};
const file=location.pathname.split('/').pop()||'dashboard.html'; const groups=['Principal','Operações','Ecossistema','Sistema'];
function icon(n){return `<i data-lucide="${n}"></i>`}
function ensureTheme(){
 if(document.querySelector('link[data-paygo-admin-theme]'))return;
 const link=document.createElement('link');link.rel='stylesheet';link.href='admin-theme.css';link.dataset.paygoAdminTheme='true';document.head.appendChild(link);
}
function enhanceSettings(){
 if(file!=='configuracoes.html'||document.querySelector('#paygoNewSettings'))return;
 const main=document.querySelector('main');if(!main)return;
 const section=document.createElement('section');section.id='paygoNewSettings';section.className='pg-settings-extra';
 section.innerHTML=`<div class="pg-settings-head"><div><div class="pg-kicker">Novas funcionalidades</div><h2>Centro de controlo PayGo</h2><p>Ative ou desative módulos operacionais e acompanhe rapidamente o estado das áreas críticas.</p></div><span class="pg-settings-live"><span></span> Sistema operacional</span></div><div class="pg-feature-grid"><a class="pg-feature" href="payout.html"><span class="pg-feature-icon"><i data-lucide="send"></i></span><span><b>Payouts</b><small>Envios M-Pesa, e-Mola, mKesh e B2C.</small></span><em>Ativo</em></a><a class="pg-feature" href="cartoes.html"><span class="pg-feature-icon"><i data-lucide="credit-card"></i></span><span><b>Cartões virtuais</b><small>Gestão, aprovação e acompanhamento de cartões.</small></span><em>Ativo</em></a><a class="pg-feature" href="clientes.html"><span class="pg-feature-icon"><i data-lucide="user-check"></i></span><span><b>KYC / Clientes</b><small>Controlo de clientes e validações administrativas.</small></span><em>Ativo</em></a><a class="pg-feature" href="afiliados.html"><span class="pg-feature-icon"><i data-lucide="network"></i></span><span><b>Afiliados</b><small>Comissões, membros e desempenho da rede.</small></span><em>Ativo</em></a><a class="pg-feature" href="logs-admin.html"><span class="pg-feature-icon"><i data-lucide="shield-check"></i></span><span><b>Auditoria</b><small>Registo das ações administrativas e segurança.</small></span><em>Ativo</em></a><a class="pg-feature" href="logs.html"><span class="pg-feature-icon"><i data-lucide="activity"></i></span><span><b>Monitorização</b><small>Transações, estados e eventos operacionais.</small></span><em>Ativo</em></a></div><div class="pg-settings-controls"><div><b>Controles administrativos</b><small>Preferências locais da interface deste dispositivo.</small></div><label class="pg-control"><span>Confirmação extra para operações financeiras</span><input id="pgConfirmFinancial" type="checkbox"><i></i></label><label class="pg-control"><span>Alertas visuais para operações críticas</span><input id="pgCriticalAlerts" type="checkbox"><i></i></label><label class="pg-control"><span>Atualização automática do painel</span><input id="pgAutoRefresh" type="checkbox"><i></i></label></div>`;
 main.appendChild(section);
 const defaults={pgConfirmFinancial:true,pgCriticalAlerts:true,pgAutoRefresh:false};
 Object.entries(defaults).forEach(([id,value])=>{const el=document.getElementById(id);if(!el)return;const saved=localStorage.getItem('paygo_'+id);el.checked=saved===null?value:saved==='1';el.addEventListener('change',()=>localStorage.setItem('paygo_'+id,el.checked?'1':'0'));});
 if(window.lucide)lucide.createIcons();
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
 enhanceSettings();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',shell);else shell();
})();
