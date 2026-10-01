# Make the company's own (free, self-signed) code-signing certificate for the desktop installer
# — decision D7 in docs/OFFLINE-FIRST.md. Run once, on the PC that builds the installer:
#
#   npm run desktop:cert
#
# Writes certs-desktop/signing.pfx (private — keep it, never commit it) and signing.cer (public:
# copy it to each company PC and run scripts/desktop-trust.ps1 there once). Then build with
#   $env:CSC_LINK = "certs-desktop\signing.pfx"; $env:CSC_KEY_PASSWORD = "<password>"; npm run desktop:build
#
# TODO before installing at customers: replace this with a real code-signing certificate (or the
# Microsoft Store) — Windows trusts this one only on PCs that ran desktop-trust.ps1.
param(
  [string]$Company = "Verdesakay",
  [string]$OutDir = "certs-desktop"
)
$ErrorActionPreference = "Stop"
$password = Read-Host -AsSecureString "Choose a password for the signing certificate"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$Company" `
  -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 `
  -NotAfter (Get-Date).AddYears(5)
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $OutDir "signing.pfx") -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $OutDir "signing.cer") | Out-Null
Write-Host "Created $OutDir\signing.pfx (private) and $OutDir\signing.cer (give this to each PC)."
Write-Host "Thumbprint: $($cert.Thumbprint)"
