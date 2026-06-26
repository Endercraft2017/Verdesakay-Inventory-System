/* ============================================================================
   Item form catalog — the DEFAULT, data-driven definition of the New/Edit Item
   modal (ECOUNT-style 7 tabs). Admins customize visibility / required / default
   via the modal's "Option" panel; that override is saved server-side and merged
   over these defaults by key (see mergeFormConfig in views/inventory.js).

   Field def: { key, label, tab, type, options?, default?, visible, required,
                core?, placeholder?, suffix? }
   - tab  ∈ TABS ids.
   - type ∈ text | number | money | percent | textarea | select | radio |
            checkbox | department | search | static
            (search = free-text + search icon for lookups with no module yet;
             static = read-only visual row, e.g. Image / File / Inventory Qty).
   - core: true ⇒ maps to a real inventory_items column; everything else is
            persisted in the item's `attributes` JSON. CORE_KEYS lists the nine.

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
  { key: 'sku', label: 'Item Code', tab: 'default', type: 'text', core: true, visible: true, required: false, placeholder: 'Auto / e.g. 00009', suffix: 'Fn' },
  { key: 'name', label: 'Item Name', tab: 'default', type: 'text', core: true, visible: true, required: true, placeholder: 'Item Name' },
  { key: 'spec_type', label: 'Spec.', tab: 'default', type: 'radio', options: ['Spec. Name', 'Spec. Group', 'Spec. Calculation', 'Spec. Calculation Group'], default: 'Spec. Name', visible: true, required: false },
  { key: 'spec', label: 'Spec. value', tab: 'default', type: 'text', visible: true, required: false, placeholder: 'Spec.' },
  { key: 'unit', label: 'Unit', tab: 'default', type: 'text', core: true, default: 'pcs', visible: true, required: false, placeholder: 'Unit' },
  { key: 'item_category', label: 'Item Category', tab: 'default', type: 'radio', options: ['Raw Material', 'Sub Material', 'Finished Goods', 'Semi-Finished Goods', 'Merchandise', 'Intangible Merchandise'], default: 'Merchandise', visible: true, required: false },
  { key: 'category', label: 'Category', tab: 'default', type: 'text', core: true, visible: true, required: false, placeholder: 'Category (used for filters)' },
  { key: 'department_id', label: 'Department', tab: 'default', type: 'department', core: true, visible: true, required: false },
  { key: 'bundle_item_status', label: 'Bundle Item Status', tab: 'default', type: 'radio', options: USE_NOUSE, default: 'Do Not Use', visible: true, required: false },
  { key: 'inv_qty_management', label: 'Inv. Quantity Management', tab: 'default', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'production_process', label: 'Production Process', tab: 'default', type: 'search', visible: true, required: false, placeholder: 'Production Proc' },
  { key: 'purchase_price', label: 'Purchase Price', tab: 'default', type: 'money', visible: true, required: false, placeholder: 'Purchase Price' },
  { key: 'purchase_price_tax_incl', label: 'Purchase Price — Tax Included', tab: 'default', type: 'checkbox', default: false, visible: true, required: false },
  { key: 'sale_price', label: 'Sale Price', tab: 'default', type: 'money', visible: true, required: false, placeholder: 'Sale Price' },
  { key: 'sale_price_tax_incl', label: 'Sale Price — Tax Included', tab: 'default', type: 'checkbox', default: false, visible: true, required: false },
  { key: 'quantity', label: 'Inventory Qty', tab: 'default', type: 'number', core: true, default: 0, visible: true, required: false },

  // ---------------- Item Information ----------------
  { key: 'tax_rate_sales', label: 'Tax Rate (Sales)', tab: 'info', type: 'percent', visible: true, required: false, placeholder: 'Tax Rate (Sales)' },
  { key: 'tax_rate_purchases', label: 'Tax Rate (Purchases)', tab: 'info', type: 'percent', visible: true, required: false, placeholder: 'Tax Rate (Purchases)' },
  { key: 'barcode', label: 'Barcode', tab: 'info', type: 'text', visible: true, required: false, placeholder: 'Barcode' },
  { key: 'production_process2', label: 'Production Process', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Production Proc' },
  { key: 'keyword', label: 'Keyword', tab: 'info', type: 'text', visible: true, required: false, placeholder: 'Keyword' },
  { key: 'enable_item_sharing', label: 'Enable Item Sharing (Share with C-Portal)', tab: 'info', type: 'checkbox', default: false, visible: true, required: false },
  { key: 'image', label: 'Image', tab: 'info', type: 'static', visible: true, required: false, placeholder: 'Insert Image (not supported yet)' },
  { key: 'file', label: 'File', tab: 'info', type: 'static', visible: true, required: false, placeholder: 'File (not supported yet)' },
  { key: 'item_group_1', label: 'Item Group 1', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 1' },
  { key: 'item_group_2', label: 'Item Group 2', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 2' },
  { key: 'item_group_3', label: 'Item Group 3', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Group 3' },
  { key: 'notes', label: 'Remark', tab: 'info', type: 'textarea', core: true, visible: true, required: false, placeholder: 'Remark' },
  { key: 'quality_inspection_type', label: 'Quality Inspection Type', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Quality Inspection Type' },
  { key: 'qc_inspection_method', label: 'QC Inspection Method', tab: 'info', type: 'radio', options: ['Lot', 'Sampling(%)'], default: 'Lot', visible: true, required: false },
  { key: 'item_level_group', label: 'Item Level Group', tab: 'info', type: 'search', visible: true, required: false, placeholder: 'Item Level Group' },

  // ---------------- Qty ----------------
  { key: 'aux_qty_conv_from', label: 'Aux. Qty Conversion (from)', tab: 'qty', type: 'number', default: 1, visible: true, required: false },
  { key: 'aux_qty_conv_to', label: 'Aux. Qty Conversion (to)', tab: 'qty', type: 'number', default: 1, visible: true, required: false },
  { key: 'ssc_sales_order', label: 'Safety Stock — Sales Order', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_sales', label: 'Safety Stock — Sales', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_goods_issued', label: 'Safety Stock — Goods Issued', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_goods_receipt', label: 'Safety Stock — Goods Receipt', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_location_tran', label: 'Safety Stock — Location Tran.', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_internal_use', label: 'Safety Stock — Internal Use', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'ssc_product_defect', label: 'Safety Stock — Product Defect', tab: 'qty', type: 'radio', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'min_quantity', label: 'Safety Stock Quantity', tab: 'qty', type: 'number', core: true, default: 0, visible: true, required: false, placeholder: 'Safety Stock Quantity' },
  { key: 'cportal_min_so_qty_check', label: 'C-Portal Min. S/O Qty Check', tab: 'qty', type: 'select', options: USE_NOUSE, default: 'Use', visible: true, required: false },
  { key: 'cportal_min_so_qty', label: 'C-Portal Min. S/O Qty', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'C-Portal Min. S/O Qty' },
  { key: 'cportal_min_so_unit', label: 'C-Portal Min. S/O Unit', tab: 'qty', type: 'select', options: USE_NOUSE, default: 'Do Not Use', visible: true, required: false },
  { key: 'lead_time', label: 'Lead Time', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'Lead Time' },
  { key: 'min_purchase_qty', label: 'Min. Purchase Qty', tab: 'qty', type: 'number', visible: true, required: false, placeholder: 'Min. Purchase Qty' },
  { key: 'vendor', label: 'Vendor', tab: 'qty', type: 'search', visible: true, required: false, placeholder: 'Vendor' },

  // ---------------- Price (not in screenshots; sensible, hideable) ----------------
  { key: 'base_sale_price', label: 'Base Sale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Base Sale Price' },
  { key: 'min_sale_price', label: 'Minimum Sale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Minimum Sale Price' },
  { key: 'wholesale_price', label: 'Wholesale Price', tab: 'price', type: 'money', visible: true, required: false, placeholder: 'Wholesale Price' },
  { key: 'currency', label: 'Currency', tab: 'price', type: 'select', options: ['PHP', 'USD', 'EUR', 'JPY'], default: 'PHP', visible: true, required: false },

  // ---------------- Cost ----------------
  { key: 'oe_price', label: 'O/E Price', tab: 'cost', type: 'money', visible: true, required: false, placeholder: 'O/E Price' },
  { key: 'oe_price_tax_incl', label: 'O/E Price — Tax Included', tab: 'cost', type: 'checkbox', default: false, visible: true, required: false },
  { key: 'std_labor_time', label: 'Standard Labor Time (Wage-Weighted)', tab: 'cost', type: 'number', default: 1, visible: true, required: false },
  { key: 'overhead_weight', label: 'Weight for Allocating Overhead Cost', tab: 'cost', type: 'number', default: 1, visible: true, required: false },
  { key: 'std_material_cost', label: 'Standard Material Cost', tab: 'cost', type: 'money', visible: true, required: false, placeholder: 'Standard Material Cost' },
  { key: 'std_expenses', label: 'Standard Expenses', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false },
  { key: 'std_labor_cost', label: 'Standard Labor Cost', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false },
  { key: 'std_oe_cost', label: 'Standard O/E Cost', tab: 'cost', type: 'money', default: '0.00', visible: true, required: false },

  // ---------------- Additional Information (not in screenshots; sensible) ----------------
  { key: 'location', label: 'Location', tab: 'additional', type: 'text', core: true, visible: true, required: false, placeholder: 'Location' },
  { key: 'manufacturer', label: 'Manufacturer', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Manufacturer' },
  { key: 'model_no', label: 'Model No.', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Model No.' },
  { key: 'warranty_months', label: 'Warranty (months)', tab: 'additional', type: 'number', visible: true, required: false },
  { key: 'origin_country', label: 'Country of Origin', tab: 'additional', type: 'text', visible: true, required: false, placeholder: 'Country of Origin' },

  // ---------------- Management ----------------
  { key: 'mgmt_field', label: 'Mgmt Field', tab: 'management', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: true, required: false },
  { key: 'serial_lot_no', label: 'Serial/Lot No.', tab: 'management', type: 'radio', options: REQ_OPT_RADIO, default: 'Default Settings (Optional)', visible: true, required: false },
  { key: 'cms_sales', label: 'Create Manufacture Slip — Sales', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false },
  { key: 'cms_location_tran', label: 'Create Manufacture Slip — Location Tran.', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false },
  { key: 'qir_purchases', label: 'Quality Insp. Request — Purchases', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false },
  { key: 'qir_goods_receipt', label: 'Quality Insp. Request — Goods Receipt', tab: 'management', type: 'radio', options: DEFAULT_USE_RADIO, default: 'Default Settings (Do Not Use)', visible: true, required: false },
];

// Browser: globals (loaded via <script> before app.js). Node (tests): require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ITEM_FORM_TABS, ITEM_CORE_KEYS, ITEM_FORM_DEFAULTS };
}
