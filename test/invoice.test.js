const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

const date = '2021-11-15';
const mixedSlabItems = [
  { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
  { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 },
  { id: 3, name: 'Tea', hsn: '0902', price: 500, qty: 1 },
];

function recordOrder(items, coupon = '', db = { nextOrderId: 1, orders: [] }) {
  const billed = pricing.computeTotals(items, coupon);
  const order = orders.add(db, { ...billed, date, items, coupon });
  return { billed, order };
}

test('printed invoices and GST reconciliation agree with checkout for mixed HSN slabs and SAVE10', () => {
  const db = { nextOrderId: 1, orders: [] };
  const { order } = recordOrder(mixedSlabItems, 'SAVE10', db);
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures, {
    subtotal: 2500, discount: 150, tax: 244.4, cgst: 122.2, sgst: 122.2, total: 2594.4,
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 47], [12, 112.8], [18, 84.6],
  ]);
  assert.match(invoice.render(order), /Invoice Total<\/td><td class="r">₹2594\.40/);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.equal(reports.getGstReconciliation(db).mismatchCount, 0);
});

test('invoice and billing agree for an uncouponed item at the default GST rate', () => {
  const { order } = recordOrder([{ name: 'Groceries', price: 100, qty: 2 }]);
  assert.equal(order.tax, 36);
  assert.equal(order.total, 236);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 200,
    discount: 0,
    tax: 36,
    cgst: 18,
    sgst: 18,
    total: 236,
    rows: [{
      name: 'Groceries', sku: '-', hsn: '-', qty: 2, price: 100,
      gstPercent: 18, line: 200, lineTax: 36,
    }],
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('an uncouponed invoice uses the HSN slab for a recorded item without an explicit GST rate', () => {
  const { order } = recordOrder([{ name: 'Rice', hsn: '1006', price: 500, qty: 1 }]);
  const { rows: [row], tax, total } = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ gstPercent: row.gstPercent, lineTax: row.lineTax, tax, total }, {
    gstPercent: 5, lineTax: 25, tax: 25, total: 525,
  });
});

test('invoice rows use mixed HSN slabs and GST after the capped coupon discount', () => {
  const { billed, order } = recordOrder(mixedSlabItems, 'SAVE10');
  assert.deepEqual(
    billed.lines.map(({ gstPercent, discount, taxable, tax }) => [gstPercent, discount, taxable, tax]),
    [[5, 60, 940, 47], [12, 60, 940, 112.8], [18, 30, 470, 84.6]],
  );
  assert.equal(billed.cgst, 122.2);
  assert.equal(billed.sgst, 122.2);
  assert.equal(order.subtotal, 2500);
  assert.equal(order.discount, 150);
  assert.equal(order.tax, 244.4);
  assert.equal(order.total, 2594.4);

  const { rows, ...totals } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(totals, {
    subtotal: 2500, discount: 150, tax: 244.4, cgst: 122.2, sgst: 122.2, total: 2594.4,
  });
  assert.deepEqual(
    rows.map(({ gstPercent, line, lineTax }) => [gstPercent, line, lineTax]),
    [[5, 1000, 47], [12, 1000, 112.8], [18, 500, 84.6]],
  );

  const html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹47\.00<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹244\.40/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td class="r" style="color:#16a34a">-₹150\.00/);
});

test('an eligible flat coupon reduces GST on both checkout and the invoice', () => {
  const { order } = recordOrder([{ name: 'Tea', price: 400, qty: 1 }], 'FLAT50');
  assert.equal(order.discount, 50);
  assert.equal(order.tax, 63);
  assert.equal(order.total, 413);

  const { discount, tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, cgst, sgst, total }, {
    discount: 50, tax: 63, cgst: 31.5, sgst: 31.5, total: 413,
  });
});

for (const { label, coupon, price, billedTax, billedTotal } of [
  { label: 'an expired coupon', coupon: 'DIWALI20', price: 1000, billedTax: 180, billedTotal: 1180 },
  { label: 'a flat coupon below its minimum', coupon: 'FLAT50', price: 20, billedTax: 3.6, billedTotal: 23.6 },
]) {
  test(`the invoice ignores ${label} if present on a recorded order`, () => {
    const order = {
      id: 1, date, items: [{ name: 'Tea', price, qty: 1 }],
      coupon, subtotal: price, discount: 0, tax: billedTax, total: billedTotal,
    };
    const { discount, tax, total } = invoice.computeInvoiceFigures(order);
    assert.deepEqual({ discount, tax, total }, { discount: 0, tax: billedTax, total: billedTotal });
  });
}

test('the invoice honors explicit percentage, decimal, and zero GST rates', () => {
  const { billed, order } = recordOrder([
    { name: 'Percentage rate', price: 100, qty: 1, gstRate: 5 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
  ]);
  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [5, 5], [0, 0]]);
  assert.equal(order.tax, 10);
  assert.equal(order.total, 310);

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [5, 5], [0, 0]]);
  assert.equal(figures.tax, 10);
  assert.equal(figures.total, 310);
});

test('the invoice sums rounded line GST without a one-paisa mismatch', () => {
  const { billed, order } = recordOrder([
    { name: 'Rice', price: 10.09, qty: 1, gstRate: 5 },
    { name: 'Dal', price: 10.09, qty: 1, gstRate: 5 },
  ]);
  assert.deepEqual(billed.lines.map(({ tax }) => tax), [0.5, 0.5]);
  assert.equal(order.tax, 1);
  assert.equal(order.total, 21.18);

  const { rows, tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [0.5, 0.5]);
  assert.deepEqual({ tax, cgst, sgst, total }, { tax: 1, cgst: 0.5, sgst: 0.5, total: 21.18 });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reconciliation matches invoice GST for a WELCOME coupon order with the same total', () => {
  const db = { nextOrderId: 1, orders: [] };
  const { order } = recordOrder([{ name: 'Tea', price: 200, qty: 1 }], 'WELCOME', db);
  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(order.tax, 34.2);
  assert.equal(figures.discount, 10);
  assert.equal(figures.tax, 34.2);
  assert.equal(order.total, 224.2);
  assert.equal(figures.total, 224.2);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);

  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1, date, customer: 'Walk-in', coupon: 'WELCOME',
      ledgerSubtotal: 200, ledgerDiscount: 10, ledgerTax: 34.2, ledgerTotal: 224.2,
      invoiceDiscount: 10, invoiceTax: 34.2, invoiceTotal: 224.2, delta: 0, matched: true,
    }],
  });
});
