# F5 XC Namespace Audit

A browser extension that audits HTTP Load Balancers in F5 Distributed Cloud (XC) against a configurable security baseline. It overlays pass/fail badges directly on the XC console's load balancer list and provides detailed findings in a popup.

## Features

- **Inline audit badges** on the HTTP Load Balancer list page showing PASS/FAIL status per LB
- **Expandable detail rows** showing passed, failed, and skipped checks with explanations
- **Label-based exemptions** — skip specific checks per LB using XC labels
- **Visual template builder** — toggle baseline checks on/off without editing JSON
- **Dynamic policy baseline** — automatically uses the `default` namespace's service policies as the baseline, with per-namespace overrides
- **Version-based caching** — only re-audits LBs whose configuration has changed
- **Register labels in XC** — create known label keys directly from the extension settings

## Installation

1. Clone this repository
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repository folder
5. Navigate to an F5 XC HTTP Load Balancer list page

No build step required — the extension runs directly from source.

## How It Works

### Authentication

The extension uses your existing browser session to authenticate with the F5 XC API. No API keys or tokens need to be configured — just log in to the XC console as you normally would.

Technically, the extension:
1. Captures CSRF tokens from XC console network traffic via `webRequest` listeners
2. Makes API calls from the content script, which shares the page's session cookies
3. Sends the data to the background service worker for auditing against the baseline

### Audit Flow

When you navigate to an HTTP Load Balancer list page:

1. The extension fetches the LB list and each LB's full configuration
2. Fetches the `default` namespace's active service policies as the policy baseline
3. Compares each LB's configuration against the baseline
4. Applies any label-based exemptions
5. Injects PASS/FAIL badges inline next to each LB name
6. Clicking a badge toggles a detail row showing passed, failed, and skipped checks

### What Gets Checked

The default baseline checks for the following security configurations:

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

All checks can be toggled on/off in the Settings page.

## Label-Based Exemptions

Not every LB needs every security feature. For example, a simple website that doesn't expose APIs shouldn't fail for missing API Discovery. Instead of maintaining separate baselines, you can exempt specific checks per LB using labels.

### How to Use

1. In the XC console, add a label to the LB object:
   - **Key**: `xc-audit-ignore-apid`
   - **Value**: `true`
2. The extension will skip the API Discovery check for that LB
3. The badge will show the skip count, e.g., `PASS (11 passed, 1 skipped)`
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

Before labels can be assigned to LB objects, they must be registered as "known labels" in the XC system. The extension can do this for you:

1. Open the extension's Settings page (click the gear icon in the popup)
2. Scroll to the **Exemption Map** section
3. Click **Register Labels in XC**
4. The extension will create each label key and value via the XC API

This requires an open XC console tab for authentication. Labels are registered in the `shared` namespace so they're available across all namespaces.

## Baseline LB Override

Instead of comparing every LB against the static baseline configuration, you can point an LB at a reference LB in the `default` namespace. The reference LB defines the expected security posture — if the reference LB itself doesn't have a feature enabled, the audited LB won't be warned for missing it either.

### How It Works

1. Create a reference LB in the `default` namespace that represents the expected configuration for a group of LBs (e.g., `baseline-enterprise`)
2. On each production LB that should use this reference, add the label:
   - **Key**: `xc-audit-baseline-lb`
   - **Value**: the name of the reference LB (e.g., `baseline-enterprise`)
3. At audit time, the extension fetches the reference LB and runs the same checks against it
4. For each check the audited LB fails:
   - If the reference LB **also fails** that check → the finding becomes a **pass** (the reference doesn't require it)
   - If the reference LB **passes** that check → the finding stays a **warning** (the audited LB is below the reference)

### Example

If `baseline-enterprise` has Bot Defense disabled (`disable_bot_defense`), any LB referencing it won't be warned for also having Bot Defense disabled. But if `baseline-enterprise` has API Discovery enabled and the audited LB doesn't, that shows as a warning.

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
- Changing the reference LB's configuration requires a re-audit (click **Re-Audit** in the popup)

## Service Policy Baseline

By default, the extension fetches the `default` namespace's active service policies and uses them as the baseline for policy comparison. This means all namespaces are expected to have the same policy order as `default`.

### Per-Namespace Overrides

If a specific namespace needs a different policy order:

1. Navigate to that namespace's LB list page
2. Open the extension popup
3. Expand the Service Policies section
4. Click **"Use {namespace}'s policies as baseline"**

This saves an override for that namespace. A note appears in the popup when an override is active. To remove it, click **"Clear override (use default)"**.

## Settings Page

Open the settings page from the popup (click **Settings**) or right-click the extension icon and select **Options**.

### Baseline Checks

Toggle individual security checks on/off. Each check shows:
- The feature name
- The label key to exempt it (e.g., `xc-audit-ignore-apid=true`)

### App Firewall Policy Name

Set the expected WAF policy name. LBs are checked to ensure they reference this specific policy.

### Namespace Service Policies

Displays the current policy baseline source. The policy baseline is fetched dynamically from the `default` namespace at audit time — no static configuration required.

- **Fetch from default namespace** — preview the current `default` namespace policies (requires an open XC console tab)
- **Namespace overrides** — collapsible section showing any per-namespace overrides, with remove buttons for each

### Exemption Map

View and edit the mapping between label codes and baseline keys. You can:
- Add new exemption codes
- Remove existing ones
- Change which baseline keys a code skips
- Register all labels in XC with one click

### Raw JSON (Advanced)

A collapsible section exposing the full baseline and explanations JSON for power users.

### Reset All to Defaults

A single button that resets baseline checks, explanations, exemption map, settings, and clears all namespace policy overrides.

## Popup

Click the extension icon to open the popup. It shows:

- **Version number** in the header
- **Overall status**: green (all passed) or red (issues found)
- **Service Policies**: collapsible detail with per-namespace override button
- **Load Balancers**: summary count + per-LB collapsible details showing passed, failed, and skipped checks
- **Re-Audit**: forces a fresh audit (clears cache)
- **Settings**: opens the options page

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+U` (Mac) / `Ctrl+Shift+U` (Windows) | Reload the extension |

## Caching

The extension uses version-based caching to minimize API calls:

- The LB list is always fetched (lightweight, includes version numbers)
- Individual LB configs are only re-fetched when their version changes
- Changing the baseline or exemption map invalidates all cached results
- Click **Re-Audit** in the popup to force a fresh audit

## Project Structure

```
assets/
  baseline_lb_http.json    # Default baseline configuration
  explanations.json        # Human-readable explanations for each check
  exemption_map.json       # Default exemption code mappings
  icons/                   # Extension icons
src/
  background/
    service-worker.js      # CSRF capture, caching, audit orchestration
  content/
    content-script.js      # Page injection, API calls, badge rendering
    content-style.css      # Inline badge and detail row styles
  lib/
    audit-engine.js        # Diff engine, exemption logic
    url-parser.js          # XC URL pattern matching
  options/
    options.html/js/css     # Settings page with visual template builder
  popup/
    popup.html/js/css       # Extension popup
manifest.json              # Chrome extension manifest (MV3)
```
