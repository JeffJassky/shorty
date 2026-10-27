# Link previews & SSRF

`shorty.inspect(url)` (and `POST /inspect`, used by the form) fetches a
destination and returns:

- `og`: title, description, image, site name, favicon (fallback chains follow
  Open Graph, then Twitter, then `<title>`);
- `final` and `chain`: the final URL, status, timing and every hop;
- `warnings`: `query_dropped` (a redirect lost your UTMs, so analytics see
  direct traffic), `not_ok`, `redirects` (with a "use the final URL" fix),
  `noindex_destination`, `cloudflare_challenge`, `utm_incomplete`,
  `private_address`, `unreachable`;
- `screenshot`: a `data:` URL, only with a screenshot adapter.

It never throws for network reasons (those become warnings). It throws only
for input that is not a URL (`invalid_url`, `unsupported_scheme`).

## The fetch is SSRF-hardened

An admin-only endpoint that fetches arbitrary URLs is a server-side request
forgery vector, so the fetch:

- allows only http and https, and re-validates every redirect hop (max 5);
- resolves DNS once per hop and **connects to the checked address**, so DNS
  rebinding cannot swap it afterwards; fails closed on DNS errors;
- refuses any hop whose addresses are not public unicast (loopback, private
  ranges, link-local and cloud metadata `169.254/16`, carrier-grade NAT,
  multicast, reserved and unallocated IPv6 space, and more);
- stops reading at `</head>` or `maxBytes`, under one overall deadline;
- ignores proxy environment variables.

### Address policy

`inspect.isAllowedAddress(ip)` replaces the default table. Override it for an
**intranet** deployment that previews internal destinations, or to tighten it:

::: warning Deployment note
Ports are not restricted on public hosts: a destination may point at any port
of any public address. A host whose own public IP is bound on a local
interface (common on VPS providers), or that runs on a cloud with
public-but-special endpoints (for example Azure's `168.63.129.16`), should pass
an `isAllowedAddress` that also refuses those addresses.
:::

## Screenshot adapter

```js
createShorty({
  screenshot: async (url, { addresses }) => {
    const body = await myBrowser.screenshot(url, { resolveTo: addresses });
    return body ? { contentType: 'image/png', body } : null;
  },
});
```

| Direction | What |
|---|---|
| shorty to host | the final URL and `{ addresses }`, the IPs the safe fetch checked and connected to for the final hop |
| host to shorty | `{ contentType, body: Buffer }`, or `null` for no screenshot |

A throw or `null` means no screenshot and never fails the inspect. The adapter
is called only when the safe fetch actually reached the final URL, and the
whole inspect (adapter included) shares `timeoutMs`.

::: danger Egress is the adapter's responsibility
shorty guarantees one thing: the adapter is called only for a URL its safe
fetch reached. The URL is **not validated for the adapter's own fetch.** A
browser re-resolves DNS (the name may now point at `127.0.0.1` or
`169.254.169.254`), follows script and meta redirects, and loads subresources
from any host, and a screenshot of an internal page hands its pixels back.
Pin the browser's resolver to `addresses`, intercept and refuse non-public
requests, or run it in a sandboxed network.
:::

Why an adapter and not a built-in: rendering needs a headless browser or a
paid API. An iframe preview was rejected, since most real destinations send
`X-Frame-Options` or `frame-ancestors` and would show a blank box.
