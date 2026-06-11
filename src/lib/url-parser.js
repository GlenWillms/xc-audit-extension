var XC_URL_PATTERN =
  /^https:\/\/([^.]+)\.console\.ves\.volterra\.io\/(?:managed_tenant\/([^/]+)\/)?web\/workspaces\/([^/]+)\/(.+)/;

var NAMESPACE_SEGMENT = /namespaces\/([^/]+)/;
var LB_LIST_PATH = /manage\/load[_-]?balancers\/http[_-]?load[_-]?balancers\/?$/i;

function parseXcUrl(url) {
  const match = url.match(XC_URL_PATTERN);
  if (!match) return null;
  const subPath = match[4];
  const nsMatch = subPath.match(NAMESPACE_SEGMENT);
  return {
    tenant: match[1],
    managedTenant: match[2] || null,
    workspace: match[3],
    namespace: nsMatch ? nsMatch[1] : match[3],
    subPath,
    isLbListPage: LB_LIST_PATH.test(subPath),
  };
}

if (typeof globalThis.exportForModule !== 'undefined') {
  globalThis.exportForModule({ parseXcUrl, XC_URL_PATTERN, LB_LIST_PATH });
}
