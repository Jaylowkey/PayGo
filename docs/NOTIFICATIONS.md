# PayGo Notifications & Marketing Engine

## Arquitetura atual

O PayGo utiliza um **router único em 'api/[[...slug]].js'** para os endpoints transacionais de email/notificações.

Os ficheiros físicos abaixo **não são endpoints independentes** e não devem ser recriados enquanto estas rotas permanecerem no slug:

- 'api/send-email.js'
- 'api/notify-order.js'
- 'api/recover-password.js'
- 'api/verify-email.js'

As quatro funcionalidades estão implementadas diretamente no router através de:

- 'handleSendEmail'
- 'handleNotifyOrder'
- 'handleRecoverPassword'
- 'handleVerifyEmail'

E estão registadas no mapa 'routes' como:

- 'send-email' → 'handleSendEmail'
- 'notify-order' → 'handleNotifyOrder'
- 'recover-password' → 'handleRecoverPassword'
- 'verify-email' → 'handleVerifyEmail'

Portanto, os caminhos públicos continuam:

NaN
NaN
NaN
NaN

O Vercel resolve estes caminhos através de 'api/[[...slug]].js'.

## Estado verificado

### 1. 'POST /api/send-email'

Handler: 'handleSendEmail'

Função:
- envia emails transacionais usando Resend;
- aceita 'to', 'subject', 'template', 'variables', 'type' e 'sendLark';
- gera HTML e texto através dos templates centralizados;
- usa 'FROM_EMAIL';
- suporta notificação opcional via Lark.

Templates atualmente suportados pelo router incluem:
- 'order-confirmation'
- 'payment-confirmed'
- 'order-processing'
- 'order-completed'
- 'password-reset'
- 'email-verification'
- 'welcome'
- template genérico.

### 2. 'POST /api/notify-order'

Handler: 'handleNotifyOrder'

Função:
- envia notificações relacionadas com pedidos;
- suporta email;
- suporta Lark quando configurado;
- ações atualmente tratadas: 'payment_confirmed', 'order_refunded', 'insufficient_funds' e 'new_order' (default).

### 3. 'POST /api/recover-password'

Handler: 'handleRecoverPassword'

Fluxo:
1. recebe o email;
2. gera o link oficial de recuperação através do Firebase Admin;
3. extrai o 'oobCode';
4. transforma-o no link PayGo: '/seguranca.html?mode=resetPassword&oobCode=...';
5. envia o email através do Resend.

Requer:
- 'FIREBASE_SERVICE_ACCOUNT'
- 'RESEND_API_KEY'

### 4. 'POST /api/verify-email'

Handler: 'handleVerifyEmail'

Fluxo:
1. recebe email e nome opcional;
2. gera o link oficial de verificação através do Firebase Admin;
3. extrai o 'oobCode';
4. cria o link PayGo: '/seguranca.html?mode=verifyEmail&oobCode=...';
5. envia o email através do Resend.

Requer:
- 'FIREBASE_SERVICE_ACCOUNT'
- 'RESEND_API_KEY'

## Variáveis de ambiente

Configurar no Vercel Production:
- 'FIREBASE_SERVICE_ACCOUNT' — credencial JSON do Firebase Admin.
- 'RESEND_API_KEY' — chave da Resend.
- 'FROM_EMAIL' — remetente dos emails; fallback atual: 'PayGo Moçambique <noreply@paygo.co.mz>'.
- 'SITE_URL' — URL principal do PayGo; fallback atual: 'https://paygo.co.mz'.
- 'LARK_WEBHOOK_URL' — opcional, para notificações internas via Lark.
- 'WHATSAPP_SUPPORT_NUMBER' — opcional, usado nos links de suporte dos emails.

**Nunca colocar credenciais de servidor no HTML/JavaScript do Admin ou no frontend público.**

## Relação com Marketing

O marketing usa uma arquitetura separada:
- 'admin/marketing.html' cria campanhas em 'marketingCampaigns';
- campanhas podem ficar em 'draft', 'queued', 'scheduled', 'cancelled' ou 'sent';
- 'api/marketing-worker.js' processa campanhas 'queued' e campanhas 'scheduled' cujo horário chegou;
- o worker usa credenciais server-side e não deve ser chamado diretamente pelo frontend;
- no Vercel Hobby, o cron atual está configurado para execução diária.

O worker de marketing **não substitui** os quatro handlers transacionais acima.

## Firestore

Coleções utilizadas pela arquitetura:
- 'notifications' — notificações in-app.
- 'notificationTemplates' — templates/configuração de notificações.
- 'marketingCampaigns' — campanhas de marketing.
- 'wallet_transactions' — transações da carteira relacionadas a outras operações.
- 'admin_audit_logs' — auditoria administrativa.
- 'webhook_logs' — auditoria de webhooks.

## Endpoints antigos que NÃO fazem parte da arquitetura atual

A documentação antiga mencionava:
- 'POST /api/notifications/dispatch'
- 'POST /api/notifications/process'
- 'POST /api/marketing/send'

Esses endpoints **não correspondem ao router atual** e foram removidos da documentação operacional para evitar que alguém tente integrá-los.

Para marketing, use o fluxo atual de 'marketingCampaigns' + 'api/marketing-worker.js'.

## Nota de segurança

Os handlers 'send-email', 'notify-order', 'recover-password' e 'verify-email' atualmente validam método e payload, mas não fazem uma autorização administrativa genérica no próprio router.

Isso é intencional para permitir fluxos transacionais do site, mas significa que o frontend não deve expor estes endpoints como uma ferramenta livre de envio. Recomenda-se manter:
- validação rigorosa dos destinatários e payloads;
- rate limiting/anti-abuso;
- proteção adicional para qualquer uso administrativo;
- credenciais Resend/Firebase exclusivamente no servidor.

O router já utiliza Firebase Admin server-side e as chaves de fornecedor não devem ser enviadas pelo cliente.

## Regra para manutenção

Se for necessário alterar email, recuperação de senha ou verificação de email:
1. editar o handler correspondente em 'api/[[...slug]].js';
2. confirmar a entrada no objeto 'routes';
3. não criar novamente um ficheiro físico com o mesmo caminho;
4. atualizar esta documentação se o contrato do endpoint mudar;
5. fazer deploy e verificar os logs do Vercel.

Assim evitamos funções Serverless duplicadas e mantemos o limite de funções do Vercel sob controlo.