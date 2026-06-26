/* ============================================================================
   Item form catalog — the DEFAULT, data-driven definition of the New/Edit Item
   modal (ECOUNT-style 7 tabs). Admins customize visibility / required / default
   via the modal's "Option" panel; that override is saved server-side and merged
   over these defaults by key (see mergeFormConfig in views/inventory.js).

   Field def: { key, label, tab, type, options?, default?, visible, required,
                core?, placeholder?, suffix?, help? }
   - tab  ∈ TABS ids.
   - type ∈ text | number | money | percent | textarea | select | radio |
            checkbox | department | search | static
            (search = free-text + search icon for lookups with no module yet;
             static = read-only visual row, e.g. Image / File / Inventory Qty).
   - core: true ⇒ maps to a real inventory_items column; everything else is
            persisted in the item's `attributes` JSON. CORE_KEYS lists the nine.
   - help: short tooltip shown by the "?" icon next to the field (hover + tap).

   Same dual export shape as nav-config.js: browser global + CommonJS for tests.
   ============================================================================ */

const ITEM_FORM_TABS = [
  { id: 'default', label: 'Default' },
  { id: 'info', label: 'Item Information' },
  { id: 'qty', label: 'Qty' },
  { id: 'price', label: 'Price' },
  { id: 'cost', label: 'Cost' },
  { id: 'additional', label: 'Additional Information' },
  { id: 'management', label: 'Management' },
];

/** The nine columns that exist on inventory_items (everything else ⇒ attributes). */
const ITEM_CORE_KEYS = [
  'name', 'sku', 'category', 'department_id',
  'quantity', 'unit', 'min_quantity', 'location', 'notes',
];

const USE_NOUSE = ['Use', 'Do Not Use'];
const DEFAULT_USE_RADIO = ['Default Settings (Do Not Use)', 'Use', 'Do Not Use'];
const REQ_OPT_RADIO = ['Default Settings (Optional)', 'Required', 'Optional', 'Do Not Use'];

