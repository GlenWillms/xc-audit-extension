# Ideas

Parked ideas for future consideration. Not committed to — just captured so they don't get lost.

## Managed Tenant Support

Support auditing LBs accessed through a parent/management tenant. The extension already captures managed tenant paths from network traffic (`/managed_tenant/CHILD/`), but the API calls and caching don't fully account for the managed tenant prefix yet.

## Baseline Templates Library

Ship multiple baseline templates for different use cases (e.g., "API Gateway", "Static Website", "Full WAF+API Security") that users can select from a dropdown instead of toggling individual checks.

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
