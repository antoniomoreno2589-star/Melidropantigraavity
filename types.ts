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
}

export interface Order {
  id: string;
  productTitle: string;
  buyerName: string;
  total: number;
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled';
  date: string;
  shippingDeadline: string; // YYYY-MM-DD
  amazonStatus: 'pending' | 'purchased';
  amazonPurchasePrice?: number;
  amazonAsin: string;
  amazonMarketplace: 'US' | 'MX'; // New field to determine link
}

export interface User {
  name: string;
  email: string;
  level: string; // e.g., "Mercado Líder"
  avatarUrl: string;
}

export interface DashboardStats {
  questionsUnanswered: number;
  messagesUnread: number;
  salesToday: number;
  incomeToday: number;
  questionsToday: number;
  avgTicket: number;
}