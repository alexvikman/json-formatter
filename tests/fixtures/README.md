# Performance test fixtures

- `microsoft-64KB.json`: the unmodified [Microsoft Edge demo sample](https://microsoftedge.github.io/Demos/json-dummy-data/64KB.json), retrieved on 2026-09-04; 63,790 UTF-8 bytes and 197 records.
- `microsoft-5MB.json`: 17,372 records repeated from the source array, serialized as compact JSON with 134 trailing whitespace bytes. Total: exactly 5,000,000 bytes.

Tests read both files from disk and verify these SHA-256 checksums:

```text
microsoft-64KB.json  cde3fa1e4696435fb274304f710742f67bc4b810fd7ee850543d162f3e10aa70
microsoft-5MB.json   2af6b1174a6a1ab3de6cffabd675f7a07d485a26bf2058cecf26345226221bc6
```

Source: [MicrosoftEdge/Demos](https://github.com/MicrosoftEdge/Demos/tree/main/json-dummy-data). License: [MIT](MICROSOFT-LICENSE.txt).
