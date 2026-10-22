# Make this PC trust the company's own code-signing certificate (decision D7), so the Verdesakay
# installer shows the company's name instead of "Unknown publisher". Run once per PC, from the
# folder holding signing.cer:
#
#   powershell -ExecutionPolicy Bypass -File desktop-trust.ps1              # this Windows user
#   powershell -ExecutionPolicy Bypass -File desktop-trust.ps1 -AllUsers    # every user (run as admin)
#
# Windows asks you to confirm adding the certificate — that is expected.
param(
  [string]$Certificate = "signing.cer",
  [switch]$AllUsers
)
$ErrorActionPreference = "Stop"
$scope = if ($AllUsers) { "LocalMachine" } else { "CurrentUser" }
Import-Certificate -FilePath $Certificate -CertStoreLocation "Cert:\$scope\Root" | Out-Null
Import-Certificate -FilePath $Certificate -CertStoreLocation "Cert:\$scope\TrustedPublisher" | Out-Null
Write-Host "This PC ($scope) now trusts the Verdesakay installer's signature."
