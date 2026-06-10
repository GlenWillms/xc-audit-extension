# Ideas

Parked ideas for future consideration. Not committed to — just captured so they don't get lost.

## Managed Tenant Support

Support auditing LBs accessed through a parent/management tenant. The extension already captures managed tenant paths from network traffic (`/managed_tenant/CHILD/`), but the API calls and caching don't fully account for the managed tenant prefix yet.

## Baseline Templates from Default Namespace LBs

Instead of shipping static template files, use actual LB objects in the `default` namespace as live baseline templates. Each template LB serves as a reference configuration for a specific use case (e.g., "API Gateway", "Static Website", "Full WAF+API Security").

**How it would work:**
- Create example LBs in the `default` namespace — one per baseline template
- Mark each template LB as "do not advertise" so it's never actually serving traffic
- At least one LB acts as the default template (all LBs are compared against it unless overridden)
- To associate a production LB with a specific template, add a label pointing to the template LB name (e.g., `xc-audit-template=api-gateway`)
- The extension fetches the template LB's config at audit time and uses it as the baseline for comparison

**Benefits:**
- Templates are managed as real XC objects — no JSON editing required
- Changes to a template LB automatically apply to all associated LBs on the next audit
- Teams can use familiar XC workflows to maintain baselines

## Export/Import Settings

Allow exporting the full configuration (baseline, exemption map, overrides) as a JSON file and importing it on another machine. Useful for sharing a baseline across a team.

## Audit History

Track audit results over time per namespace. Show trends — did the number of failing LBs go up or down since last week?

## Bulk Label Assignment

Add a UI to apply exemption labels to multiple LBs at once, rather than labeling each LB individually in the XC console.

## Notification on Drift

Background monitoring that periodically re-audits and sends a browser notification when an LB's compliance status changes (e.g., goes from PASS to FAIL).

## Namespace-Level Summary Dashboard

A full-page dashboard (new tab) showing compliance status across all namespaces the user has access to, rather than one namespace at a time.

## CDN Load Balancer Support

Extend auditing to CDN load balancers in addition to HTTP load balancers. The xcshowmap extension already fetches CDN LB data — similar patterns could apply.

## TCP Load Balancer Support

Extend auditing to TCP load balancers with a separate baseline template.

## Custom Explanation Editor in Template Builder

Allow editing the explanation text (reason + next_step) per check directly in the visual template builder, rather than only through the raw JSON editor.

## Chrome Web Store / Edge Add-ons Publishing

Package and publish to the browser extension stores for easier distribution instead of requiring "Load unpacked".

## RBAC-Aware Auditing

Detect the user's role/permissions and adjust which checks are shown or which actions are available (e.g., read-only users can't set overrides).
