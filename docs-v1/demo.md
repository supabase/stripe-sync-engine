---
theme: default
title: Sync Protocol — Live Demo
transition: slide-left
mdc: true
---

# The Protocol is Just NDJSON

Any process that reads/writes NDJSON is a valid connector

---

## The Source

A source prints NDJSON to **stdout** — one message per line.

```bash {monaco} {height:'120px'}
echo '{"type":"record","stream":"msgs","data":{"text":"hello"},"emitted_at":0}'
echo '{"type":"record","stream":"msgs","data":{"text":"world"},"emitted_at":0}'
echo '{"type":"state","stream":"msgs","data":{"cursor":2}}'
```

No SDK. No framework. Just `echo`.

---

## The Destination

A destination reads NDJSON from **stdin** — one message per line.

```bash {monaco} {height:'140px'}
while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type')
  if [ "$type" = "record" ]; then
    echo "$line" | jq -r '.data.text'
  fi
done
```

The engine pipes source stdout → destination stdin.

---

## Wire Them Together

The engine is a pipe.

```bash {monaco} {height:'200px'}
# engine: pipe source stdout into destination stdin
bash source.sh | bash dest.sh

# source.sh
echo '{"type":"record","stream":"msgs","data":{"text":"hello"},"emitted_at":0}'
echo '{"type":"record","stream":"msgs","data":{"text":"world"},"emitted_at":0}'
echo '{"type":"state","stream":"msgs","data":{"cursor":2}}'

# dest.sh
while IFS= read -r line; do
  [ "$(echo "$line" | jq -r '.type')" = "record" ] && echo "$line" | jq -r '.data.text'
done
```

---

## Try It Live

The engine in TypeScript is a `for await` over the same NDJSON stream:

```ts {monaco-run} {autorun:false, height:'200px'}
async function* source() {
  for (const line of [
    '{"type":"record","stream":"msgs","data":{"text":"hello"},"emitted_at":0}',
    '{"type":"record","stream":"msgs","data":{"text":"world"},"emitted_at":0}',
    '{"type":"state","stream":"msgs","data":{"cursor":2}}',
  ]) yield JSON.parse(line)
}
async function* destination($stdin) {
  for await (const msg of $stdin) {
    if (msg.type === 'record') console.log(msg.data.text)
    if (msg.type === 'state') yield msg
  }
}
for await (const s of destination(source()))
  console.log('state:', s.data)
```
