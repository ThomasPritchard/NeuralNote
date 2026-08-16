#!/usr/bin/env bash
# Create (once) a stable self-signed code-signing identity for local dev builds,
# so the macOS keychain stops re-prompting on every rebuild.
#
#   bash scripts/ensure-dev-signing-identity.sh
#
# WHY THIS EXISTS
#
# Keychain ACLs bind to the *Designated Requirement* of the process that wrote
# the item. An ad-hoc signature (`codesign --sign -`) derives its requirement
# from the code hash, so every rebuild is a different application as far as the
# keychain is concerned — which is why "Always Allow" never sticks and every new
# dev build asks for the login keychain password again.
#
# A stable signing identity gives a stable Designated Requirement
# (`identifier "..." and certificate leaf = H"<cert hash>"`), so an authorisation
# granted once survives every later rebuild.
#
# This is for LOCAL DEV BUILDS ONLY. It is not a Developer ID, it is not
# notarised, and Gatekeeper will not accept it for distribution. Releases use
# the real signing path in .github/workflows/release-alpha.yml.
set -euo pipefail

IDENTITY_NAME="${NEURALNOTE_DEV_SIGNING_IDENTITY:-NeuralNote Dev Signing}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is macOS-only; nothing to do on $(uname -s)." >&2
  exit 0
fi

# `codesign` locates an identity by certificate subject Common Name ONLY, and
# fails outright if two certificates share one. So the CN below must be
# IDENTITY_NAME — see the openssl config, which is deliberately an unquoted
# heredoc so the variable interpolates. Getting this wrong mints a certificate
# under a different CN than dev-build.sh later asks for, and because the
# idempotence check greps the same name, every re-run imports another duplicate
# until `codesign --sign` fails with "multiple matches" for everyone.
identity_present() {
  # No `-v`: that filters to *trusted* identities, and a self-signed root never
  # passes it (it reports CSSMERR_TP_NOT_TRUSTED) even though codesign signs with
  # it fine. Gatekeeper trust is irrelevant for a local dev build, which was not
  # Gatekeeper-acceptable when ad-hoc signed either.
  #
  # stderr is kept rather than discarded: a locked or unreadable keychain must not
  # be silently reported as "identity absent", which would send the caller down
  # the duplicate-import path above. Output is captured first so `grep -q` cannot
  # SIGPIPE the producer and trip `pipefail` into a false negative.
  local listing
  if ! listing="$(security find-identity -p codesigning 2>&1)"; then
    echo "Could not query code-signing identities:" >&2
    printf '%s\n' "$listing" >&2
    return 2
  fi
  printf '%s' "$listing" | grep -qF "$IDENTITY_NAME"
}

set +e
identity_present
present_status=$?
set -e
if [[ "$present_status" -eq 2 ]]; then
  exit 1
fi
if [[ "$present_status" -eq 0 ]]; then
  echo "Signing identity already present: ${IDENTITY_NAME}"
  echo "Nothing to do."
  exit 0
fi

# OpenSSL 3 is required. macOS ships LibreSSL as /usr/bin/openssl, which does not
# understand `-legacy` and fails with a bare usage dump. Detect it up front with a
# usable message rather than aborting mid-run under `set -e`.
openssl_bin="${OPENSSL:-openssl}"
if ! command -v "$openssl_bin" >/dev/null 2>&1; then
  echo "openssl not found on PATH." >&2
  echo "Install OpenSSL 3 (brew install openssl@3) or set OPENSSL=/path/to/openssl." >&2
  exit 1
fi
openssl_version="$("$openssl_bin" version 2>&1 || true)"
if [[ "$openssl_version" != OpenSSL\ 3* && "$openssl_version" != OpenSSL\ 4* ]]; then
  echo "This script needs OpenSSL 3 or newer; found: ${openssl_version}" >&2
  echo "macOS ships LibreSSL as /usr/bin/openssl, which lacks the -legacy flag." >&2
  echo "Install it (brew install openssl@3) and re-run, e.g.:" >&2
  echo "  OPENSSL=\"\$(brew --prefix openssl@3)/bin/openssl\" bash scripts/ensure-dev-signing-identity.sh" >&2
  exit 1
fi

workdir="$(mktemp -d)"
# INT/TERM/HUP as well as EXIT: an EXIT trap alone does NOT run on Ctrl-C, and
# this directory holds an unencrypted RSA private key (`-nodes`) plus the p12.
# `mktemp -d` is 0700, so exposure is bounded to this user, but leaving key
# material on disk after an interrupt is still wrong.
trap 'rm -rf "$workdir"' EXIT INT TERM HUP

echo "Creating self-signed code-signing identity: ${IDENTITY_NAME}"

# Unquoted heredoc: IDENTITY_NAME MUST interpolate into CN (see above).
# codeSigning EKU is what makes codesign and `find-identity -p codesigning`
# recognise this as a signing identity rather than a generic certificate.
cat >"${workdir}/openssl.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[ dn ]
CN = ${IDENTITY_NAME}

[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CNF

# Diagnostics are NOT discarded here. These were previously silenced, which meant
# a wrong openssl, a bad config or a missing binary all surfaced as an
# unexplained abort under `set -e`.
"$openssl_bin" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "${workdir}/key.pem" \
  -out "${workdir}/cert.pem" \
  -config "${workdir}/openssl.cnf"

# macOS's PKCS#12 importer rejects OpenSSL 3's defaults. `-legacy` switches the
# *encryption* algorithms but NOT the MAC, which OpenSSL 3 still writes as
# SHA-256; the Security framework then fails with a misleading
# "MAC verification failed ... (wrong password?)". Pin the MAC to SHA-1 and use
# legacy PBE for both cert and key. A throwaway passphrase is used rather than an
# empty one, which the importer also dislikes.
p12_pass="$("$openssl_bin" rand -hex 16)"
"$openssl_bin" pkcs12 -export -legacy \
  -macalg sha1 \
  -certpbe PBE-SHA1-3DES \
  -keypbe PBE-SHA1-3DES \
  -inkey "${workdir}/key.pem" \
  -in "${workdir}/cert.pem" \
  -name "$IDENTITY_NAME" \
  -passout "pass:${p12_pass}" \
  -out "${workdir}/identity.p12"

# -T /usr/bin/codesign puts codesign on the private key's ACL up front, so
# signing itself does not prompt later.
security import "${workdir}/identity.p12" \
  -k "$KEYCHAIN" \
  -P "$p12_pass" \
  -T /usr/bin/codesign

echo
set +e
identity_present
verify_status=$?
set -e
if [[ "$verify_status" -eq 0 ]]; then
  echo "Created: ${IDENTITY_NAME}"
  echo
  echo "scripts/dev-build.sh will now sign with it automatically."
  echo
  echo "The FIRST build signed with this identity may raise one keychain"
  echo "authorisation prompt. Choose 'Always Allow' — that grant is permanent,"
  echo "because the identity no longer changes between rebuilds. That single"
  echo "click replaces the prompt you currently get on every build."
else
  echo "Import reported success but no identity matching '${IDENTITY_NAME}' is" >&2
  echo "listed for code signing. Do NOT re-run this script until that is" >&2
  echo "resolved — a second run would import a duplicate, and two certificates" >&2
  echo "sharing a Common Name make 'codesign --sign' fail outright." >&2
  echo "Inspect with: security find-identity -p codesigning" >&2
  exit 1
fi
