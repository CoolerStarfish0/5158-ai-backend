# Axon GitHub agent setup

The in-chat GitHub agent uses the backend endpoint `/api/agent`. It does not use Work Mode or run commands on the visitor's computer.

## One-time secret setup

1. In GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens** and generate a token.
2. Set the resource owner to `CoolerStarfish0` and restrict repository access to only:
   - `my-ai`
   - `5158-ai-backend`
3. Grant **Contents: Read and write** and leave **Metadata: Read-only**. Set an expiry date.
4. In Vercel, open the backend project `5158-ai-backendpriv` → **Settings → Environment Variables**.
5. Add `GITHUB_TOKEN` with the token value. Select Production (and Preview only if needed), save, and redeploy.
6. Optionally set `GITHUB_ALLOWED_REPOS` to `CoolerStarfish0/my-ai,CoolerStarfish0/5158-ai-backend`.

**Never put the token in frontend files, commit it to GitHub, or paste it into an Axon chat.** It belongs only in the backend's encrypted environment variables. If the secret is missing, Axon returns a configuration error instead of pretending the GitHub tool worked.

## Safety behavior

- Every request verifies the Firebase ID token and checks the server-side `OWNER_UID`.
- The backend restricts operations to the allowlisted repositories.
- Supported tools include listing files, reading files, code search with excerpts, creating files, updating files, and exact-match patches.
- Every write requires explicit confirmation in the Axon chat UI.
- Exact-match patches require a current file SHA and a unique match; stale files or ambiguous patches are rejected.
- Workflow files and likely secret files are blocked from these tools.
- Writes currently commit directly to the repository's default branch after confirmation. Review the path, commit message, and preview carefully before approving.

## Google and unified autonomous agent

The visible Axon Work Mode panel has been replaced with a unified agent panel. GitHub repository actions and configured Google actions run through normal chat. Optional local computer access remains a separately approved capability inside that same panel.

For Google OAuth, follow [GOOGLE_AGENT_SETUP.md](./GOOGLE_AGENT_SETUP.md). The Google endpoint requires these server-side variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `AXON_FRONTEND_URL`, and the existing `OWNER_UID` and `FIREBASE_SERVICE_ACCOUNT`.

Google OAuth and API operations are not ready for live use until those variables are configured and the connected Google account authorizes the scopes. The agent does not have Google Sites editing support in this API pass.
