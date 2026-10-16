/** Printed QR identity is immutable; human-readable serial/lot text may be reused. */
export function parseProductionLabel(value: string): {kind:'unit'|'batch';id:number}|null {
 const match=/^VDS:(UNIT|BATCH):([1-9]\d*)$/i.exec(value.trim());
 if(!match||!Number.isSafeInteger(Number(match[2])))return null;
 return {kind:match[1]!.toLowerCase() as 'unit'|'batch',id:Number(match[2])};
}
