const assert = require('node:assert/strict');
const test = require('node:test');

const inventory = require('../lib/inventory');
const orders = require('../lib/orders');

function productsWithOneSellableUnitEach() {
  return [
    { id: 1, name: 'A2 Gir Cow Ghee 500ml', sku: 'DRY-001', stock: 1 },
    { id: 2, name: 'Byadgi Chilli Powder', sku: 'SPC-001', stock: 4, reserved: 3 },
  ];
}

test('checkout can sell the last sellable unit of each SKU', () => {
  const products = productsWithOneSellableUnitEach();
  const items = [{ id: 1, qty: 1 }, { id: 2, qty: 1 }];

  assert.deepEqual(inventory.check(products, items), { ok: true });
  inventory.reserve(products, items);

  assert.deepEqual(products.map(({ stock }) => stock), [0, 3]);
  assert.deepEqual(products.map(inventory.getSellableStock), [0, 0]);
  assert.equal(products[1].reserved, 3);
});

test('checkout can sell the exact remaining stock across multiple lines for one SKU', () => {
  const products = [{ id: 2, name: 'Byadgi Chilli Powder', stock: 7, reserved: 3 }];
  const items = [{ id: 2, qty: 1 }, { id: '2', qty: 3 }];

  assert.deepEqual(inventory.check(products, items), { ok: true });
  inventory.reserve(products, items);
  assert.equal(products[0].stock, 3);
  assert.equal(products[0].reserved, 3);
});

test('checkout rejects quantities above sellable stock, including repeated SKU lines', () => {
  const products = [{ id: 2, name: 'Byadgi Chilli Powder', stock: 6, reserved: 3 }];
  const rejection = {
    ok: false,
    msg: 'Byadgi Chilli Powder is out of stock (3 sellable available)',
  };

  assert.deepEqual(inventory.check(products, [{ id: 2, qty: 4 }]), rejection);
  assert.deepEqual(inventory.check(products, [{ id: 2, qty: 2 }, { id: '2', qty: 2 }]), rejection);
  assert.equal(products[0].stock, 6);
  assert.equal(products[0].reserved, 3);
});

test('canceling a pending order restores physical stock and can only happen once', () => {
  const db = { products: productsWithOneSellableUnitEach(), orders: [], nextOrderId: 1007 };
  const items = [{ id: 1, qty: 2 }, { id: 2, qty: 3 }];
  const order = orders.add(db, { status: 'pending', items });

  assert.deepEqual(orders.cancel(db, '1007', 'Operator request'), { ok: true, order });
  assert.equal(order.status, 'cancelled');
  assert.equal(order.cancelReason, 'Operator request');
  assert.deepEqual(db.products.map(({ stock }) => stock), [3, 7]);
  assert.deepEqual(db.products.map(inventory.getSellableStock), [3, 4]);
  assert.equal(db.products[1].reserved, 3);

  assert.deepEqual(orders.cancel(db, 1007), { ok: false, error: 'Order #1007 is already cancelled' });
  assert.deepEqual(db.products.map(({ stock }) => stock), [3, 7]);
});

test('releasing a wholesale quote changes only the reserved quantity', () => {
  const products = productsWithOneSellableUnitEach();
  inventory.release(products, [{ productId: 2, qty: 2 }]);

  assert.equal(products[1].stock, 4);
  assert.equal(products[1].reserved, 1);
  assert.equal(inventory.getSellableStock(products[1]), 3);
});
