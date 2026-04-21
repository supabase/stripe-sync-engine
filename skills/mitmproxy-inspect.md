# Inspect mitmproxy flows

Use this when debugging HTTP traffic captured by `source scripts/mitmweb-forward-proxy.sh`.

## Access the mitmweb API

mitmweb 12+ requires auth. Use Bearer token with the password `sync-engine`:

```bash
curl -s -k -H 'Authorization: Bearer sync-engine' 'http://127.0.0.1:8081/flows'
```

## Filter and summarize flows

Show method, status, and URL for a specific host (e.g. Google Sheets):

```bash
curl -s -k -H 'Authorization: Bearer sync-engine' 'http://127.0.0.1:8081/flows' | python3 -c "
import sys, json
flows = json.load(sys.stdin)
for f in flows:
    req = f.get('request', {})
    method = req.get('method', '?')
    host = req.get('pretty_host', req.get('host', '?'))
    path = req.get('path', '?')
    status = f.get('response', {}).get('status_code', '-')
    if 'google' in host:  # change filter as needed
        print(f'{method} {status} {host}{path}')
"
```

## Key details

- Proxy runs on `http://127.0.0.1:8080`, web UI on `http://127.0.0.1:8081`
- Start with: `source scripts/mitmweb-forward-proxy.sh`
- Logs in: `tmp/mitmweb-forward-proxy-8080.log`
- CA cert: `~/.mitmproxy/mitmproxy-ca-cert.pem`
- The flows JSON includes full request/response details (headers, timing, TLS info)
- Filter the host in the python snippet to focus on specific APIs (e.g. `stripe`, `google`, `oauth2`)
