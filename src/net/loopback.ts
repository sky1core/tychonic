export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.[0-9]{1,3}){0,3}$/.test(normalized);
}

export function assertLoopbackHost(host: string, allowNetworkBind: boolean): void {
  if (allowNetworkBind || isLoopbackHost(host)) {
    return;
  }
  throw new Error(
    `refusing to bind Tychonic web API to non-loopback host ${host}; public alpha has no web authentication, so use 127.0.0.1 or pass --allow-network-bind only for a trusted private network`
  );
}
