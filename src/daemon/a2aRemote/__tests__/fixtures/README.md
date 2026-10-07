# Test-only TLS fixtures — not a secret

`cert-a.pem`/`key-a.pem` and `cert-b.pem`/`key-b.pem` are two throwaway,
self-signed EC P-256 certificates (`CN=wmux-a2a-test-a` / `-b`) used only by
`pinnedClient.test.ts` to stand up local TLS servers. They protect nothing and
are trusted by nothing. They are committed so the tests never shell out to
`openssl` (Windows CI runners may not have it).

Regenerate with:

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 \
      -nodes -keyout key-a.pem -out cert-a.pem -days 36500 -subj "/CN=wmux-a2a-test-a"
