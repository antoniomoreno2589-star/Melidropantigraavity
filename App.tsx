import React, { useState, useEffect } from 'react';
import { supabase } from './services/supabase';
import { api } from './services/api';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './components/LoginPage';
import { RegisterPage } from './components/RegisterPage';
import { DashboardPage } from './components/DashboardPage';
import { AmazonImporter } from './components/AmazonImporter';
import { CatalogTable } from './components/CatalogTable';
import { ProfilePage } from './components/ProfilePage';
import { OrdersPage } from './components/OrdersPage';
import { SettingsPage } from './components/SettingsPage';
import { NotificationsPage } from './components/NotificationsPage';
import { CommunicationsPage } from './components/CommunicationsPage';
import { SecurityHistoryPage } from './components/SecurityHistoryPage';
import { AnalyticsPage } from './components/AnalyticsPage';
import { TestProductsPage } from './components/TestProductsPage';
import { Product, User } from './types';
import { getDashboardStats } from './services/mockService';
import { meliService } from './services/meliService';
import { amazonService } from './services/amazonService';

const App = () => {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [meliMetrics, setMeliMetrics] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        setUser({
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Usuario',
          email: session.user.email || '',
          level: 'Vendedor',
          avatarUrl: session.user.user_metadata?.avatar_url || 'https://ui-avatars.com/api/?name=User'
        });
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        setUser({
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Usuario',
          email: session.user.email || '',
          level: 'Vendedor',
          avatarUrl: session.user.user_metadata?.avatar_url || 'https://ui-avatars.com/api/?name=User'
        });
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Sync from Supabase THEN load ML metrics sequentially (fixes mobile sync issue)
  useEffect(() => {
    if (!session?.user) return;

    const init = async () => {
      // 1. Load products in parallel (doesn't depend on credentials)
      api.products.list().then(setProducts).catch(err => console.error('Error fetching products:', err));

      // 2. Sync credentials and settings from Supabase FIRST
      try {
        const { data } = await supabase
          .from('user_connections')
          .select('*')
          .eq('user_id', session.user.id)
          .single();

        if (data) {
          console.log('App: Sincronizando configuraciones desde la nube...');
          if (data.meli_credentials) {
            localStorage.setItem('melidrop_meli_credentials', JSON.stringify(data.meli_credentials));
            const c = data.meli_credentials;
            if (c.nickname) setUser(prev => prev ? ({ ...prev, name: c.nickname }) : null);
          }
          if (data.amazon_credentials) localStorage.setItem('melidrop_amazon_credentials', JSON.stringify(data.amazon_credentials));
          if (data.exchange_rate) localStorage.setItem('melidrop_exchange_rate', data.exchange_rate.toString());
          if (data.margin_rules) {
            if (data.margin_rules.usa) localStorage.setItem('melidrop_usa_rules', JSON.stringify(data.margin_rules.usa));
            if (data.margin_rules.mx) localStorage.setItem('melidrop_mx_rules', JSON.stringify(data.margin_rules.mx));
            if (data.margin_rules.filters) localStorage.setItem('melidrop_global_filters', data.margin_rules.filters);
            if (data.margin_rules.handling_time_usa != null) localStorage.setItem('melidrop_handling_time_usa', String(data.margin_rules.handling_time_usa));
            if (data.margin_rules.handling_time_mx != null) localStorage.setItem('melidrop_handling_time_mx', String(data.margin_rules.handling_time_mx));
          }
        }
      } catch (err) {
        console.error('App: Error sincronizando configuraciones:', err);
      }

      // 3. NOW read localStorage (already populated) and fetch ML metrics
      const credsRaw = localStorage.getItem('melidrop_meli_credentials');
      console.log('App: melidrop_meli_credentials present?', !!credsRaw);
      if (credsRaw) {
        try {
          const creds = JSON.parse(credsRaw);
          if (creds.nickname) setUser(prev => prev ? ({ ...prev, name: creds.nickname }) : null);
          const metrics = await meliService.getDashboardMetrics();
          setMeliMetrics(metrics);
          if (metrics.user?.nickname) {
            setUser(prev => prev ? ({
              ...prev,
              name: metrics.user.nickname,
              level: metrics.user.power_seller_status || 'Vendedor'
            }) : null);
          }
        } catch (err) {
          console.error('App: Error cargando Meli:', err);
        }
      }
    };

    init();
  }, [session]); // Only re-runs on session change, not on meliMetrics change

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const handleImportProducts = async (newProducts: Product[]) => {
    // We need to create these products in Supabase
    // This is a bulk insert. We can loop or create a bulk insert method in API.
    // For now, let's just loop sequentially to keep it simple or Promise.all
    try {
      const createdProducts = await Promise.all(
        newProducts.map(p => api.products.create(p))
      );
      setProducts(prev => [...createdProducts, ...prev]);
    } catch (e) {
      console.error("Error importing products", e);
    }
  };

  const handleUpdateProduct = async (updatedProduct: Product) => {
    try {
      await api.products.update(updatedProduct);
      setProducts(prev => prev.map(p => p.id === updatedProduct.id ? updatedProduct : p));
    } catch (e) {
      console.error("Error updating product", e);
    }
  }

  const handleBulkUpdate = async (updatedProducts: Product[]) => {
    try {
      await Promise.all(updatedProducts.map(p => api.products.update(p)));

      // Create a map for faster lookup of updated items
      const updatesMap = new Map(updatedProducts.map(p => [p.id, p]));

      setProducts(prev => prev.map(p => {
        if (updatesMap.has(p.id)) {
          return updatesMap.get(p.id)!;
        }
        return p;
      }));
    } catch (e) {
      console.error("Error bulk updating", e);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-100">Cargando...</div>;
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Layout user={user} onLogout={handleLogout} meliData={meliMetrics} stats={meliMetrics?.stats || getDashboardStats()}>
      <Routes>
        <Route path="/" element={<DashboardPage user={user} stats={meliMetrics?.stats || getDashboardStats()} meliData={meliMetrics} />} />
        <Route path="/importar" element={<AmazonImporter />} />
        <Route path="/productos-prueba" element={<TestProductsPage />} />
        <Route path="/publicaciones" element={<CatalogTable products={products} onUpdateProduct={handleUpdateProduct} onBulkUpdate={handleBulkUpdate} />} />
        <Route path="/ordenes" element={<OrdersPage />} />
        <Route path="/analitica" element={<AnalyticsPage />} />
        <Route path="/configuracion" element={<SettingsPage />} />
        <Route path="/perfil" element={<ProfilePage />} />

        {/* New Routes */}
        <Route path="/notificaciones" element={<NotificationsPage />} />
        <Route path="/mensajeria" element={<CommunicationsPage />} />
        <Route path="/historial-seguridad" element={<SecurityHistoryPage />} />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
};

export default App;