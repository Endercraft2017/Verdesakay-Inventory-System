/**
 * Which permission an order needs, by its type. Sale and job orders are the orders module's
 * (orders.view / orders.create / orders.edit / orders.delete); purchase orders belong to
 * purchasing (purchasing.view to see, purchasing.manage to create / change / delete), the same
 * permissions as their goods receipts and vendor bills (modules/purchasing/purchasing.routes.ts).
 * One `orders` table holds all three types, so the routes check this per order.
 */
import { moduleEnabled } from '../../shared/modules';
import type { AuthUser, OrderType, Permission } from '../../shared/types';

type OrderAction = 'view' | 'create' | 'edit' | 'delete';

export function orderPermission(type: OrderType | string, action: OrderAction): Permission {
  if (type === 'purchase') return action === 'view' ? 'purchasing.view' : 'purchasing.manage';
  return `orders.${action}` as Permission;
}

export function canOnOrder(user: Pick<AuthUser, 'permissions'>, type: OrderType | string, action: OrderAction): boolean {
  return moduleEnabled(type === 'purchase' ? 'purchasing' : 'sales') && user.permissions.includes(orderPermission(type, action));
}

/** Order types this user may list. */
export function visibleOrderTypes(user: Pick<AuthUser, 'permissions'>): OrderType[] {
  const out: OrderType[] = [];
  if (moduleEnabled('sales') && user.permissions.includes('orders.view')) out.push('sale', 'job');
  if (moduleEnabled('purchasing') && user.permissions.includes('purchasing.view')) out.push('purchase');
  return out;
}
