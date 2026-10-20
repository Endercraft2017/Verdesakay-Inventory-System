/* ============================================================================
   Item form catalog — the DEFAULT, data-driven definition of the New/Edit Item
   modal. Modeled on ECOUNT's 7-tab item master, but trimmed: only the fields the
   app actually uses are `visible: true` by default. The rest stay in the catalog
   (hidden) so future ERP modules — purchasing, pricing, production, QC — can
   switch their fields back on via the modal's "Option" panel without a code change.

   Visible by default:
     Essentials  — name, sku, spec, category, department, supplier, unit,
                   quantity, min_quantity (reorder level), location, notes.
     Optional    — currency, purchase_price, sale_price, barcode, manufacturer,
                   model_no, image. Reference info; a secondary set.
                   (`vendor` free-text is superseded by the `supplier` picker.)

   Admins customize visibility / required / default via the "Option" panel; that
   override is saved server-side and merged over these defaults by key (see
   mergeFormConfig in views/inventory.js).

   Field def: { key, label, tab, section, type, options?, default?, visible,
                required, core?, placeholder?, suffix?, help? }
   - tab      ∈ ITEM_FORM_TABS ids — which tab the field renders on in the form.
   - section  ∈ ITEM_FORM_SECTIONS ids — the capability group it belongs to;
              used only to group cards under headings in the "Option" panel so an
              admin can enable a whole capability (e.g. "Standard costing") at once.
   - type ∈ text | number | money | percent | textarea | select | radio |
            checkbox | department | supplier | search | combobox | image | static
            (search   = free-text + search icon for lookups with no module yet;
             combobox = type-to-filter picker; needs `source` (e.g. 'currencies');
             image    = upload + thumbnail, saved via POST /api/inventory/:id/image;
             static   = read-only visual row, e.g. File / Inventory Qty).
   - core: true ⇒ maps to a real inventory_items column; everything else is
            persisted in the item's `attributes` JSON. CORE_KEYS lists the nine.
   - help: short tooltip shown by the "?" icon next to the field (hover + tap).

   Same dual export shape as nav-config.js: browser global + CommonJS for tests.
   ============================================================================ */

const ITEM_FORM_TABS = [
  { id: 'default', label: 'Item details' },
  { id: 'price', label: 'Pricing' },
  { id: 'qty', label: 'Stock & location' },
  { id: 'info', label: 'More details' },
  { id: 'additional', label: 'Other information' },
  { id: 'cost', label: 'Advanced costs' },
  { id: 'management', label: 'Management' },
];

/** Capability groups — order here is the order headings appear in the Option panel. */
const ITEM_FORM_SECTIONS = [
  { id: 'identification', label: 'Identification' },
  { id: 'classification', label: 'Classification' },
  { id: 'stock', label: 'Stock & units' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'advanced-pricing', label: 'Advanced pricing' },
  { id: 'tax', label: 'Tax' },
  { id: 'standard-costing', label: 'Standard costing' },
  { id: 'purchasing', label: 'Purchasing & supplier' },
  { id: 'supply-planning', label: 'Supply planning' },
  { id: 'manufacturing', label: 'Manufacturing' },
  { id: 'quality', label: 'Quality control' },
  { id: 'serial-lot', label: 'Serial / lot tracking' },
  { id: 'customer-portal', label: 'Customer portal' },
  { id: 'attachments', label: 'Attachments' },
];

/** The columns that exist on inventory_items (everything else ⇒ attributes). */
const ITEM_CORE_KEYS = [
  'name', 'sku', 'category', 'department_id', 'supplier_id',
  'quantity', 'unit', 'min_quantity', 'unit_cost', 'location', 'notes', 'product_group',
];

const USE_NOUSE = ['Use', 'Do Not Use'];
const DEFAULT_USE_RADIO = ['Default Settings (Do Not Use)', 'Use', 'Do Not Use'];
const REQ_OPT_RADIO = ['Default Settings (Optional)', 'Required', 'Optional', 'Do Not Use'];

