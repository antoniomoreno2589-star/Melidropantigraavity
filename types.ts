export interface Product {
  id: string;
  title: string;
  sku: string; // Internal SKU
  asin: string; // Amazon ID
  meliId?: string; // Mercado Libre ID (if published)
  priceMXN: number;
  costUSD: number;
  stockProvider: number;
  stockMeli: number;
  status: 'active' | 'paused' | 'under_review' | 'not_yet_active' | 'payment_required' | 'inactive' | 'closed' | 'draft';
  imageUrl: string;
  lastUpdated: Date;
  inUpdater?: boolean; // Whether this product is included in auto-sync updates
  amazonSellerCount?: number | null; // Number of sellers on Amazon (null = not yet synced)
  soldByAmazon?: boolean | null;     // Whether Amazon itself is a seller (null = not yet synced)
  amazonStock?: number | null;       // Amazon inventory available (null = not yet synced, 0 = out of stock)
  amazonAvailable?: boolean | null;  // false = product not found/unavailable on Amazon
  pauseReason?: string | null;       // 'sin_buybox' = paused because no buybox detected
  shippingDays?: number | null;      // Amazon-scraped delivery days (null = not yet synced)
}

export interface Order {
  id: string;
  productTitle: string;
  buyerName: string;
  total: number;          // Gross ML sale amount
  netIncome: number;      // After ML commission + shipping (net_received_amount)
  mlCommission: number;   // ML marketplace fee (order_items[].sale_fee)
  shippingCost: number;   // Shipping cost charged to seller by ML
  meliItemId: string;     // ML item ID (for catalog cross-reference)
  quantity: number;       // Units sold in this order = Amazon pieces to buy
  status: 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
  date: string;           // YYYY-MM-DD
  shippingDeadline: string;
  amazonStatus: 'pending' | 'purchased';
  amazonPurchasePrice?: number; // Amazon cost at time of purchase
  amazonAsin: string;
  amazonMarketplace: 'US' | 'MX';
  hasReturn: boolean;           // Buyer opened a return/claim on this order
  returnShippingCost: number;   // Return shipping ML charged the seller (subtracts from profit)
}

export interface User {
  name: string;
  email: string;
  level: string; // e.g., "Mercado Líder"
  avatarUrl: string;
}

export interface Expense {
  id: number;
  concept: string;
  amount: number;
  period: string;
  year_month: string; // 'YYYY-MM'
}

export interface DashboardStats {
  questionsUnanswered: number;
  messagesUnread: number;
  salesToday: number;
  incomeToday: number;
  questionsToday: number;
  avgTicket: number;
}