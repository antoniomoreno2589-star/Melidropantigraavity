import { Product, Order, DashboardStats } from '../types';

// Initial Mock Products
const INITIAL_PRODUCTS: Product[] = [
  {
    id: '1',
    title: 'Audífonos Inalámbricos Bluetooth con Cancelación de Ruido - Negro Mate',
    sku: 'AUD-001-BLK',
    asin: 'B08F2T91G',
    meliId: 'MLM84932019',
    priceMXN: 1450.00,
    costUSD: 45.00,
    stockProvider: 100,
    stockMeli: 15,
    status: 'active',
    imageUrl: 'https://picsum.photos/200/200?random=1',
    lastUpdated: new Date()
  },
  {
    id: '2',
    title: 'Smartwatch Deportivo Resistente al Agua IP68 con Monitor Cardíaco',
    sku: 'SW-SPORT-02',
    asin: 'B09X4Y21A',
    meliId: 'MLM77281044',
    priceMXN: 899.00,
    costUSD: 25.00,
    stockProvider: 0, // Stock alert simulation
    stockMeli: 5,
    status: 'paused',
    imageUrl: 'https://picsum.photos/200/200?random=2',
    lastUpdated: new Date()
  },
  {
    id: '3',
    title: 'Teclado Mecánico RGB 60% Switch Blue - Español',
    sku: 'KB-MECH-60',
    asin: 'B07W55DDFB',
    meliId: undefined, // Not published yet
    priceMXN: 1200.00,
    costUSD: 35.00,
    stockProvider: 50,
    stockMeli: 0,
    status: 'draft',
    imageUrl: 'https://picsum.photos/200/200?random=3',
    lastUpdated: new Date()
  }
];

const todayStr = new Date().toISOString().split('T')[0];

const MOCK_ORDERS: Order[] = [
  { 
    id: '#200019', 
    productTitle: 'Sony Headphones Wireless Noise Cancelling', 
    buyerName: 'Juan Pérez', 
    total: 5400.00, 
    status: 'pending', 
    date: todayStr,
    shippingDeadline: todayStr,
    amazonStatus: 'pending',
    amazonAsin: 'B08F2T91G',
    amazonMarketplace: 'US'
  },
  { 
    id: '#200018', 
    productTitle: 'LEGO Star Wars Millennium Falcon 75257', 
    buyerName: 'Maria Lopez', 
    total: 3500.00, 
    status: 'shipped', 
    date: '2023-10-24',
    shippingDeadline: '2023-10-25',
    amazonStatus: 'purchased',
    amazonPurchasePrice: 2150.00,
    amazonAsin: 'B07W55DDFB',
    amazonMarketplace: 'MX'
  },
  { 
    id: '#200020', 
    productTitle: 'KitchenAid Artisan Series 5-Qt. Stand Mixer', 
    buyerName: 'Roberto Gómez', 
    total: 8900.00, 
    status: 'pending', 
    date: todayStr,
    shippingDeadline: todayStr,
    amazonStatus: 'pending',
    amazonAsin: 'B00004SGF4',
    amazonMarketplace: 'US'
  }
];

export const getInitialProducts = (): Product[] => INITIAL_PRODUCTS;
export const getOrders = (): Order[] => MOCK_ORDERS;

export const generateMockProductFromASIN = (asin: string): Product => {
  const randomPrice = Math.floor(Math.random() * 2000) + 500;
  return {
    id: Math.random().toString(36).substr(2, 9),
    title: `Producto Importado Generado ${asin.substring(0, 4)}`,
    sku: `IMP-${asin.substring(0, 4)}`,
    asin: asin,
    priceMXN: randomPrice,
    costUSD: Math.floor(randomPrice / 20),
    stockProvider: Math.floor(Math.random() * 50),
    stockMeli: 0,
    status: 'draft',
    imageUrl: `https://picsum.photos/200/200?random=${Math.floor(Math.random() * 100)}`,
    lastUpdated: new Date()
  };
};

export const getDashboardStats = (): DashboardStats => ({
  questionsUnanswered: 5,
  messagesUnread: 2,
  salesToday: 12,
  incomeToday: 15400,
  questionsToday: 45,
  avgTicket: 1283
});