const ITEM_FORM_DEFAULTS = [
  // ---------------- Default ----------------
  { key: 'sku', label: 'Item Code', tab: 'default', type: 'text', core: true, visible: true, required: false, placeholder: 'Auto / e.g. 00009', suffix: 'Fn', help: 'Unique code/SKU that identifies this item. Leave blank to set it manually.' },
  { key: 'name', label: 'Item Name', tab: 'default', type: 'text', core: true, visible: true, required: true, placeholder: 'Item Name', help: 'The item\'s display name. This field is required.' },
  { key: 'spec_type', label: 'Spec.', tab: 'default', type: 'radio', options: ['Spec. Name', 'Spec. Group', 'Spec. Calculation', 'Spec. Calculation Group'], default: 'Spec. Name', visible: true, required: false, help: 'How the item\'s specification is defined — by name, group, or calculation.' },
  { key: 'spec', label: 'Spec. value', tab: 'default', type: 'text', visible: true, required: false, placeholder: 'Spec.', help: 'The specification value or short description for this item.' },
  { key: 'unit', label: 'Unit', tab: 'default', type: 'text', core: true, default: 'pcs', visible: true, required: false, placeholder: 'Unit', help: 'Unit of measure used for stock counts (e.g. pcs, box, kg).' },
  { key: 'item_category', label: 'Item Category', tab: 'default', type: 'radio', options: ['Raw Material', 'Sub Material', 'Finished Goods', 'Semi-Finished Goods', 'Merchandise', 'Intangible Merchandise'], default: 'Merchandise', visible: true, required: false, help: 'Inventory/accounting classification of the item.' },
  { key: 'category', label: 'Category', tab: 'default', type: 'text', core: true, visible: true, required: false, placeholder: 'Category (used for filters)', help: 'Free-text category used for searching and filtering item lists.' },
  { key: 'department_id', label: 'Department', tab: 'default', type: 'department', core: true, visible: true, required: false, help: 'Department that owns or manages this item.' },
  { key: 'bundle_item_status', label: 'Bundle Item Status', tab: 'default', type: 'radio', options: USE_NOUSE, default: 'Do Not Use', visible: true, required: false, help: 'Whether this item is a bundle made up of other items.' },
  { key: 'inv_qty_management', label: 'Inv. Quantity Management', tab: 'default', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Track stock quantity for this item. Turn off for non-stock items.' },
  { key: 'production_process', label: 'Production Process', tab: 'default', type: 'search', visible: true, required: false, placeholder: 'Production Proc', help: 'Production routing/process associated with this item.' },
  { key: 'purchase_price', label: 'Purchase Price', tab: 'default', type: 'money', visible: true, required: false, placeholder: 'Purchase Price', help: 'Default price you pay to buy this item.' },
  { key: 'purchase_price_tax_incl', label: 'Purchase Price — Tax Included', tab: 'default', type: 'checkbox', default: false, visible: true, required: false, help: 'Tick if the purchase price already includes tax.' },
  { key: 'sale_price', label: 'Sale Price', tab: 'default', type: 'money', visible: true, required: false, placeholder: 'Sale Price', help: 'Default price you sell this item for.' },
  { key: 'sale_price_tax_incl', label: 'Sale Price — Tax Included', tab: 'default', type: 'checkbox', default: false, visible: true, required: false, help: 'Tick if the sale price already includes tax.' },
  { key: 'quantity', label: 'Inventory Qty', tab: 'default', type: 'number', core: true, default: 0, visible: true, required: false, help: 'Starting stock quantity recorded when the item is first created. Later changes go through Stock In/Out.' },

  // ---------------- Item Information ----------------
  { key: 'tax_rate_sales', label: 'Tax Rate (Sales)', tab: 'info', type: 'percent', visible: true, required: false, placeholder: 'Tax Rate (Sales)', help: 'Tax percentage applied when selling this item.' },
  { key: 'tax_rate_purchases', label: 'Tax Rate (Purchases)', tab: 'info', type: 'percent', visible: true, required: false, placeholder: 'Tax Rate (Purchases)', help: 'Tax percentage applied when purchasing this item.' },
  { key: 'barcode', label: 'Barcode', tab: 'info', type: 'text', visible: true, required: false, placeholder: 'Barcode', help: 'Barcode value used to scan this item.' },
  { key: 'production_process2', label: 'Production Process', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Production Proc', help: 'Secondary production process reference.' },
  { key: 'keyword', label: 'Keyword', tab: 'info', type: 'text', visible: true, required: false, placeholder: 'Keyword', help: 'Extra search keywords to help find this item.' },
  { key: 'enable_item_sharing', label: 'Enable Item Sharing (Share with C-Portal)', tab: 'info', type: 'checkbox', default: false, visible: true, required: false, help: 'Share this item with the customer portal (C-Portal).' },
  { key: 'image', label: 'Image', tab: 'info', type: 'static', visible: true, required: false, placeholder: 'Insert Image (not supported yet)', help: 'Item image. Attachment uploads are not supported yet.' },
  { key: 'file', label: 'File', tab: 'info', type: 'static', visible: true, required: false, placeholder: 'File (not supported yet)', help: 'Attached file. Uploads are not supported yet.' },
  { key: 'item_group_1', label: 'Item Group 1', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 1', help: 'Optional grouping used for reports and organization.' },
  { key: 'item_group_2', label: 'Item Group 2', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 2', help: 'Optional second grouping used for reports and organization.' },
  { key: 'item_group_3', label: 'Item Group 3', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 3', help: 'Optional third grouping used for reports and organization.' },
  { key: 'notes', label: 'Remark', tab: 'info', type: 'textarea', core: true, visible: true, required: false, placeholder: 'Remark', help: 'Internal notes or remarks about this item.' },
  { key: 'quality_inspection_type', label: 'Quality Inspection Type', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Quality Inspection Type', help: 'Type of quality inspection applied to this item.' },
  { key: 'qc_inspection_method', label: 'QC Inspection Method', tab: 'info', type: 'radio', options: ['Lot', 'Sampling(%)'], default: 'Lot', visible: true, required: false, help: 'Inspect every lot, or only a sampling percentage.' },
  { key: 'item_level_group', label: 'Item Level Group', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Level Group', help: 'Item level grouping for tiered pricing or classification.' },

  // ---------------- Qty ----------------
  { key: 'aux_qty_conv_from', label: 'Aux. Qty Conversion (from)', tab: 'qty', type: 'number', default: 1, visible: true, required: false, help: 'Auxiliary unit conversion ratio — left side (e.g. 1 box).' },
  { key: 'aux_qty_conv_to', label: 'Aux. Qty Conversion (to)', tab: 'qty', type: 'number', default: 1, visible: true, required: false, help: 'Auxiliary unit conversion ratio — right side (e.g. 12 pcs).' },
  { key: 'ssc_sales_order', label: 'Safety Stock — Sales Order', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include sales-order quantities when checking safety stock.' },
  { key: 'ssc_sales', label: 'Safety Stock — Sales', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include sales quantities when checking safety stock.' },
  { key: 'ssc_goods_issued', label: 'Safety Stock — Goods Issued', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include goods-issued quantities when checking safety stock.' },
  { key: 'ssc_goods_receipt', label: 'Safety Stock — Goods Receipt', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include goods-receipt quantities when checking safety stock.' },
  { key: 'ssc_location_tran', label: 'Safety Stock — Location Tran.', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include location-transfer quantities when checking safety stock.' },
  { key: 'ssc_internal_use', label: 'Safety Stock — Internal Use', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include internal-use quantities when checking safety stock.' },
  { key: 'ssc_product_defect', label: 'Safety Stock — Product Defect', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Include product-defect quantities when checking safety stock.' },
  { key: 'min_quantity', label: 'Safety Stock Quantity', tab: 'qty', type: 'number', core: true, default: 0, visible: true, required: false, placeholder: 'Safety Stock Quantity', help: 'Reorder threshold — at or below this quantity the item is flagged as low stock.' },
  { key: 'cportal_min_so_qty_check', label: 'C-Portal Min. S/O Qty Check', tab: 'qty', type: 'select', options: USE_NOUSE, default: 'Use', visible: true, required: false, help: 'Enforce a minimum sales-order quantity on the customer portal.' },
  { key: 'cportal_min_so_qty', label: 'C-Portal Min. S/O Qty', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'C-Portal Min. S/O Qty', help: 'Minimum quantity allowed per sales order on the customer portal.' },
  { key: 'cportal_min_so_unit', label: 'C-Portal Min. S/O Unit', tab: 'qty', type: 'select', options: USE_NOUSE, default: 'Do Not Use', visible: true, required: false, help: 'Unit used for the customer-portal minimum order quantity.' },
  { key: 'lead_time', label: 'Lead Time', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'Lead Time', help: 'Days between ordering this item and receiving it.' },
  { key: 'min_purchase_qty', label: 'Min. Purchase Qty', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'Min. Purchase Qty', help: 'Smallest quantity you can purchase at one time.' },
  { key: 'vendor', label: 'Vendor', tab: 'qty', type: 'search', visible: true, required: false, placeholder: 'Vendor', help: 'Default supplier for this item.' },

  // ---------------- Price (not in screenshots; sensible, hideable) ----------------
  { key: 'base_sale_price', label: 'Base Sale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Base Sale Price', help: 'Standard selling price before any discounts.' },
  { key: 'min_sale_price', label: 'Minimum Sale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Minimum Sale Price', help: 'Lowest price this item may be sold for.' },
  { key: 'wholesale_price', label: 'Wholesale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Wholesale Price', help: 'Price offered to wholesale customers.' },
  { key: 'currency', label: 'Currency', tab: 'price', type: 'select', options: ['PHP', 'USD', 'EUR', 'JPY'], default: 'PHP', visible: true, required: false, help: 'Currency used for this item\'s prices.' },

  // ---------------- Cost ----------------
  { key: 'oe_price', label: 'O/E Price', tab: 'cost', type: 'money', visible: true, required: false, placeholder: 'O/E Price', help: 'Outsourcing / external-processing price.' },
  { key: 'oe_price_tax_incl', label: 'O/E Price — Tax Included', tab: 'cost', type: 'checkbox', default: false, visible: true, required: false, help: 'Tick if the O/E price already includes tax.' },
  { key: 'std_labor_time', label: 'Standard Labor Time (Wage-Weighted)', tab: 'cost', type: 'number', default: 1, visible: true, required: false, help: 'Standard labor time used to weight wage costs.' },
  { key: 'overhead_weight', label: 'Weight for Allocating Overhead Cost', tab: 'cost', type: 'number', default: 1, visible: true, required: false, help: 'Weight used to allocate overhead cost to this item.' },
  { key: 'std_material_cost', label: 'Standard Material Cost', tab: 'cost', type: 'money', visible: true, required: false, placeholder: 'Standard Material Cost', help: 'Standard material cost per unit.' },
  { key: 'std_expenses', label: 'Standard Expenses', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false, help: 'Standard expense cost per unit.' },
  { key: 'std_labor_cost', label: 'Standard Labor Cost', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false, help: 'Standard labor cost per unit.' },
  { key: 'std_oe_cost', label: 'Standard O/E Cost', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false, help: 'Standard outsourcing / external cost per unit.' },

  // ---------------- Additional Information (not in screenshots; sensible) ----------------
  { key: 'location', label: 'Location', tab: 'additional', type: 'text', core: true, visible: true, required: false, placeholder: 'Location', help: 'Where the item is stored (shelf, bin, or warehouse).' },
  { key: 'manufacturer', label: 'Manufacturer', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Manufacturer', help: 'Company that makes this item.' },
  { key: 'model_no', label: 'Model No.', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Model No.', help: 'Manufacturer model or part number.' },
  { key: 'warranty_months', label: 'Warranty (months)', tab: 'additional', type: 'number', visible: true, required: false, help: 'Warranty length in months.' },
  { key: 'origin_country', label: 'Country of Origin', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Country of Origin', help: 'Country where the item is produced.' },

  // ---------------- Management ----------------
  { key: 'mgmt_field', label: 'Mgmt Field', tab: 'management', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: true, required: false, help: 'Whether the management field is required, optional, or unused.' },
  { key: 'serial_lot_no', label: 'Serial/Lot No.', tab: 'management', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: true, required: false, help: 'Whether serial / lot-number tracking is required, optional, or unused.' },
  { key: 'cms_sales', label: 'Create Manufacture Slip — Sales', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false, help: 'Auto-create a manufacture slip for sales transactions.' },
  { key: 'cms_location_tran', label: 'Create Manufacture Slip — Location Tran.', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false, help: 'Auto-create a manufacture slip for location transfers.' },
  { key: 'qir_purchases', label: 'Quality Insp. Request — Purchases', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false, help: 'Auto-create a quality-inspection request on purchases.' },
  { key: 'qir_goods_receipt', label: 'Quality Insp. Request — Goods Receipt', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false, help: 'Auto-create a quality-inspection request on goods receipt.' },
];

// Browser: globals (loaded via <script> before app.js). Node (tests): require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ITEM_FORM_TABS, ITEM_CORE_KEYS, ITEM_FORM_DEFAULTS };
}
