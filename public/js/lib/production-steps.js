/* Shared "current step" labeling for the production pipeline: Job Order Creation →
   Parts Released → Accepted by Production → Actual Production → QC → QA → RTS Recording → Ready to Sell.
   Purely a display computation over fields the API already returns (job_orders.status,
   job_order_units.status/stage, job_orders.qc_stages, production_batches.status +
   receivable qty) — no new stored field. Used from both the desktop and mobile
   manufacturing screens so the step taxonomy only lives in one place.

   ProductionSteps.unitStep(unit, qcStages) — one serialized unit's current step.
   ProductionSteps.batchStep(batch, remainingQty, qcStages) — one non-serialized batch's.
   ProductionSteps.jobOrderStep(jobOrder) — a job order's overall step, from the list
   endpoint's units_pending/units_rework/units_passed/batches_receivable counts.
   Each returns { key, label, cls } — cls is a badge-pill class for consistent coloring. */
(function () {
  const LABELS = {
    created: 'Job Order Created',
    parts_released: 'Parts Released',
    accepted: 'Accepted by Production',
    in_production: 'In Production',
    qc: 'In QC',
    qa: 'In QA',
    qc_qa: 'In QC/QA',
    rework: 'In Rework',
    hold: 'QA Hold',
    rts_recording: 'Awaiting RTS Recording',
    ready_to_sell: 'Ready to Sell',
    sold: 'Sold',
    failed: 'Failed / Scrapped',
    paused: 'Paused',
    cancelled: 'Cancelled',
  };
  const CLASSES = {
    created: 'ok',
    parts_released: 'ok',
    accepted: 'ok',
    in_production: 'status-open',
    qc: 'status-open',
    qa: 'status-open',
    qc_qa: 'status-open',
    rework: 'status-confirmed',
    hold: 'status-confirmed',
    rts_recording: 'status-confirmed',
    ready_to_sell: 'status-completed',
    sold: 'status-completed',
    failed: 'status-cancelled',
    paused: 'status-confirmed',
    cancelled: 'status-cancelled',
  };

  function make(key) {
    return { key, label: LABELS[key] || key, cls: CLASSES[key] || 'ok' };
  }

  // The stage an inspection PASS number (1-based) represents, given how many stages this
  // job order runs. A single-stage job order runs its one inspection as QC and QA together.
  function passStep(passNum, totalStages) {
    if (totalStages <= 1) return 'qc_qa';
    return passNum >= totalStages ? 'qa' : 'qc';
  }

  // unit: { status, stage } from job_order_units. qcStages: the job order's qc_stages.
  function unitStep(unit, qcStages) {
    switch (unit.status) {
      case 'in_stock': case 'reserved': return make('ready_to_sell');
      case 'sold': return make('sold');
      case 'passed': return make('rts_recording');
      case 'failed': return make('failed');
      case 'rework': return make('rework');
      case 'hold': return make('hold');
      case 'pending': {
        const totalStages = Math.max(1, qcStages || 1);
        return make(passStep((unit.stage || 0) + 1, totalStages));
      }
      default: return make('in_production');
    }
  }

  // batch: { status } from production_batches. remainingQty: qty still unreceived (from
  // GET /job-orders/:id/receivable, or qty - SUM(production_receipt_items.quantity)).
  // qcStages: the job order's qc_stages (a batch's own sign-off is always one combined pass).
  function batchStep(batch, remainingQty, qcStages) {
    if (batch.status === 'open' && (qcStages || 0) > 0) return make('qc_qa');
    if ((remainingQty || 0) > 0) return make('rts_recording');
    return make('ready_to_sell');
  }

  // jo: one row from GET /job-orders (or GET /job-orders/:id), needs status plus the
  // list endpoint's units_pending / units_rework / units_passed / batches_receivable counts
  // (falsy/undefined counts are treated as 0, so this degrades gracefully on a single job
  // order's own detail response too).
  function jobOrderStep(jo) {
    if (jo.status === 'draft') return make('created');
    // released: waiting on the production lead to accept the kit until accepted_at is set.
    if (jo.status === 'released') return make(jo.accepted_at ? 'accepted' : 'parts_released');
    if (jo.status === 'paused') return make('paused');
    if (jo.status === 'cancelled') return make('cancelled');
    if (jo.status === 'completed') {
      return (jo.qty_done || 0) > 0 ? make('ready_to_sell') : make('cancelled');
    }
    // in_progress: report the furthest-along thing actually waiting on someone right now.
    const rework = jo.units_rework || 0;
    const pending = jo.units_pending || 0;
    const passed = jo.units_passed || 0;
    const receivable = jo.batches_receivable || 0;
    if ((jo.units_hold || 0) > 0) return make('hold');
    if (rework > 0) return make('rework');
    if (pending > 0) {
      const totalStages = Math.max(1, jo.qc_stages || 1);
      return make(totalStages <= 1 ? 'qc_qa' : 'qc');
    }
    if (passed > 0 || receivable > 0) return make('rts_recording');
    return make('in_production');
  }

  window.ProductionSteps = { unitStep, batchStep, jobOrderStep, LABELS };
})();
