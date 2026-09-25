import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { isIPv4 } from 'node:net';
import { Readable } from 'node:stream';
import { ProviderError } from './types.js';

/** Conservative public IPv4 allow rule. IPv6-only endpoints are unsupported here. */
export function publicV4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number) as [number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || b === 88)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

/** Bound to one trusted config endpoint. Checks every DNS result and connects using
 * that lookup result, preventing a second resolution from rebinding the connection.
 * HTTPS still verifies the original hostname; redirects are never followed.
 */
export function createProviderTransport(
  baseUrl: string,
  approvedLocalBaseUrls: readonly string[],
): typeof fetch {
  const normalize = (value: string) => new URL(value).href.replace(/\/+$/, '');
  const base = normalize(baseUrl);
  const local = approvedLocalBaseUrls.some((value) => normalize(value) === base);
  const expected = `${base}/chat/completions`;
  return async (input, init) => {
    if (String(input) !== expected || init?.method !== 'POST' || typeof init.body !== 'string')
      throw new ProviderError('policy_denied', 'not_sent');
    const url = new URL(expected);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!local && url.protocol !== 'https:')
    )
      throw new ProviderError('policy_denied', 'not_sent');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if ((!local && !publicV4(host) && /^[\d.]+$/.test(host)) || host.includes(':'))
      throw new ProviderError('policy_denied', 'not_sent');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'POST',
          headers,
          signal: init.signal ?? undefined,
          family: 4,
          // A dedicated socket per bounded request; no ambient HTTP proxy or shared pool.
          agent: false,
          lookup(hostname, _options, callback) {
            lookup(hostname, { family: 4, all: true }, (error, addresses) => {
              if (error) {
                callback(error, '', 4);
                return;
              }
              if (
                !addresses.length ||
                (!local && addresses.some((entry) => !publicV4(entry.address)))
              ) {
                callback(new ProviderError('policy_denied', 'not_sent'), '', 4);
                return;
              }
              callback(null, addresses[0]!.address, 4);
            });
          },
        },
        (res) => {
          const status = res.statusCode ?? 502;
          if (status === 204 || status === 205 || status === 304) {
            res.resume();
            resolve(new Response(null, { status }));
            return;
          }
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status,
              headers: { 'content-type': res.headers['content-type'] ?? '' },
            }),
          );
        },
      );
      req.once('error', reject);
      req.end(init.body);
    });
  };
}
