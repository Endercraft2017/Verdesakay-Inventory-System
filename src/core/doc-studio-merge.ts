/** Stable top-level block IDs let independent block edits merge without whole-body overwrites.
 * Structural edits and edits to the same block deliberately report conflicts. */
export function mergeSnapshots(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>): { snapshot: Record<string, unknown>; conflicts: string[] } {
  const snapshot = { ...remote }, conflicts: string[] = [];
  for (const key of Object.keys(local)) {
    if (JSON.stringify(local[key]) === JSON.stringify(base[key])) continue;
    if (JSON.stringify(remote[key]) === JSON.stringify(base[key]) || JSON.stringify(local[key]) === JSON.stringify(remote[key])) {
      snapshot[key] = local[key]; continue;
    }
    if (key === 'body' && typeof base.body === 'string' && typeof local.body === 'string' && typeof remote.body === 'string') {
      const split = (body: string): Map<string,string> | null => {
        const parts = body.split(/<!--doc-sync:([a-zA-Z0-9_-]+)-->/);
        if (parts.length < 3) return null;
        const blocks = new Map<string,string>([['$prefix',parts[0]!]]);
        for (let i=1;i<parts.length;i+=2) { if(blocks.has(parts[i]!))return null;blocks.set(parts[i]!,parts[i+1]!); }
        return blocks;
      };
      const b=split(base.body), l=split(local.body), r=split(remote.body);
      if(b&&l&&r&&JSON.stringify([...b.keys()])===JSON.stringify([...l.keys()])&&JSON.stringify([...b.keys()])===JSON.stringify([...r.keys()])) {
        const merged = new Map(r); let blocked=false;
        for(const [id,value] of l) if(value!==b.get(id)) {
          if(r.get(id)!==b.get(id)&&r.get(id)!==value){conflicts.push('block:'+id);blocked=true;}else merged.set(id,value);
        }
        if(!blocked) snapshot.body=[...merged].map(([id,value])=>id==='$prefix'?value:`<!--doc-sync:${id}-->${value}`).join('');
        continue;
      }
    }
    conflicts.push(key);
  }
  return {snapshot,conflicts};
}