const ITEM_FORM_DEFAULTS = [
  // ---------------- Default ----------------
  { key: 'sku', label: 'Item Code', tab: 'default', section: 'identification', type: 'text', core: true, visible: true, required: false, placeholder: 'Auto / e.g. 00009', suffix: 'Fn', help: 'Unique code/SKU that identifies this item. Leave blank to set it manually.' },
  { key: 'name', label: 'Item Name', tab: 'default', section: 'identification', type: 'text', core: true, visible: true, required: true, placeholder: 'Item Name', help: 'The item\'s display name. This field is required.' },
  { key: 'spec', label: 'Spec.', tab: 'default', section: 'identification', type: 'text', visible: true, required: false, placeholder: 'e.g. 500ml, Red / XL, Grade A', help: 'The item\'s specification or variant — size, color, grade, dimensions. Included in the inventory search.' },
  { key: 'unit', label: 'Unit', tab: 'default', section: 'stock', type: 'text', core: true, default: 'pcs', visible: true, required: false, placeholder: 'Unit', help: 'Unit of measure used for stock counts (e.g. pcs, box, kg).' },
  { key: 'item_category', label: 'Item Category', tab: 'default', section: 'classification', type: 'radio', options: ['Raw Material', 'Sub Material', 'Finished Goods', 'Semi-Finished Goods', 'Merchandise', 'Intangible Merchandise'], default: 'Merchandise', visible: false, required: false, help: 'Inventory/accounting classification of the item.' },
  { key: 'category', label: 'Category', tab: 'default', section: 'classification', type: 'text', core: true, visible: true, required: false, placeholder: 'Category (used for filters)', help: 'Free-text category used for searching and filtering item lists.' },
  { key: 'product_group', label: 'Product Group', tab: 'default', section: 'classification', type: 'text', core: true, visible: true, required: false, placeholder: 'e.g. Office Chair', help: 'Groups variants of the same base product (e.g. "Office Chair" for Red/Blue/Green rows) so they list, filter, and get picked together. Each variant still stays its own full item with its own stock — put the variant\'s own color/size/spec in the Spec. field above, not here.' },
  { key: 'department_id', label: 'Department', tab: 'default', section: 'classification', type: 'department', core: true, visible: true, required: false, help: 'Department that owns or manages this item.' },
  { key: 'supplier_id', label: 'Supplier', tab: 'default', section: 'purchasing', type: 'supplier', core: true, visible: true, required: false, help: 'Default supplier / vendor for this item. Pick from the Suppliers registry (Inventory → Suppliers); filterable on the item list.' },
  { key: 'bundle_item_status', label: 'Bundle Item Status', tab: 'default', section: 'manufacturing', type: 'radio', options: USE_NOUSE, default: 'Do Not Use', visible: false, required: false, help: 'Whether this item is a bundle made up of other items.' },
  { key: 'inv_qty_management', label: 'Inv. Quantity Management', tab: 'default', section: 'stock', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Track stock quantity for this item. Turn off for non-stock items.' },
  { key: 'production_process', label: 'Production Process', tab: 'default', section: 'manufacturing', type: 'search', visible: false, required: false, placeholder: 'Production Proc', help: 'Production routing/process associated with this item.' },
  { key: 'currency', label: 'Currency', tab: 'price', section: 'pricing', type: 'combobox', source: 'currencies', default: 'PHP', visible: true, required: false, placeholder: 'Type a code or name…', help: 'Currency for this item\'s purchase and sale prices. Type to search all ISO 4217 currencies.' },
  { key: 'purchase_price', label: 'Purchase Price', tab: 'price', section: 'pricing', type: 'money', visible: true, required: false, placeholder: 'Purchase Price', help: 'Default price you pay to buy this item.' },
  { key: 'purchase_price_tax_incl', label: 'Purchase Price — Tax Included', tab: 'price', section: 'tax', type: 'checkbox', default: false, visible: false, required: false, help: 'Tick if the purchase price already includes tax.' },
  { key: 'sale_price', label: 'Sale Price', tab: 'price', section: 'pricing', type: 'money', visible: true, required: false, placeholder: 'Sale Price', help: 'Default price you sell this item for. Prefills the price when this item is added to an order.' },
  { key: 'unit_cost', label: 'Standard Cost', tab: 'price', section: 'pricing', type: 'money', core: true, default: 0, visible: true, required: false, placeholder: 'Standard Cost', help: 'Standard unit cost used to value this item as a raw material into Work in Process and as finished goods out of it when a job order posts to the general ledger (Accounting → Books). 0 until set.' },
  { key: 'sale_price_tax_incl', label: 'Sale Price — Tax Included', tab: 'price', section: 'tax', type: 'checkbox', default: false, visible: false, required: false, help: 'Tick if the sale price already includes tax.' },
  { key: 'quantity', label: 'Opening stock quantity', tab: 'qty', section: 'stock', type: 'number', core: true, default: 0, visible: true, required: false, help: 'Starting stock quantity recorded when the item is first created. Later changes go through Stock In/Out.' },

  // ---------------- Item Information ----------------
  { key: 'tax_rate_sales', label: 'Tax Rate (Sales)', tab: 'info', section: 'tax', type: 'percent', visible: false, required: false, placeholder: 'Tax Rate (Sales)', help: 'Tax percentage applied when selling this item.' },
  { key: 'tax_rate_purchases', label: 'Tax Rate (Purchases)', tab: 'info', section: 'tax', type: 'percent', visible: false, required: false, placeholder: 'Tax Rate (Purchases)', help: 'Tax percentage applied when purchasing this item.' },
  { key: 'barcode', label: 'Barcode', tab: 'info', section: 'identification', type: 'text', visible: true, required: false, placeholder: 'Barcode', help: 'Barcode value used to scan this item.' },
  { key: 'production_process2', label: 'Production Process', tab: 'info', section: 'manufacturing', type: 'search', visible: false, required: false, placeholder: 'Production Proc', help: 'Secondary production process reference.' },
  { key: 'keyword', label: 'Keyword', tab: 'info', section: 'classification', type: 'text', visible: false, required: false, placeholder: 'Keyword', help: 'Extra search keywords to help find this item.' },
  { key: 'enable_item_sharing', label: 'Enable Item Sharing (Share with C-Portal)', tab: 'info', section: 'customer-portal', type: 'checkbox', default: false, visible: false, required: false, help: 'Share this item with the customer portal (C-Portal).' },
  { key: 'image', label: 'Image', tab: 'info', section: 'attachments', type: 'image', visible: true, required: false, placeholder: 'PNG, JPG, GIF or WebP — up to 5 MB', help: 'A photo of the item. Shown on the item form; uploaded when you save.' },
  { key: 'file', label: 'File', tab: 'info', section: 'attachments', type: 'static', visible: false, required: false, placeholder: 'File (not supported yet)', help: 'Attached file. Uploads are not supported yet.' },
  { key: 'item_group_1', label: 'Item Group 1', tab: 'info', section: 'classification', type: 'search', visible: false, required: false, placeholder: 'Item Group 1', help: 'Optional grouping used for reports and organization.' },
  { key: 'item_group_2', label: 'Item Group 2', tab: 'info', section: 'classification', type: 'search', visible: false, required: false, placeholder: 'Item Group 2', help: 'Optional second grouping used for reports and organization.' },
  { key: 'item_group_3', label: 'Item Group 3', tab: 'info', section: 'classification', type: 'search', visible: false, required: false, placeholder: 'Item Group 3', help: 'Optional third grouping used for reports and organization.' },
  { key: 'notes', label: 'Remark', tab: 'info', section: 'identification', type: 'textarea', core: true, visible: true, required: false, placeholder: 'Remark', help: 'Internal notes or remarks about this item.' },
  { key: 'quality_inspection_type', label: 'Quality Inspection Type', tab: 'info', section: 'quality', type: 'search', visible: false, required: false, placeholder: 'Quality Inspection Type', help: 'Type of quality inspection applied to this item.' },
  { key: 'qc_inspection_method', label: 'QC Inspection Method', tab: 'info', section: 'quality', type: 'radio', options: ['Lot', 'Sampling(%)'], default: 'Lot', visible: false, required: false, help: 'Inspect every lot, or only a sampling percentage.' },
  { key: 'item_level_group', label: 'Item Level Group', tab: 'info', section: 'classification', type: 'search', visible: false, required: false, placeholder: 'Item Level Group', help: 'Item level grouping for tiered pricing or classification.' },

  // ---------------- Qty ----------------
  { key: 'aux_qty_conv_from', label: 'Aux. Qty Conversion (from)', tab: 'qty', section: 'stock', type: 'number', default: 1, visible: false, required: false, help: 'Auxiliary unit conversion ratio — left side (e.g. 1 box).' },
  { key: 'aux_qty_conv_to', label: 'Aux. Qty Conversion (to)', tab: 'qty', section: 'stock', type: 'number', default: 1, visible: false, required: false, help: 'Auxiliary unit conversion ratio — right side (e.g. 12 pcs).' },
  { key: 'ssc_sales_order', label: 'Safety Stock — Sales Order', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include sales-order quantities when checking safety stock.' },
  { key: 'ssc_sales', label: 'Safety Stock — Sales', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include sales quantities when checking safety stock.' },
  { key: 'ssc_goods_issued', label: 'Safety Stock — Goods Issued', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include goods-issued quantities when checking safety stock.' },
  { key: 'ssc_goods_receipt', label: 'Safety Stock — Goods Receipt', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include goods-receipt quantities when checking safety stock.' },
  { key: 'ssc_location_tran', label: 'Safety Stock — Location Tran.', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include location-transfer quantities when checking safety stock.' },
  { key: 'ssc_internal_use', label: 'Safety Stock — Internal Use', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include internal-use quantities when checking safety stock.' },
  { key: 'ssc_product_defect', label: 'Safety Stock — Product Defect', tab: 'qty', section: 'supply-planning', type: 'radio', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Include product-defect quantities when checking safety stock.' },
  { key: 'min_quantity', label: 'Safety Stock Quantity', tab: 'qty', section: 'stock', type: 'number', core: true, default: 0, visible: true, required: false, placeholder: 'Safety Stock Quantity', help: 'Reorder threshold — at or below this quantity the item is flagged as low stock.' },
  { key: 'cportal_min_so_qty_check', label: 'C-Portal Min. S/O Qty Check', tab: 'qty', section: 'customer-portal', type: 'select', options: USE_NOUSE, default: 'Use', visible: false, required: false, help: 'Enforce a minimum sales-order quantity on the customer portal.' },
  { key: 'cportal_min_so_qty', label: 'C-Portal Min. S/O Qty', tab: 'qty', section: 'customer-portal', type: 'number', visible: false, required: false, placeholder: 'C-Portal Min. S/O Qty', help: 'Minimum quantity allowed per sales order on the customer portal.' },
  { key: 'cportal_min_so_unit', label: 'C-Portal Min. S/O Unit', tab: 'qty', section: 'customer-portal', type: 'select', options: USE_NOUSE, default: 'Do Not Use', visible: false, required: false, help: 'Unit used for the customer-portal minimum order quantity.' },
  { key: 'lead_time', label: 'Lead Time', tab: 'qty', section: 'purchasing', type: 'number', visible: false, required: false, placeholder: 'Lead Time', help: 'Days between ordering this item and receiving it.' },
  { key: 'min_purchase_qty', label: 'Min. Purchase Qty', tab: 'qty', section: 'purchasing', type: 'number', visible: false, required: false, placeholder: 'Min. Purchase Qty', help: 'Smallest quantity you can purchase at one time.' },
  { key: 'vendor', label: 'Vendor (legacy free-text)', tab: 'qty', section: 'purchasing', type: 'search', visible: false, required: false, placeholder: 'Vendor', help: 'Superseded by the Supplier picker on Item details. Kept for items entered before the Suppliers registry existed.' },

  // ---------------- Price — "Advanced pricing" (hidden until enabled) ----------------
  // Currency and everyday prices live above on this tab; the rest below are
  // channel/guardrail prices a bigger operation switches on as a group.
  { key: 'base_sale_price', label: 'Base Sale Price', tab: 'price', section: 'advanced-pricing', type: 'money', visible: false, required: false, placeholder: 'Base Sale Price', help: 'Standard selling price before any discounts. Overlaps the usual Sale Price on this tab.' },
  { key: 'min_sale_price', label: 'Minimum Sale Price', tab: 'price', section: 'advanced-pricing', type: 'money', visible: false, required: false, placeholder: 'Minimum Sale Price', help: 'Lowest price this item may be sold for — a guardrail for negotiated sales.' },
  { key: 'wholesale_price', label: 'Wholesale Price', tab: 'price', section: 'advanced-pricing', type: 'money', visible: false, required: false, placeholder: 'Wholesale Price', help: 'Price offered to wholesale customers.' },

  // ---------------- Cost — "Standard costing" (hidden until enabled) ----------------
  { key: 'oe_price', label: 'O/E Price', tab: 'cost', section: 'standard-costing', type: 'money', visible: false, required: false, placeholder: 'O/E Price', help: 'Outsourcing / external-processing price.' },
  { key: 'oe_price_tax_incl', label: 'O/E Price — Tax Included', tab: 'cost', section: 'standard-costing', type: 'checkbox', default: false, visible: false, required: false, help: 'Tick if the O/E price already includes tax.' },
  { key: 'std_labor_time', label: 'Standard Labor Time (Wage-Weighted)', tab: 'cost', section: 'standard-costing', type: 'number', default: 1, visible: false, required: false, help: 'Standard labor time used to weight wage costs.' },
  { key: 'overhead_weight', label: 'Weight for Allocating Overhead Cost', tab: 'cost', section: 'standard-costing', type: 'number', default: 1, visible: false, required: false, help: 'Weight used to allocate overhead cost to this item.' },
  { key: 'std_material_cost', label: 'Standard Material Cost', tab: 'cost', section: 'standard-costing', type: 'money', visible: false, required: false, placeholder: 'Standard Material Cost', help: 'Standard material cost per unit.' },
  { key: 'std_expenses', label: 'Standard Expenses', tab: 'cost', section: 'standard-costing', type: 'money', default: '0.00', visible: false, required: false, help: 'Standard expense cost per unit.' },
  { key: 'std_labor_cost', label: 'Standard Labor Cost', tab: 'cost', section: 'standard-costing', type: 'money', default: '0.00', visible: false, required: false, help: 'Standard labor cost per unit. For a finished product this is added on top of the rolled-up material cost for the standard unit cost, and values finished units into stock. Also editable from Production → Finished Products.' },
  { key: 'std_overhead_cost', label: 'Standard Overhead Cost', tab: 'cost', section: 'standard-costing', type: 'money', default: '0.00', visible: false, required: false, help: 'Standard overhead cost per unit. For a finished product this is added on top of material + labor for the standard unit cost. Also editable from Production → Finished Products.' },
  { key: 'std_oe_cost', label: 'Standard O/E Cost', tab: 'cost', section: 'standard-costing', type: 'money', default: '0.00', visible: false, required: false, help: 'Standard outsourcing / external cost per unit.' },

  // ---------------- Additional Information ----------------
  { key: 'location', label: 'Legacy location note', tab: 'additional', section: 'stock', type: 'text', core: true, visible: true, required: false, placeholder: 'Old shelf or bin note', help: 'Descriptive note only. Use Starting-stock location and stock moves for counted warehouse, room, shelf or bin quantities.' },
  { key: 'manufacturer', label: 'Manufacturer', tab: 'additional', section: 'purchasing', type: 'text', visible: true, required: false, placeholder: 'Manufacturer', help: 'Company that makes this item.' },
  { key: 'model_no', label: 'Model No.', tab: 'additional', section: 'purchasing', type: 'text', visible: true, required: false, placeholder: 'Model No.', help: 'Manufacturer model or part number.' },
  { key: 'warranty_months', label: 'Warranty (months)', tab: 'additional', section: 'purchasing', type: 'number', visible: false, required: false, help: 'Warranty length in months.' },
  { key: 'origin_country', label: 'Country of Origin', tab: 'additional', section: 'purchasing', type: 'text', visible: false, required: false, placeholder: 'Country of Origin', help: 'Country where the item is produced.' },

  // ---------------- Management ----------------
  { key: 'mgmt_field', label: 'Mgmt Field', tab: 'management', section: 'serial-lot', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: false, required: false, help: 'Whether the management field is required, optional, or unused.' },
  { key: 'serial_lot_no', label: 'Serial/Lot No.', tab: 'management', section: 'serial-lot', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: false, required: false, help: 'Whether serial / lot-number tracking is required, optional, or unused.' },
  { key: 'cms_sales', label: 'Create Manufacture Slip — Sales', tab: 'management', section: 'manufacturing', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: false, required: false, help: 'Auto-create a manufacture slip for sales transactions.' },
  { key: 'cms_location_tran', label: 'Create Manufacture Slip — Location Tran.', tab: 'management', section: 'manufacturing', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: false, required: false, help: 'Auto-create a manufacture slip for location transfers.' },
  { key: 'qir_purchases', label: 'Quality Insp. Request — Purchases', tab: 'management', section: 'quality', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: false, required: false, help: 'Auto-create a quality-inspection request on purchases.' },
  { key: 'qir_goods_receipt', label: 'Quality Insp. Request — Goods Receipt', tab: 'management', section: 'quality', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: false, required: false, help: 'Auto-create a quality-inspection request on goods receipt.' },
];

// Browser: globals (loaded via <script> before app.js). Node (tests): require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ITEM_FORM_TABS, ITEM_FORM_SECTIONS, ITEM_CORE_KEYS, ITEM_FORM_DEFAULTS };
}
