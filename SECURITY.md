# Security

## Reporting a vulnerability

Report a vulnerability privately through this repository's **Security** tab:
**Report a vulnerability** (GitHub private vulnerability reporting). Please do
not open a public issue for it.

Tell us what you found, the version, and how to reproduce it. We confirm
receipt within three working days, keep you informed while we work on it, and
credit you in the release that fixes it unless you prefer otherwise.

## Supported versions

The latest release. "Your machines" in CoRoid shows which version each of
your machines runs; update with `brew upgrade coroid-connector` or
`npm install --global @coroid/connector`.

## What a release is

Every release is built from a tagged commit of this repository by the
`Release` workflow, attested (`gh attestation verify`), and published to npm
with provenance. A file you got any other way is not a release.
