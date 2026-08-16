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

# Idempotent: if the identity already exists, do nothing.
# NOTE: no `-v`. That flag filters to *trusted* identities, and a self-signed
# root is never "valid" by that test (it reports CSSMERR_TP_NOT_TRUSTED) even
# though codesign signs with it fine. Gatekeeper trust is irrelevant for a local
# dev build, which was not Gatekeeper-acceptable when ad-hoc signed either.
if security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY_NAME"; then
  echo "Signing identity already present: ${IDENTITY_NAME}"
  echo "Nothing to do."
  exit 0
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "Creating self-signed code-signing identity: ${IDENTITY_NAME}"

# codeSigning EKU is what makes `codesign` and `find-identity -p codesigning`
# recognise this as a signing identity rather than a generic certificate.
cat >"${workdir}/openssl.cnf" <<'CNF'
[ req ]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[ dn ]
CN = NeuralNote Dev Signing

[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CNF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "${workdir}/key.pem" \
  -out "${workdir}/cert.pem" \
  -config "${workdir}/openssl.cnf" >/dev/null 2>&1

# macOS's PKCS#12 importer rejects OpenSSL 3's defaults. `-legacy` switches the
# *encryption* algorithms but NOT the MAC, which OpenSSL 3 still writes as
# SHA-256; the Security framework then fails with a misleading
# "MAC verification failed ... (wrong password?)". Pin the MAC to SHA-1 and use
# legacy PBE for both cert and key. A throwaway passphrase is used rather than an
# empty one, which the importer also dislikes. The p12 lives only in a temp dir
# that is removed on exit.
p12_pass="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy \
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
if security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY_NAME"; then
  echo "Created: ${IDENTITY_NAME}"
  echo
  echo "scripts/dev-build.sh will now sign with it automatically."
  echo
  echo "The FIRST build signed with this identity may raise one keychain"
  echo "authorisation prompt. Choose 'Always Allow' — that grant is permanent,"
  echo "because the identity no longer changes between rebuilds. That single"
  echo "click replaces the prompt you currently get on every build."
else
  echo "Import completed but the identity is not listed for code signing." >&2
  echo "Check: security find-identity -p codesigning" >&2
  exit 1
fi
