# PayGo Notifications & Marketing Engine

## Backend secrets

Configure these variables in the Vercel Production environment:

- `FIREBASE_SERVICE_ACCOUNT` — Firebase Admin service account JSON.
- `PAYGO_NOTIFICATION_SECRET` — long random secret used by internal notification endpoints.
- `RESEND_API_KEY` — already used by the PayGo email service.
- `PAYGO_FROM_EMAIL` — optional sender, defaults to `PayGo Moçambique <noreply@paygo.co.mz>`.
- `WHATSAPP_API_URL` — optional WhatsApp provider endpoint.
- `WHATSAPP_API_TOKEN` — optional WhatsApp provider bearer token.
- `FIREBASE_FCM_SERVER_KEY` — optional FCM legacy server key for push delivery.

Never put these values in the Admin HTML/JavaScript.

## Endpoints

### Internal event

`POST /api/notifications/dispatch`

Header:

`X-PayGo-Notification-Secret: <PAYGO_NOTIFICATION_SECRET>`

Body example:

```json
{
  "userId": "firebase-user-id",
  "event": "payment_success",
  "data": { "amount": "1500", "reference": "PG-123" }
}
```

### Process scheduled campaigns

`POST /api/notifications/process`

This processes scheduled campaigns whose `scheduleAt` is due. It is intentionally protected by the internal secret so it can later be called by a trusted scheduler.

### Send a campaign

`POST /api/marketing/send`

Body:

```json
{ "campaignId": "campaign-document-id" }
```

Also protected by the internal secret.

## Firestore collections

- `settings/notifications` — global channel preferences and event routing.
- `notificationTemplates` — active event/channel templates.
- `notifications` — in-app notifications.
- `notificationDeliveries` — delivery/audit records.
- `marketingCampaigns` — campaign definitions and aggregate counters.

## Delivery model

The browser creates configuration and campaign records only. Provider credentials stay server-side. The backend resolves templates, recipient preferences, channel routing and provider delivery.

For high-volume campaigns the current implementation intentionally caps a single processing pass at 500 recipients. A queue/worker can replace this limit later without changing the Admin data model.
