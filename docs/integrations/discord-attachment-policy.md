# Discord inbound attachment policy

`MAX_ARTIFACTS` is exactly **10** and is enforced by `stageDiscordAttachments` at the **presented attachment entries** stage, before metadata validation, URL validation, downloading, or any deduplication. Every array entry consumes one slot: invalid entries and byte-for-byte duplicates both count. More than ten entries rejects the complete inbound message before any download; jeo does not retain the first ten or silently discard only the excess entry. Entries are retained in presented order and are not deduplicated.

An accepted URL must parse as an absolute HTTPS URL. Its hostname must match exactly one of this allowlist after the URL parser's ASCII case normalization:

- `cdn.discordapp.com`
- `media.discordapp.net`

Subdomains and suffix matches are not accepted. Raw authorities containing non-ASCII or percent-encoded characters are rejected rather than relying on IDNA or percent-decoding. A trailing dot is rejected. User-info and every explicit port—including explicit `:443`—are rejected. Path and query encoding do not affect host validation.

Downloads use manual redirect handling. Every requested URL, every redirect destination (including relative destinations resolved against the preceding trusted URL), and the final response URL when supplied by the fetch implementation must pass the same policy. At most five redirects are followed. A missing `Location`, a sixth redirect, or any untrusted intermediate or final destination rejects the complete inbound message and cleans up its staging directory.
