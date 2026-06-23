# F5 XC Namespace Audit

A security audit tool for F5 Distributed Cloud (XC) HTTP Load Balancers. It compares LB configurations against a configurable security baseline and reports findings with detailed pass/fail/skip results.

Two deployment options are available:

| | Browser Extension | Standalone Webapp |
|---|---|---|
| **Auth method** | Browser session cookies (zero config) | API token or p12 client certificate |
| **Scope** | One namespace at a time, inline in the XC console | Multi-namespace batch audits with tenant management |
| **Report** | Generate from cached session data | Generate on demand via the server |
| **Install** | Load unpacked in Chrome/Edge | `npm install` + `node server.js` |

---

## Table of Contents

- [Browser Extension](#browser-extension)
  - [Prerequisites](#extension-prerequisites)
  - [Installation](#extension-installation)
  - [Running](#running-the-extension)
  - [Authentication](#extension-authentication)
- [Standalone Webapp](#standalone-webapp)
  - [Prerequisites](#webapp-prerequisites)
  - [Installation](#webapp-installation)
  - [Configuration](#webapp-configuration)
  - [Running](#running-the-webapp)
  - [Authentication](#webapp-authentication)
  - [Tenant Management](#tenant-management)
  - [Running Audits](#running-audits-webapp)
- [Audit Checks](#audit-checks)
- [Label-Based Exemptions](#label-based-exemptions)
- [Baseline LB Override](#baseline-lb-override)
- [Service Policy Baseline](#service-policy-baseline)
- [Settings (Extension)](#settings-extension)
- [HTML Report](#html-report)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Project Structure](#project-structure)

---

## Browser Extension

### Extension Prerequisites

- **Chrome** (v88+) or **Edge** (v88+) with Manifest V3 support
- An active F5 Distributed Cloud account with console access

No build tools, Node.js, or other dependencies are required. The extension runs directly from source.

### Extension Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/GlenWillms/xc-audit-tools.git
   ```
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the cloned repository folder
5. The extension icon appears in the browser toolbar

To update the extension after pulling new changes, go to `chrome://extensions` and click the refresh icon on the extension card, or press `Cmd+Shift+U` (Mac) / `Ctrl+Shift+U` (Windows).

### Running the Extension

1. Log in to the F5 XC console at `https://<tenant>.console.ves.volterra.io`
2. Navigate to **Multi-Cloud App Connect > HTTP Load Balancers** in any namespace
3. The extension automatically audits each LB and injects pass/fail badges inline next to each LB name
4. Click a badge to expand the detail row showing passed, failed, and skipped checks
5. Click the extension icon in the toolbar to open the popup with an overall summary

### Extension Authentication

The extension uses your existing browser session — no API keys or tokens to configure. It:

1. Captures CSRF tokens from XC console network traffic via `webRequest` listeners
2. Makes API calls from the content script, sharing the page's session cookies
3. Sends the data to the background service worker for auditing against the baseline

Just log in to the XC console as usual. The extension handles the rest.

---

## Standalone Webapp

The webapp is an independent Node.js application that runs audits against one or more XC tenants without needing a browser extension or an active XC console session.

### Webapp Prerequisites

- **Node.js** v18+ (uses ES modules, built-in `fetch`, and `node:` prefixed imports)
- **npm** (included with Node.js)
- An F5 XC **API token** or **p12 client certificate** for each tenant you want to audit

### Webapp Installation

```bash
cd webapp
npm install
```

This installs Express.js, the only runtime dependency.

### Webapp Configuration

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set a strong master password:
   ```
   MASTER_PASSWORD=your-strong-password-here
   ```
   The master password is used to encrypt API tokens and p12 passwords at rest in `data/secrets.json`. Choose something strong — all stored credentials are AES-256 encrypted with this key.

3. (Optional) If using p12 certificate authentication, place your `.p12` file somewhere accessible on disk. You'll provide the absolute path when adding a tenant.

The `data/` directory is created automatically on first start. It contains:
- `tenants.json` — tenant configurations (names, namespaces, plan info)
- `secrets.json` — encrypted credentials (tokens, p12 passwords)

Both files are git-ignored by default.

### Running the Webapp

```bash
cd webapp
npm start
```

Or equivalently:
```bash
node webapp/server.js
```

The server starts at **http://127.0.0.1:3000** (localhost only — not exposed to the network).

To use a different port:
```bash
PORT=8080 npm start
```

You can also set `MASTER_PASSWORD` directly via environment variable instead of using `.env`:
```bash
MASTER_PASSWORD=your-password PORT=3000 node server.js
```

The server logs each XC API call to stdout for debugging. Press `Ctrl+C` for graceful shutdown.

### Webapp Authentication

The webapp supports two authentication methods per tenant:

#### API Token

1. In the XC console, go to **Administration > Personal Management > Credentials**
2. Create an API token (or use an existing one)
3. Copy the token value
4. When adding the tenant in the webapp, paste it into the **API Token** field

API token requests include the `Authorization: APIToken <token>` and `x-volterra-apigw-tenant` headers.

#### P12 Client Certificate

1. In the XC console, go to **Administration > Personal Management > Credentials**
2. Create or download a p12 certificate credential
3. Save the `.p12` file to a local path (e.g., `/path/to/tenant.p12`)
4. When adding the tenant in the webapp, provide:
   - **P12 Path**: the absolute path to the `.p12` file
   - **P12 Password**: the certificate password (encrypted at rest)

Either authentication method works. P12 certificates are generally preferred for long-lived automation.

### Tenant Management

Open **http://127.0.0.1:3000** in your browser after starting the server.

The **Tenants** page lets you manage which XC tenants to audit:

- **Add a parent tenant** — provide the tenant name (e.g., `acme`), credentials, and optional metadata (plan type, add-ons, credential expiry date)
- **Add managed tenants** — if you manage other tenants through your parent tenant, add them as children. They inherit the parent's credentials and are accessed via the `/managed_tenant/` API prefix.
- **Discover managed tenants** — click the discover button to auto-detect managed tenants linked to your account
- **Edit / delete** — update credentials, metadata, or remove tenants

The console suffix defaults to `console.ves.volterra.io`. Override it if your tenant uses a custom domain.

### Running Audits (Webapp)

1. Navigate to the **Audit** page
2. Select a tenant (parent or managed)
3. Choose which namespaces to audit, or click **Select All**
4. Click **Run Audit**

The audit streams progress via Server-Sent Events (SSE) as each namespace is processed. When complete, you can:

- View the results inline
- Generate and download an HTML report

The audit checks the same baseline as the extension (LB security settings, service policies, tenant-level settings) and produces the same report format.

---

## Audit Checks

### Load Balancer Checks

| Category | Check | Baseline Expectation |
|----------|-------|---------------------|
| **TLS & Encryption** | TLS / HSTS | HTTPS with HSTS enabled (auto-cert or manual) |
| **Web Application Firewall** | App Firewall | A named WAF policy is applied (configurable) |
| **DDoS Protection** | DDoS Mitigation Rules | Present (empty rules = no custom rules) |
| **DDoS Protection** | L7 DDoS Protection | Mitigation block with default thresholds |
| **API Security** | API Discovery | Enabled |
| **API Security** | API Definition | Disabled (unless exempted) |
| **API Security** | API Testing | Disabled (unless exempted) |
| **Bot & Client Protection** | Bot Defense | Disabled (unless exempted) |
| **Bot & Client Protection** | Client-Side Defense | Disabled (unless exempted) |
| **Bot & Client Protection** | IP Reputation | Disabled (unless exempted) |
| **Policy & Data** | Service Policies | Inherited from namespace |
| **Policy & Data** | Sensitive Data Policy | Default policy applied |
| **Policy & Data** | Trust Client IP Headers | Disabled |

All load balancer checks can be toggled on/off in the extension Settings page.

### Tenant-Level Checks (Report Only)

| Check | What It Verifies |
|-------|-----------------|
| **SSO Enabled** | Single Sign-On is configured for the tenant |
| **MFA Enforced** | Multi-factor authentication is enforced for all users |
| **Custom Password Policy** | A custom password policy is configured |
| **Global Log Receiver** | At least one global log receiver is configured for audit/security log archival |

These checks appear in the report's Tenant Security Settings section, executive summary, and recommendations. In the extension, they are not shown in the inline overlay badges.

---

## Label-Based Exemptions

Not every LB needs every security feature. Instead of maintaining separate baselines, exempt specific checks per LB using XC labels.

### How to Use

1. In the XC console, add a label to the LB object:
   - **Key**: `xc-audit-ignore-apid`
   - **Value**: `true`
2. The audit skips the API Discovery check for that LB
3. The badge shows the skip count, e.g., `PASS (11 passed, 1 skipped)`
4. The detail row lists which checks were skipped and the label that triggered it

### Available Exemption Codes

| Label Key | Skipped Check |
|-----------|---------------|
| `xc-audit-ignore-apid=true` | API Discovery |
| `xc-audit-ignore-apip=true` | API Protection (Definition + Testing) |
| `xc-audit-ignore-bot=true` | Bot Defense |
| `xc-audit-ignore-csd=true` | Client-Side Defense |
| `xc-audit-ignore-iprep=true` | IP Reputation |
| `xc-audit-ignore-sdp=true` | Sensitive Data Policy |
| `xc-audit-ignore-waf=true` | Web App Firewall |
| `xc-audit-ignore-ddos=true` | DDoS Protection |
| `xc-audit-ignore-tls=true` | TLS / HSTS |
| `xc-audit-ignore-sp=true` | Service Policies |
| `xc-audit-ignore-trustip=true` | Trust Client IP Headers |

### Registering Labels in XC

Before labels can be assigned, they must be registered as "known labels" in XC. The extension can do this for you:

1. Open the extension Settings page (click the gear icon in the popup)
2. Scroll to the **Exemption Map** section
3. Click **Register Labels in XC**

This requires an open XC console tab. Labels are registered in the `shared` namespace so they're available across all namespaces.

---

## Baseline LB Override

Instead of comparing every LB against the static baseline, point an LB at a reference LB in the `default` namespace. The reference LB defines the expected security posture.

### How It Works

1. Create a reference LB in the `default` namespace (e.g., `baseline-enterprise`)
2. On each production LB, add the label:
   - **Key**: `xc-audit-baseline-lb`
   - **Value**: the name of the reference LB (e.g., `baseline-enterprise`)
3. At audit time, the extension fetches the reference LB and runs the same checks against it
4. For each check the audited LB fails:
   - If the reference LB **also fails** that check: the finding becomes a **pass**
   - If the reference LB **passes** that check: the finding stays a **warning**

### Badge Display

LBs using a baseline LB override show:
- A `ref: baseline-enterprise` tag next to the audit badge
- Checks that passed via the reference show as green tags with "via baseline-enterprise"
- Checks that the LB fails against the reference show as normal warnings

### Notes

- The reference LB must exist in the `default` namespace
- Multiple LBs can reference the same baseline LB
- Different LBs can reference different baseline LBs
- If the referenced LB doesn't exist, the audit falls back to normal behavior
- Label-based exemptions are applied before the baseline LB override
- Changing the reference LB's configuration requires a re-audit

---

## Service Policy Baseline

By default, the audit fetches the `default` namespace's active service policies and uses them as the baseline for policy comparison.

### Per-Namespace Overrides (Extension Only)

If a specific namespace needs a different policy order:

1. Navigate to that namespace's LB list page
2. Open the extension popup
3. Expand the Service Policies section
4. Click **"Use {namespace}'s policies as baseline"**

This saves an override for that namespace. To remove it, click **"Clear override (use default)"**.

---

## Settings (Extension)

Open the settings page from the popup (click **Settings**) or right-click the extension icon and select **Options**.

| Section | Description |
|---------|-------------|
| **Baseline Checks** | Toggle individual security checks on/off |
| **App Firewall Policy Name** | Set the expected WAF policy name |
| **Namespace Service Policies** | View current policy baseline source and per-namespace overrides |
| **Exemption Map** | View/edit label-to-check mappings and register labels in XC |
| **Raw JSON** | Full baseline and explanations JSON for power users |
| **Reset All to Defaults** | Resets baseline, explanations, exemption map, settings, and clears all overrides |

---

## HTML Report

Both the extension and webapp generate the same self-contained HTML report.

### Report Contents

- **Header** — tenant logo and company name (fetched from XC tenant settings API)
- **Executive Summary** — total namespaces, LB counts, compliance percentage, per-category breakdown, tenant settings pass rate
- **OWASP Top 10:2025 Coverage** — mapping of audit checks to OWASP categories with coverage status
- **Tenant Security Settings** — pass/fail for SSO, MFA, password policy, global log receiver
- **Per-Namespace Sections** — service policy status and per-LB categorized findings with collapsible details
- **Recommendations** — actionable items sorted by severity and frequency, with remediation steps

The report is fully self-contained (inline CSS, no external dependencies) and prints cleanly.

### Generating from the Extension

1. Visit multiple namespace LB list pages to cache audit results
2. Click **Report** in the popup
3. Select the tenant and choose which namespaces to include
4. Click **Generate Report**, then **Download HTML**

### Generating from the Webapp

1. Run an audit against selected namespaces
2. View the report inline or click **Download HTML**

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+U` (Mac) / `Ctrl+Shift+U` (Windows) | Reload the extension |

---

## Project Structure

```
xc-audit-extension/
├── manifest.json                   # Chrome extension manifest (MV3)
├── assets/
│   ├── baseline_lb_http.json       # Default baseline configuration
│   ├── explanations.json           # Human-readable explanations for each check
│   ├── check-categories.json       # Check categorization for reporting
│   ├── exemption_map.json          # Default exemption code mappings
│   └── icons/                      # Extension icons (16/32/48/128px)
├── src/
│   ├── background/
│   │   └── service-worker.js       # CSRF capture, caching, audit orchestration
│   ├── content/
│   │   ├── content-script.js       # Page injection, API calls, badge rendering
│   │   └── content-style.css       # Inline badge and detail row styles
│   ├── lib/
│   │   ├── audit-engine.js         # Diff engine, exemption logic
│   │   ├── report-builder.js       # HTML report generator (pure function)
│   │   └── url-parser.js           # XC URL pattern matching
│   ├── options/
│   │   └── options.html/js/css     # Settings page with visual template builder
│   ├── popup/
│   │   └── popup.html/js/css       # Extension popup
│   └── report/
│       └── report.html/js/css      # Report generator page
├── webapp/
│   ├── package.json                # Express.js dependency
│   ├── .env.example                # Environment variable template
│   ├── server.js                   # Express app entry point
│   ├── server/
│   │   ├── crypto.js               # AES-256 encryption for stored credentials
│   │   ├── routes.js               # REST API endpoints
│   │   ├── tenant-store.js         # Tenant persistence (tenants.json + secrets.json)
│   │   ├── xc-api-client.js        # XC API client (p12 + API token auth)
│   │   └── audit-orchestrator.js   # Audit orchestration and report generation
│   ├── public/
│   │   ├── index.html              # Frontend shell
│   │   ├── css/app.css             # Application styles
│   │   └── js/
│   │       ├── app.js              # Frontend router
│   │       ├── tenants.js          # Tenant management UI
│   │       ├── audit.js            # Audit runner and results
│   │       └── report.js           # Report generation
│   └── data/                       # Runtime data (git-ignored)
│       ├── tenants.json            # Tenant configurations
│       └── secrets.json            # Encrypted credentials
├── demo/
│   └── terraform/                  # Terraform demo infrastructure
├── docs/                           # Additional documentation
└── xc-config-objects/              # Sample XC API responses (git-ignored)
```
