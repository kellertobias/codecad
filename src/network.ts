// Which host names the server answers to. It listens on 127.0.0.1 by
// default; CODECAD_HOST=0.0.0.0 opens it to the local network, for example so
// a phone can show drawings and cut lists. The Host header is still checked
// either way, so a web page elsewhere cannot reach the server through a DNS
// name that happens to resolve to it (DNS rebinding).
import { hostname, networkInterfaces } from "node:os";

const loopbackNames = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

/** Host names (without port) requests may be addressed to. Loopback names
 * always; when bound beyond loopback also this machine's name, its `.local`
 * name and its interface addresses, plus any names listed in `extra`. */
export function allowedHostNames(bind: string, extra: readonly string[] = []) {
  const names = new Set(loopbackNames);
  if (!isLoopbackAddress(bind)) {
    const machine = hostname().toLowerCase();
    names.add(machine);
    names.add(machine.endsWith(".local") ? machine : `${machine}.local`);
    for (const addresses of Object.values(networkInterfaces()))
      for (const address of addresses ?? [])
        names.add(
          address.family === "IPv6" ? `[${address.address}]` : address.address,
        );
  }
  for (const name of extra)
    if (name.trim()) names.add(name.trim().toLowerCase());
  return names;
}

/** Whether a request's Host header names an allowed host on our port. */
export function hostAllowed(
  header: string | undefined,
  port: number,
  allowed: ReadonlySet<string>,
): boolean {
  if (!header) return false;
  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return false;
  }
  const requestPort = url.port === "" ? 80 : Number(url.port);
  return requestPort === port && allowed.has(url.hostname.toLowerCase());
}

/** Addresses to show on start-up, so the LAN address can be typed into a
 * phone. */
export function reachableAddresses(bind: string, port: number): string[] {
  if (isLoopbackAddress(bind)) return [`http://127.0.0.1:${port}`];
  const urls = [`http://localhost:${port}`];
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (address.family === "IPv4" && !address.internal)
        urls.push(`http://${address.address}:${port}`);
  return urls;
}
