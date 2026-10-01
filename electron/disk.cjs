/* Is the disk holding this PC's copy encrypted? (docs/OFFLINE-FIRST.md §19, phase 3f)

   Asked of Windows' shell (`System.Volume.BitLockerProtection`), which works without admin
   rights. The setup screen warns when the answer is "off": the PC's copy holds the company's
   data (decision D2/D8), and disk encryption is what protects it if the PC is lost. Pure mapping
   kept apart from main.cjs so it can be tested without Electron or PowerShell. */

/** The PowerShell command printing the protection value for a drive like "C:". */
function bitlockerQuery(drive) {
  const d = String(drive).replace(/[^A-Za-z:]/g, '').slice(0, 2);
  return `(New-Object -ComObject Shell.Application).NameSpace('${d}').Self.ExtendedProperty('System.Volume.BitLockerProtection')`;
}

/** Windows reports 1 = on, 2 = off, 3 = encrypting, 4 = decrypting, 5 = suspended, 6 = on
 *  (unlocked). Anything else — 0 or blank, e.g. Windows Home with Device Encryption not active —
 *  is "unknown", which in practice usually means not encrypted: the setup screen still warns. */
function describeBitLocker(raw) {
  const v = Number(String(raw ?? '').trim());
  if (v === 1 || v === 3 || v === 6) return 'on';
  if (v === 2 || v === 4 || v === 5) return 'off';
  return 'unknown';
}

module.exports = { bitlockerQuery, describeBitLocker };
