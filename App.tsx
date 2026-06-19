import React, { useState, useEffect } from 'react';
import { supabase } from './services/supabase';
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
import { UpdaterPage } from './components/UpdaterPage';
import { User } from './types';
import { getDashboardStats } from './services/mockService';
import { meliService } from './services/meliService';

const App = () => {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [meliMetrics, setMeliMetrics] = useState<any>(null);

  // Intercept OAuth popup callbacks (test user connect flow)
  useEffect(() => {
    if (!window.opener) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code) {
      window.opener.postMessage({ type: 'ml_oauth_code', code, state }, window.location.origin);
      setTimeout(() => window.close(), 200);
    }
  }, []);

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

  // Sync credentials from Supabase THEN load ML metrics
  useEffect(() => {
    if (!session?.user) return;

    const init = async () => {
      // 1. Sync credentials and settings from Supabase FIRST
      try {
        const { data: rows } = await supabase
          .from('user_connections')
          .select('*')
          .eq('user_id', session.user.id)
          .order('updated_at', { ascending: false })
          .limit(1);
        const data = rows?.[0] ?? null;

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

      // 2. NOW read localStorage (already populated) and fetch ML metrics
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

      // 3. Auto-refresh test user token on startup
      meliService.autoRefreshTestUserToken().catch(() => {});
    };

    init();

    // Re-run test user token refresh every 3 hours while app is open
    const testTokenInterval = setInterval(() => {
      meliService.autoRefreshTestUserToken().catch(() => {});
    }, 3 * 60 * 60 * 1000);

    return () => clearInterval(testTokenInterval);
  }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
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
        <Route path="/publicaciones" element={<CatalogTable />} />
        <Route path="/ordenes" element={<OrdersPage />} />
        <Route path="/actualizacion" element={<UpdaterPage />} />
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
