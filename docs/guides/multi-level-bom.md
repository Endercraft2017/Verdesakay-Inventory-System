# Multi-level BOMs, costing & where-used

**For:** production planners, purchasing, estimators
**In the app:** Production → **Product Setup → Products & BOM** → click a product

---

## What it's for

Most things you build are made of parts that are *themselves* built from parts. A wheel
goes into a bicycle; a rim and 32 spokes go into the wheel. That middle layer is a
**sub-assembly**.

This feature lets you:

- **Explode** a finished product through every sub-assembly down to raw materials, so you
  know exactly what to buy or pull to build *N* units.
- See the **standard material cost** to build one unit, with sub-assembly costs rolled up
  from their own components.
- Check **where a part is used** before you change or discontinue it.

## Before you start

- You need the **View inventory** permission to see costs and explosions.
- A component is treated as a **sub-assembly** when it is itself flagged as a finished
  product *and* has its own BOM. Otherwise it's a **raw material** (a leaf).
- Costs are read from each item's attributes, in this order: **Standard cost**, then
  **Purchase price**, then `0`. Set these on the item (New/Edit Item → costing fields).

## Steps

### See the rolled-up cost of one unit

1. Open **Production → Product Setup → Products & BOM** and click the product.
2. The detail panel shows **Std. material cost / unit**. Each direct BOM line also shows
   its **Std. cost** contribution — for a sub-assembly line this is the fully rolled-up
   figure (its own parts, recursively).

### Explode the full material requirements

1. In the same panel, find **Full material requirements (all levels)**.
2. Type the **Build qty** you're planning.
3. The table lists every raw material, the **total quantity** needed across the whole
   tree, the unit cost, and the line cost, with a **total material cost** in the footer.
4. Use this list as your pick list or purchasing shortlist.

### Check where a part is used

1. On any BOM line, click **Where used**.
2. You get every product and sub-assembly that consumes that part, each marked **direct**
   or **sub-assembly** (indirect).
3. You can also reach this from the item itself: `GET /api/inventory/<id>/where-used`.

## Tips & gotchas

- **Sub-assembly quantities multiply.** 2 wheels × 32 spokes + 2 spokes fitted directly
  on the frame = 66 spokes per bike. The explosion does this for you.
- **Keep costs current.** The roll-up is only as good as the Standard cost / Purchase
  price on your raw materials.
- **One BOM per product.** Editing the BOM replaces it — it does not append.
- A component can't be listed twice in the same BOM, and a product can't be a component
  of itself (the editor blocks both).

## If something goes wrong

| What you see | Why | Fix |
|---|---|---|
| ⚠ "This BOM references itself" | A sub-assembly's BOM eventually points back to the product (a loop). | Open the offending sub-assembly and remove the circular component so the structure forms a tree. |
| Cost shows "—" or looks low | Raw materials have no Standard cost / Purchase price set. | Edit those items and fill in a cost. |
| A part you expected is missing from the explosion | Its component id is dangling (the item was deleted) or the sub-assembly has no BOM. | Re-add the item, or define the sub-assembly's BOM. |
