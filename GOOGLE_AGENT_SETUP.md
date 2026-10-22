# Axon Google integrations — one-time setup

This adds a server-side Google OAuth connection for Axon's owner account. The browser never receives the Google client secret or stored refresh token.

## Google Cloud setup

1. Open https://console.cloud.google.com/ and select or create a project.
2. Enable these APIs in **APIs & Services → Library**:
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Forms API
   - Google Classroom API
   - Google Calendar API
   - Gmail API
3. Configure **Google Auth Platform / OAuth consent screen**. For an initial test, use External + Testing if applicable, and add the Google account you will connect as a test user. Google may require verification or additional review before broad public use because some requested scopes are sensitive/restricted.
4. Create an OAuth client ID of type **Web application**.
5. Add this exact authorized redirect URI:
   `https://5158-ai-backendpriv.vercel.app/api/agent?mode=google&action=callback`
6. Copy the OAuth Client ID and Client Secret. Do not put either in frontend files or chat.

## Vercel environment variables

Open Vercel → project `5158-ai-backendpriv` → Settings → Environment Variables.

**Already configured in Production by the Axon implementation pass:**
- `GOOGLE_REDIRECT_URI` = `https://5158-ai-backendpriv.vercel.app/api/agent?mode=google&action=callback`
- `AXON_FRONTEND_URL` = `https://coolerstarfish0.github.io/my-ai/`
- `GOOGLE_TOKEN_ENCRYPTION_KEY` = generated and stored as a secret. **Do not overwrite, regenerate, or share this key.**
- `OWNER_UID` and `FIREBASE_SERVICE_ACCOUNT` already exist in the Production environment.

**You must add these two values from your Google Cloud OAuth client:**
- `GOOGLE_CLIENT_ID` = OAuth client ID
- `GOOGLE_CLIENT_SECRET` = OAuth client secret

Set both to Production (and Preview only if you intentionally want to test Preview deployments). Do not paste either secret into chat or frontend files.

After adding the two values, save and redeploy the backend. Keep the existing encryption key stable; if it is ever lost or changed, existing encrypted Google refresh tokens cannot be decrypted and you will need to reconnect Google.

## What currently works in this first integration pass

Once the backend is configured and Google is connected, the API supports:
- Search Google Drive file names (read-only).
- List active Google Classroom courses and retrieve a roster when the account has permission.
- Read Google Docs, append text, and replace one verified unique text occurrence.
- Create Google Docs with text.
- Read spreadsheet ranges, create Sheets, and update selected ranges.
- Read existing Google Forms, create Forms, and add multiple-choice questions.
- List upcoming Calendar events and create Calendar events.
- Create Gmail drafts (drafts are not sent; sending is not implemented in this pass).

The frontend agent must ask for confirmation before creating or changing content. Sending Gmail messages is deliberately not implemented in this first pass.

## Important limitations

- Google Classroom roster access depends on the connected account's role and school-admin policies.
- Google Forms/Drive/Docs access may be restricted by Workspace policies or OAuth consent-screen status.
- Google Sites does not have a general-purpose modern site-editing API comparable to Docs/Sheets. Sites editing needs a separate supported browser-automation route; this endpoint does not claim to edit Sites.
- OAuth consent may require Google's verification for production use. Testing mode is appropriate for initial owner-only testing.
- The endpoint restricts the Google integration to the configured owner Firebase UID.
- Tokens are encrypted at rest using AES-256-GCM before being stored in Firestore. Keep the encryption key private and stable.
- This is not fully tested until the environment variables, Google OAuth client, APIs, and real account authorization are configured.

## Troubleshooting

- `Google OAuth isn't configured yet`: add the client ID and secret to Vercel and redeploy.
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: generate a valid 32-byte key as described above.
- `Google is not connected`: use Connect Google in Axon and finish the consent screen.
- `access_denied` or an unverified-app warning: check the OAuth consent screen and test-user list.
- Classroom 403: the API may not be enabled, or the account may not be allowed to view that class roster.


Implementation note: Google OAuth and actions are dispatched through the existing `/api/agent?mode=google&action=...` route so the backend does not add another Vercel Serverless Function. The production callback URL has already been updated to match this route.
